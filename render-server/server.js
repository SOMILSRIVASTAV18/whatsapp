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
  const { getApps, initializeApp, getApp, cert } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const apps = getApps();
  if (!apps.length) {
    let serviceAccount = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      } catch (e) {
        console.warn('Invalid FIREBASE_SERVICE_ACCOUNT_JSON env var:', e.message);
      }
    }
    if (serviceAccount) {
      appAdmin = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || firebaseConfig.projectId
      });
    } else if (firebaseConfig.projectId) {
      appAdmin = initializeApp({ projectId: firebaseConfig.projectId });
    } else {
      appAdmin = initializeApp();
    }
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

// Persistent workspace store (data/store.json)
const STORE_PATH = process.env.WORKSPACE_DATA_PATH || path.join(__dirname, 'data', 'store.json');
function readStoreFile() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn('Workspace store read warning:', err.message);
    return {};
  }
}

function writeStoreFile(store) {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn('Workspace store write warning:', err.message);
    return false;
  }
}

function getWorkspaceKey(user) {
  const email = user && user.email ? String(user.email).trim().toLowerCase() : '';
  return email || (user && user.uid ? String(user.uid) : 'default_workspace');
}

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
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
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
      email: decodedToken.email || String(tsdcEmail || '').trim(),
      tokenEmail: decodedToken.email || ''
    };
    next();
  } catch (err) {
    console.error('Auth verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again via auth.tsdc.in.' });
  }
}

// Short-lived positive access cache (30s) to prevent gateway rate-limiting during 6s status polling
const broadcastAccessCache = new Map();

// Express middleware for WhatsApp Broadcast (broadcast.tsdc.in)
// Enforces HTTP 403 SUBSCRIPTION_EXPIRED, SUBSCRIPTION_SUSPENDED, or NO_ACTIVE_SUBSCRIPTION
async function requireBroadcastAccess(req, res, next) {
  const headerOrQueryEmail = req.headers['x-user-email'] || req.query.email;
  const tokenEmail = req.user && req.user.tokenEmail ? String(req.user.tokenEmail).trim() : '';

  if (tokenEmail && headerOrQueryEmail && String(headerOrQueryEmail).trim().toLowerCase() !== tokenEmail.toLowerCase()) {
    return res.status(403).json({
      allowed: false,
      status: 'denied',
      code: 'EMAIL_MISMATCH',
      checkedEmail: String(headerOrQueryEmail).trim(),
      message: `Authenticated token email (${tokenEmail}) does not match the requested user email (${String(headerOrQueryEmail).trim()}).`,
      salesEmail: 'sales@tsdc.in',
      appsUrl: 'https://apps.tsdc.in'
    });
  }

  const userEmail = String(tokenEmail || headerOrQueryEmail || (req.user && req.user.email) || '').trim();
  const apiKey = req.headers['x-tsdc-token'];

  if (!userEmail && !apiKey) {
    return res.status(401).json({ error: 'Authentication required via auth.tsdc.in' });
  }

  const cacheKey = `${userEmail.toLowerCase()}|${apiKey ? String(apiKey) : ''}`;
  const cached = broadcastAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    req.tsdcSubscription = cached.payload;
    return next();
  }

  try {
    const params = new URLSearchParams({ serviceId: 'broadcast' });
    if (userEmail) params.set('email', userEmail);

    const checkHeaders = {
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    if (apiKey) {
      checkHeaders['X-TSDC-Token'] = String(apiKey);
    }

    const checkRes = await fetch(`https://apps.tsdc.in/api/check-access?${params.toString()}`, {
      headers: checkHeaders
    });

    const rawText = await checkRes.text();
    let payload = null;
    try {
      payload = JSON.parse(rawText);
    } catch (_) {
      console.error(`TSDC check-access returned non-JSON (HTTP ${checkRes.status}):`, rawText.slice(0, 300));
      return res.status(502).json({
        error: 'Unable to verify Broadcast subscription with apps.tsdc.in (unexpected gateway response).',
        upstreamStatus: checkRes.status
      });
    }

    if (!checkRes.ok || !payload.allowed) {
      broadcastAccessCache.delete(cacheKey);
      return res.status(403).json({
        allowed: false,
        status: payload.status || 'denied',
        code: payload.code || 'NO_ACTIVE_SUBSCRIPTION',
        checkedEmail: userEmail || payload.userEmail || '',
        message: payload.message || 'No active subscription found for Broadcast.',
        salesEmail: payload.salesEmail || 'sales@tsdc.in',
        appsUrl: payload.subscribeUrl || 'https://apps.tsdc.in'
      });
    }

    broadcastAccessCache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + 30000
    });

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

// Optional Firebase Custom Token bridge for SSO users (when service account signing is configured)
app.post('/api/auth/firebase-token', authMiddleware, requireBroadcastAccess, async (req, res) => {
  if (!authAdmin) {
    return res.json({ ok: false, reason: 'firebase_admin_unavailable' });
  }
  try {
    const cleanUid = String(req.user.uid || getWorkspaceKey(req.user))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 128);
    const customToken = await authAdmin.createCustomToken(cleanUid, {
      email: req.user.email || undefined,
      tsdcSso: true
    });
    return res.json({ ok: true, customToken, uid: cleanUid });
  } catch (err) {
    return res.json({ ok: false, reason: 'custom_token_unavailable' });
  }
});

// Per-user persistent workspace endpoints (fallback/mirror for TSDC SSO users without Firebase custom tokens)
app.get('/api/workspace', authMiddleware, requireBroadcastAccess, (req, res) => {
  const store = readStoreFile();
  const workspaces = (store && typeof store.tsdcWorkspaces === 'object' && store.tsdcWorkspaces) || {};
  const key = getWorkspaceKey(req.user);
  const ws = workspaces[key] || {
    profile: {
      name: (req.user.email ? req.user.email.split('@')[0] : 'TSDC User'),
      company: ''
    },
    lists: [],
    contacts: [],
    campaigns: [],
    reports: [],
    updatedAt: null
  };
  res.json(ws);
});

app.put('/api/workspace', authMiddleware, requireBroadcastAccess, (req, res) => {
  const store = readStoreFile();
  if (!store.tsdcWorkspaces || typeof store.tsdcWorkspaces !== 'object') {
    store.tsdcWorkspaces = {};
  }
  const key = getWorkspaceKey(req.user);
  const existing = store.tsdcWorkspaces[key] || {};
  const body = req.body || {};

  const updated = {
    profile: body.profile && typeof body.profile === 'object' ? body.profile : (existing.profile || { name: '', company: '' }),
    lists: Array.isArray(body.lists) ? body.lists : (existing.lists || []),
    contacts: Array.isArray(body.contacts) ? body.contacts : (existing.contacts || []),
    campaigns: Array.isArray(body.campaigns) ? body.campaigns : (existing.campaigns || []),
    reports: Array.isArray(body.reports) ? body.reports : (existing.reports || []),
    updatedAt: new Date().toISOString()
  };

  store.tsdcWorkspaces[key] = updated;
  writeStoreFile(store);
  res.json({ ok: true, updatedAt: updated.updatedAt });
});

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
