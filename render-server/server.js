const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

// Load Firebase configuration (optional env override or local json)
let firebaseConfig = {};
try {
  firebaseConfig = require('./firebase-applet-config.json');
} catch (_) {}

if (process.env.FIREBASE_PROJECT_ID && !firebaseConfig.projectId) {
  firebaseConfig.projectId = process.env.FIREBASE_PROJECT_ID;
}

// Initialize Firebase Admin SDK (compatible with firebase-admin v14+)
let appAdmin = null;
let authAdmin = null;
try {
  const { getApps, initializeApp, getApp } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const apps = getApps();
  if (!apps.length) {
    appAdmin = firebaseConfig.projectId
      ? initializeApp({ projectId: firebaseConfig.projectId })
      : initializeApp();
  } else {
    appAdmin = getApp();
  }
  authAdmin = getAuth(appAdmin);
} catch (err) {
  console.warn('Firebase Admin init warning:', err.message);
}

let Client, LocalAuth, MessageMedia;
try {
  const wa = require('whatsapp-web.js');
  Client = wa.Client;
  LocalAuth = wa.LocalAuth;
  MessageMedia = wa.MessageMedia;
} catch (err) {
  console.error('whatsapp-web.js could not be loaded:', err.message);
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// Enable full CORS for cross-origin frontend deployments (Cloudflare Pages, broadcast.tsdc.in, localhost)
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-User-Email, X-TSDC-Token');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Root endpoint — confirms Render server is live when visited in a browser
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'WhatsApp Broadcast Render Server',
    message: 'Copy this service URL and paste it into your Broadcast Desk Backend Settings.',
    healthEndpoint: '/api/health',
    time: new Date().toISOString()
  });
});

// Public health & Firebase config endpoints
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'WhatsApp Broadcast Render Server',
    whatsappReady: Boolean(Client && LocalAuth),
    time: new Date().toISOString()
  });
});

app.get('/api/firebase-config', (_req, res) => {
  res.json(firebaseConfig);
});

// Per-user WhatsApp client instances and state
const userClients = new Map();
const userSendBusy = new Map();
const userWaStates = new Map();

function getWaState(userId) {
  if (!userWaStates.has(userId)) {
    userWaStates.set(userId, {
      status: 'disconnected',
      qrDataUrl: null,
      message: 'WhatsApp session disconnected. Click "Start Pairing" to generate a QR code.',
      connectedPhone: null,
      lastSync: null
    });
  }
  return userWaStates.get(userId);
}

// Authentication Middleware via Firebase ID Token / TSDC SSO
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const tsdcEmail = req.headers['x-user-email'] || req.query.email || '';
  const tsdcApiKey = req.headers['x-tsdc-token'] || '';
  let token = null;

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  if (!token) {
    if (tsdcEmail || tsdcApiKey) {
      const cleanEmail = String(tsdcEmail || '').trim();
      req.user = {
        uid: cleanEmail ? 'tsdc_' + Buffer.from(cleanEmail).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) : 'tsdc_api_user',
        email: cleanEmail
      };
      return next();
    }
    return res.status(401).json({ error: 'Authentication required via auth.tsdc.in' });
  }

  try {
    let decodedToken = null;
    try {
      if (authAdmin) {
        decodedToken = await authAdmin.verifyIdToken(token);
      } else {
        throw new Error('Firebase Admin Auth instance not available');
      }
    } catch (adminErr) {
      // Fallback for TSDC SSO JWT tokens
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload && (payload.user_id || payload.sub || payload.uid)) {
          decodedToken = {
            uid: payload.user_id || payload.sub || payload.uid,
            email: payload.email || payload.user_email || ''
          };
        }
      }
      if (!decodedToken) throw adminErr;
    }

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || String(tsdcEmail || '').trim()
    };
    next();
  } catch (err) {
    console.error('Auth verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again via auth.tsdc.in.' });
  }
}

// Express middleware for Broadcast (broadcast.tsdc.in)
// Enforces HTTP 403 SUBSCRIPTION_EXPIRED, SUBSCRIPTION_SUSPENDED, or NO_ACTIVE_SUBSCRIPTION
async function requireBroadcastAccess(req, res, next) {
  const userEmail = req.headers['x-user-email'] || req.query.email || (req.user && req.user.email);
  const apiKey = req.headers['x-tsdc-token'];
  const authHeader = req.headers.authorization || '';

  if (!userEmail && !apiKey) {
    return res.status(401).json({ error: 'Authentication required via auth.tsdc.in' });
  }

  try {
    const params = new URLSearchParams({ serviceId: 'broadcast' });
    if (userEmail) params.set('email', String(userEmail));

    const checkHeaders = {};
    if (apiKey) checkHeaders['X-TSDC-Token'] = String(apiKey);
    if (authHeader) checkHeaders['Authorization'] = authHeader;

    const checkRes = await fetch(`https://apps.tsdc.in/api/check-access?${params.toString()}`, {
      headers: checkHeaders
    });
    const payload = await checkRes.json().catch(() => ({}));

    if (!checkRes.ok || !payload.allowed) {
      return res.status(403).json({
        allowed: false,
        status: payload.status || 'inactive',
        code: payload.code || 'NO_ACTIVE_SUBSCRIPTION',
        message: payload.message || 'Your Broadcast subscription is expired, suspended, or inactive.',
        salesEmail: 'sales@tsdc.in',
        appsUrl: 'https://apps.tsdc.in'
      });
    }

    req.tsdcSubscription = payload;
    next();
  } catch (err) {
    console.error('Subscription check error:', err.message);
    return res.status(503).json({
      error: 'Unable to verify Broadcast subscription status with apps.tsdc.in.'
    });
  }
}

// Helpers
function safeText(v, max = 4000) {
  return String(v ?? '').slice(0, max);
}

function cleanPhone(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function normalizeContact(row, index, ownerId) {
  const keys = {};
  for (const [k, v] of Object.entries(row || {})) {
    keys[String(k).trim().toLowerCase().replace(/[\s_-]+/g, '')] = v;
  }
  const name = keys.name || keys.fullname || keys.contactname || keys.customer || `Contact ${index + 1}`;
  const phone = cleanPhone(keys.phone || keys.phonenumber || keys.mobile || keys.whatsapp || keys.number || '');
  const consent = String(keys.optedin ?? keys.consent ?? keys.whatsappconsent ?? keys.permission ?? '').trim().toLowerCase();
  const optedIn = ['yes', 'y', 'true', '1', 'opted-in', 'optedin', 'consented'].includes(consent);
  return {
    id: `c_${Date.now()}_${index}_${phone}`,
    ownerId,
    name: safeText(name, 150).trim(),
    phone,
    optedIn,
    createdAt: new Date().toISOString()
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else {
      if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(v => String(v).trim())).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

// ==========================================
// WHATSAPP CLIENT LIFECYCLE
// ==========================================
async function startUserWhatsApp(userId) {
  const state = getWaState(userId);
  if (!Client || !LocalAuth) {
    state.status = 'error';
    state.message = 'whatsapp-web.js module is unavailable.';
    return;
  }

  const existingClient = userClients.get(userId);
  if (existingClient) {
    try { await existingClient.destroy(); } catch (_) {}
    userClients.delete(userId);
  }

  state.status = 'starting';
  state.qrDataUrl = null;
  state.message = 'Initializing WhatsApp Web session on Render…';
  state.lastSync = new Date().toISOString();

  try {
    const authPath = process.env.WA_AUTH_PATH || path.join(__dirname, '.wwebjs_auth');
    if (!fs.existsSync(authPath)) {
      try { fs.mkdirSync(authPath, { recursive: true }); } catch (_) {}
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: `desk_${userId}`, dataPath: authPath }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0
    });

    userClients.set(userId, client);

    client.on('qr', async (qr) => {
      try {
        state.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
        state.status = 'qr';
        state.message = 'Scan the QR code in WhatsApp → Linked Devices.';
        state.lastSync = new Date().toISOString();
      } catch (err) {
        console.error(`QR generation failed for ${userId}:`, err.message);
      }
    });

    client.on('authenticated', () => {
      state.status = 'connecting';
      state.qrDataUrl = null;
      state.message = 'WhatsApp authenticated! Syncing device state…';
      state.lastSync = new Date().toISOString();
    });

    client.on('ready', () => {
      state.status = 'connected';
      state.qrDataUrl = null;
      state.connectedPhone = client.info?.wid?.user || 'Linked Account';
      state.message = `Connected as ${state.connectedPhone}`;
      state.lastSync = new Date().toISOString();
    });

    client.on('auth_failure', (msg) => {
      state.status = 'error';
      state.qrDataUrl = null;
      state.message = `Authentication failed: ${safeText(msg, 200)}`;
      state.lastSync = new Date().toISOString();
    });

    client.on('disconnected', (reason) => {
      state.status = 'disconnected';
      state.qrDataUrl = null;
      state.connectedPhone = null;
      state.message = `WhatsApp disconnected (${safeText(reason, 120)}). Click Start Pairing to reconnect.`;
      state.lastSync = new Date().toISOString();
      userClients.delete(userId);
    });

    client.initialize().catch((err) => {
      console.warn(`WhatsApp initialize error for user ${userId}:`, err.message);
      state.status = 'disconnected';
      state.message = `Session note: ${safeText(err.message, 250)}. Click Start Pairing to retry.`;
      state.lastSync = new Date().toISOString();
      userClients.delete(userId);
    });
  } catch (err) {
    state.status = 'error';
    state.message = `Failed to start WhatsApp: ${safeText(err.message, 200)}`;
  }
}

// Protected WhatsApp Routes
app.get('/api/status', authMiddleware, requireBroadcastAccess, (req, res) => {
  const state = getWaState(req.user.uid);
  res.json({
    status: state.status,
    qrDataUrl: state.qrDataUrl,
    message: state.message,
    connected: state.status === 'connected',
    connectedPhone: state.connectedPhone,
    lastSync: state.lastSync,
    userId: req.user.uid
  });
});

app.post('/api/whatsapp/connect', authMiddleware, requireBroadcastAccess, async (req, res) => {
  startUserWhatsApp(req.user.uid);
  res.json({ ok: true, message: 'WhatsApp pairing started. Waiting for QR code…' });
});

app.post('/api/whatsapp/disconnect', authMiddleware, requireBroadcastAccess, async (req, res) => {
  const userId = req.user.uid;
  const client = userClients.get(userId);
  if (client) {
    try { await client.destroy(); } catch (_) {}
    userClients.delete(userId);
  }
  const state = getWaState(userId);
  state.status = 'disconnected';
  state.qrDataUrl = null;
  state.connectedPhone = null;
  state.message = 'Session disconnected by user.';
  state.lastSync = new Date().toISOString();
  res.json({ ok: true });
});

app.post('/api/contacts/parse-csv', authMiddleware, requireBroadcastAccess, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose a CSV file.' });
  if (!/\.csv$/i.test(req.file.originalname)) {
    return res.status(400).json({ error: 'Please upload a CSV file (.csv).' });
  }

  const rows = parseCsv(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''));
  if (rows.length === 0) {
    return res.status(400).json({ error: 'The CSV file was empty or could not be parsed.' });
  }

  const seen = new Set();
  const contacts = [];
  for (let i = 0; i < rows.length; i++) {
    const c = normalizeContact(rows[i], i, req.user.uid);
    if (c.phone && !seen.has(c.phone)) {
      seen.add(c.phone);
      contacts.push(c);
    }
  }

  res.json({
    contacts,
    count: contacts.length,
    unverified: contacts.filter(c => !c.optedIn).length
  });
});

app.post('/api/send', authMiddleware, requireBroadcastAccess, async (req, res) => {
  const userId = req.user.uid;
  const state = getWaState(userId);
  const client = userClients.get(userId);

  if (userSendBusy.get(userId)) {
    return res.status(409).json({ error: 'A campaign broadcast is already running for your account.' });
  }

  if (state.status !== 'connected' || !client) {
    return res.status(409).json({ error: 'WhatsApp is not connected. Please scan the QR code first.' });
  }

  const { contacts, message, confirmed, media } = req.body || {};

  if (!confirmed) {
    return res.status(400).json({ error: 'Consent confirmation is required before broadcasting.' });
  }

  if (!Array.isArray(contacts) || contacts.length === 0 || contacts.length > 250) {
    return res.status(400).json({ error: 'Select between 1 and 250 contacts per batch.' });
  }

  const cleanMsg = typeof message === 'string' ? message.trim() : '';
  if (!cleanMsg && !media) {
    return res.status(400).json({ error: 'Please provide a message or attach media.' });
  }

  const unique = new Set();
  for (const c of contacts) {
    const phone = cleanPhone(c.phone);
    if (phone.length < 8 || phone.length > 15 || unique.has(phone)) {
      return res.status(400).json({ error: 'One or more recipient phone numbers are invalid or duplicated.' });
    }
    unique.add(phone);
  }

  userSendBusy.set(userId, true);
  res.json({
    accepted: true,
    count: contacts.length,
    hasMedia: Boolean(media),
    note: 'Campaign batch accepted. Messages are being dispatched sequentially.'
  });

  let preparedMedia = null;
  if (media && media.base64 && media.mimetype && MessageMedia) {
    try {
      preparedMedia = new MessageMedia(
        media.mimetype,
        media.base64,
        media.filename || (media.mimetype.startsWith('image/') ? 'image.jpg' : 'document.pdf')
      );
    } catch (e) {
      console.error('Failed to construct MessageMedia:', e);
    }
  }

  (async () => {
    try {
      for (const contact of contacts) {
        const phone = cleanPhone(contact.phone);
        const name = safeText(contact.name || 'there', 150);
        const personalized = cleanMsg.replace(/\{\{\s*name\s*\}\}/gi, name);

        try {
          const numberId = await client.getNumberId(phone);
          if (!numberId) {
            console.warn(`Number not on WhatsApp: ${phone}`);
            continue;
          }

          if (preparedMedia) {
            await client.sendMessage(numberId._serialized, preparedMedia, { caption: personalized });
          } else {
            await client.sendMessage(numberId._serialized, personalized);
          }

          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          console.error(`Dispatch error for ${phone}:`, err.message);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } finally {
      userSendBusy.set(userId, false);
    }
  })();
});

app.listen(PORT, HOST, () => {
  console.log(`WhatsApp Broadcast Render Server running on http://${HOST}:${PORT}`);
});

process.on('SIGINT', async () => {
  for (const client of userClients.values()) {
    try { await client.destroy(); } catch (_) {}
  }
  process.exit(0);
});
