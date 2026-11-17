const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
app.set('trust proxy', 1);
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';
const STORE_PATH = process.env.WORKSPACE_DATA_PATH || path.join(__dirname, 'data', 'store.json');
const AUTH_BASE_DIR = process.env.WA_AUTH_PATH || path.join(__dirname, '.wwebjs_auth');
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// Full CORS for Cloudflare Pages, Netlify, broadcast.tsdc.in, and localhost
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-User-Email, X-TSDC-Token');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ==========================================
// PUBLIC HEALTH & CONFIG ROUTES
// ==========================================
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'WhatsApp Broadcast Simple Server',
    engine: 'baileys-ws',
    healthEndpoint: '/api/health',
    time: new Date().toISOString()
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'WhatsApp Broadcast Simple Server',
    whatsappReady: true,
    time: new Date().toISOString()
  });
});

app.get('/api/firebase-config', (_req, res) => {
  try {
    if (process.env.FIREBASE_CONFIG_JSON) {
      return res.json(JSON.parse(process.env.FIREBASE_CONFIG_JSON));
    }
  } catch (_) {}
  res.json({});
});

// ==========================================
// AUTH & TSDC SUBSCRIPTION MIDDLEWARE
// ==========================================
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const tsdcEmail = String(req.headers['x-user-email'] || req.query.email || '').trim();
  const tsdcToken = String(req.headers['x-tsdc-token'] || '').trim();
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (bearer) {
    const parts = bearer.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload && (payload.user_id || payload.sub || payload.uid || payload.email)) {
          const tokenEmail = String(payload.email || payload.user_email || '').trim();
          req.user = {
            uid: String(payload.user_id || payload.sub || payload.uid || tokenEmail),
            email: tokenEmail || tsdcEmail,
            tokenEmail
          };
          return next();
        }
      } catch (_) {}
    }
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again via auth.tsdc.in.' });
  }

  if (tsdcEmail || tsdcToken) {
    req.user = {
      uid: tsdcEmail
        ? 'tsdc_' + Buffer.from(tsdcEmail).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)
        : 'tsdc_api_user',
      email: tsdcEmail,
      tokenEmail: ''
    };
    return next();
  }

  return res.status(401).json({ error: 'Authentication required via auth.tsdc.in' });
}

const accessCache = new Map();

async function requireBroadcastAccess(req, res, next) {
  const requestedEmail = String(req.headers['x-user-email'] || req.query.email || '').trim();
  const tokenEmail = req.user?.tokenEmail || '';

  if (tokenEmail && requestedEmail && requestedEmail.toLowerCase() !== tokenEmail.toLowerCase()) {
    return res.status(403).json({
      allowed: false,
      status: 'denied',
      code: 'EMAIL_MISMATCH',
      checkedEmail: requestedEmail,
      message: `Authenticated token email (${tokenEmail}) does not match (${requestedEmail}).`,
      salesEmail: 'sales@tsdc.in',
      appsUrl: 'https://apps.tsdc.in'
    });
  }

  const userEmail = tokenEmail || requestedEmail || req.user?.email || '';
  const apiKey = String(req.headers['x-tsdc-token'] || '').trim();
  if (!userEmail && !apiKey) {
    return res.status(401).json({ error: 'Authentication required via auth.tsdc.in' });
  }

  const cacheKey = `${userEmail.toLowerCase()}|${apiKey}`;
  const cached = accessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    req.tsdcSubscription = cached.payload;
    return next();
  }

  try {
    const params = new URLSearchParams({ serviceId: 'broadcast' });
    if (userEmail) params.set('email', userEmail);
    const headers = {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    if (apiKey) headers['X-TSDC-Token'] = apiKey;

    const checkRes = await fetch(`https://apps.tsdc.in/api/check-access?${params.toString()}`, { headers });
    const raw = await checkRes.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      return res.status(502).json({ error: 'Unexpected non-JSON response from apps.tsdc.in' });
    }

    if (!checkRes.ok || !payload.allowed) {
      accessCache.delete(cacheKey);
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

    accessCache.set(cacheKey, { payload, expiresAt: Date.now() + 30000 });
    req.tsdcSubscription = payload;
    next();
  } catch (err) {
    return res.status(503).json({ error: 'Unable to reach apps.tsdc.in for subscription check.' });
  }
}

// ==========================================
// PERSISTENT WORKSPACE STORE
// ==========================================
function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Workspace write error:', err.message);
  }
}

function workspaceKey(user) {
  return (user?.email ? String(user.email).trim().toLowerCase() : '') || String(user?.uid || 'default');
}

app.post('/api/auth/firebase-token', authMiddleware, requireBroadcastAccess, (_req, res) => {
  res.json({ ok: false, reason: 'custom_token_unavailable' });
});

app.get('/api/workspace', authMiddleware, requireBroadcastAccess, (req, res) => {
  const store = readStore();
  const ws = store.tsdcWorkspaces?.[workspaceKey(req.user)] || {
    profile: { name: req.user.email ? req.user.email.split('@')[0] : 'TSDC User', company: '' },
    lists: [],
    contacts: [],
    campaigns: [],
    reports: [],
    updatedAt: null
  };
  res.json(ws);
});

app.put('/api/workspace', authMiddleware, requireBroadcastAccess, (req, res) => {
  const store = readStore();
  store.tsdcWorkspaces = store.tsdcWorkspaces || {};
  const key = workspaceKey(req.user);
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
  writeStore(store);
  res.json({ ok: true, updatedAt: updated.updatedAt });
});

// ==========================================
// HELPERS (CSV & SANITIZATION)
// ==========================================
const cleanPhone = (v) => String(v ?? '').replace(/\D/g, '');
const safeText = (v, max = 4000) => String(v ?? '').slice(0, max);

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

function readMultipartCsv(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 25 * 1024 * 1024) return reject(new Error('File too large'));
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      const match = ct.match(/boundary=([^\s;]+)/i);
      if (!match) return resolve(buf.toString('utf8'));
      const boundary = match[1].replace(/^"|"$/g, '');
      const raw = buf.toString('utf8');
      const parts = raw.split(`--${boundary}`);
      for (const part of parts) {
        if (!/filename=/i.test(part)) continue;
        const idx = part.indexOf('\r\n\r\n');
        if (idx === -1) continue;
        return resolve(part.slice(idx + 4).replace(/\r\n$/, ''));
      }
      resolve('');
    });
  });
}

// ==========================================
// WHATSAPP CLIENT (BAILEYS — NO CHROMIUM)
// ==========================================
const userSockets = new Map();
const userStates = new Map();
const userBusy = new Map();
const manualStops = new Set();

function getWaState(uid) {
  if (!userStates.has(uid)) {
    userStates.set(uid, {
      status: 'disconnected',
      qrDataUrl: null,
      message: 'WhatsApp session disconnected. Click "Start Pairing" to generate a QR code.',
      connectedPhone: null,
      lastSync: null
    });
  }
  return userStates.get(uid);
}

function safeUserDir(uid) {
  return path.join(AUTH_BASE_DIR, String(uid).replace(/[^a-zA-Z0-9_-]/g, '_'));
}

async function startUserWhatsApp(userId) {
  const state = getWaState(userId);
  manualStops.delete(userId);

  const prev = userSockets.get(userId);
  if (prev) {
    try { prev.ev.removeAllListeners(); } catch (_) {}
    try { prev.end(); } catch (_) {}
    userSockets.delete(userId);
  }

  state.status = 'starting';
  state.qrDataUrl = null;
  state.message = 'Connecting to WhatsApp Web…';
  state.lastSync = new Date().toISOString();

  try {
    const authDir = safeUserDir(userId);
    fs.mkdirSync(authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const fallbackVersion = { version: [2, 3000, 1043857760] };
    const { version } = await Promise.race([
      fetchLatestBaileysVersion().catch(() => fallbackVersion),
      new Promise(r => setTimeout(() => r(fallbackVersion), 5000))
    ]);

    const sock = makeWASocket({
      version,
      auth: authState,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    userSockets.set(userId, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (userSockets.get(userId) !== sock) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          state.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
          state.status = 'qr';
          state.message = 'Scan the QR code in WhatsApp → Linked Devices.';
          state.lastSync = new Date().toISOString();
        } catch (err) {
          console.error('QR generation failed:', err.message);
        }
      }

      if (connection === 'connecting') {
        state.status = 'connecting';
        state.qrDataUrl = null;
        state.message = 'Authenticating WhatsApp session…';
        state.lastSync = new Date().toISOString();
      }

      if (connection === 'open') {
        state.status = 'connected';
        state.qrDataUrl = null;
        state.connectedPhone = (sock.user?.id || '').split(':')[0].split('@')[0] || 'Linked Account';
        state.message = `Connected as ${state.connectedPhone}`;
        state.lastSync = new Date().toISOString();
      }

      if (connection === 'close') {
        userSockets.delete(userId);
        if (manualStops.has(userId)) {
          manualStops.delete(userId);
          return;
        }
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.restartRequired) {
          return startUserWhatsApp(userId);
        }
        if (statusCode === DisconnectReason.loggedOut) {
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
          state.status = 'disconnected';
          state.qrDataUrl = null;
          state.connectedPhone = null;
          state.message = 'WhatsApp logged out. Click Start Pairing to link again.';
          state.lastSync = new Date().toISOString();
          return;
        }
        state.status = 'disconnected';
        state.qrDataUrl = null;
        state.connectedPhone = null;
        state.message = `Connection closed (${statusCode || 'network'}). Click Start Pairing to retry.`;
        state.lastSync = new Date().toISOString();
      }
    });
  } catch (err) {
    state.status = 'error';
    state.message = `Failed to initialize WhatsApp: ${safeText(err.message, 200)}`;
    state.lastSync = new Date().toISOString();
  }
}

// ==========================================
// WHATSAPP API ROUTES
// ==========================================
app.get('/api/status', authMiddleware, requireBroadcastAccess, (req, res) => {
  const s = getWaState(req.user.uid);
  res.json({
    status: s.status,
    qrDataUrl: s.qrDataUrl,
    message: s.message,
    connected: s.status === 'connected',
    connectedPhone: s.connectedPhone,
    lastSync: s.lastSync,
    userId: req.user.uid
  });
});

app.post('/api/whatsapp/connect', authMiddleware, requireBroadcastAccess, (req, res) => {
  startUserWhatsApp(req.user.uid);
  res.json({ ok: true, message: 'WhatsApp pairing started. Waiting for QR code…' });
});

app.post('/api/whatsapp/disconnect', authMiddleware, requireBroadcastAccess, async (req, res) => {
  const uid = req.user.uid;
  manualStops.add(uid);
  const sock = userSockets.get(uid);
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    try { sock.end(); } catch (_) {}
    userSockets.delete(uid);
  }
  try { fs.rmSync(safeUserDir(uid), { recursive: true, force: true }); } catch (_) {}
  const s = getWaState(uid);
  s.status = 'disconnected';
  s.qrDataUrl = null;
  s.connectedPhone = null;
  s.message = 'Session disconnected by user.';
  s.lastSync = new Date().toISOString();
  res.json({ ok: true });
});

app.post('/api/contacts/parse-csv', authMiddleware, requireBroadcastAccess, async (req, res) => {
  try {
    const csvText = (req.body && typeof req.body.csv === 'string')
      ? req.body.csv
      : await readMultipartCsv(req);
    const rows = parseCsv(String(csvText || '').replace(/^\uFEFF/, ''));
    if (!rows.length) return res.status(400).json({ error: 'The CSV file was empty or invalid.' });

    const seen = new Set();
    const contacts = [];
    rows.forEach((r, i) => {
      const k = {};
      for (const [col, val] of Object.entries(r)) {
        k[String(col).trim().toLowerCase().replace(/[\s_-]+/g, '')] = val;
      }
      const name = safeText(k.name || k.fullname || k.contactname || k.customer || `Contact ${i + 1}`, 150).trim();
      const phone = cleanPhone(k.phone || k.phonenumber || k.mobile || k.whatsapp || k.number || '');
      const consent = String(k.optedin ?? k.consent ?? k.whatsappconsent ?? k.permission ?? '').trim().toLowerCase();
      const optedIn = ['yes', 'y', 'true', '1', 'opted-in', 'optedin', 'consented'].includes(consent);
      if (phone && !seen.has(phone)) {
        seen.add(phone);
        contacts.push({ id: `c_${Date.now()}_${i}_${phone}`, ownerId: req.user.uid, name, phone, optedIn, createdAt: new Date().toISOString() });
      }
    });

    res.json({ contacts, count: contacts.length, unverified: contacts.filter(c => !c.optedIn).length });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to parse CSV.' });
  }
});

app.post('/api/send', authMiddleware, requireBroadcastAccess, async (req, res) => {
  const uid = req.user.uid;
  const state = getWaState(uid);
  const sock = userSockets.get(uid);

  if (userBusy.get(uid)) return res.status(409).json({ error: 'A broadcast is already running.' });
  if (state.status !== 'connected' || !sock) {
    return res.status(409).json({ error: 'WhatsApp is not connected. Please scan the QR code first.' });
  }

  const { contacts, message, confirmed, media } = req.body || {};
  if (!confirmed) return res.status(400).json({ error: 'Consent confirmation is required.' });
  if (!Array.isArray(contacts) || contacts.length === 0 || contacts.length > 250) {
    return res.status(400).json({ error: 'Select between 1 and 250 contacts per batch.' });
  }

  const cleanMsg = typeof message === 'string' ? message.trim() : '';
  if (!cleanMsg && !media) return res.status(400).json({ error: 'Provide a message or attach media.' });

  const unique = new Set();
  for (const c of contacts) {
    const phone = cleanPhone(c.phone);
    if (phone.length < 8 || phone.length > 15 || unique.has(phone)) {
      return res.status(400).json({ error: 'Invalid or duplicate phone number detected.' });
    }
    unique.add(phone);
  }

  userBusy.set(uid, true);
  res.json({ accepted: true, count: contacts.length, hasMedia: Boolean(media), note: 'Broadcast batch accepted.' });

  const mediaBuf = media?.base64 ? Buffer.from(media.base64, 'base64') : null;

  (async () => {
    try {
      for (const c of contacts) {
        const phone = cleanPhone(c.phone);
        const name = safeText(c.name || 'there', 150);
        const text = cleanMsg.replace(/\{\{\s*name\s*\}\}/gi, name);
        try {
          const results = await sock.onWhatsApp(phone);
          const match = Array.isArray(results) ? results.find(r => r.exists) : null;
          const jid = match?.jid || `${phone}@s.whatsapp.net`;

          if (mediaBuf && media?.mimetype) {
            if (media.mimetype.startsWith('image/')) {
              await sock.sendMessage(jid, { image: mediaBuf, caption: text });
            } else if (media.mimetype.startsWith('video/')) {
              await sock.sendMessage(jid, { video: mediaBuf, caption: text });
            } else {
              await sock.sendMessage(jid, {
                document: mediaBuf,
                mimetype: media.mimetype,
                fileName: media.filename || 'attachment.pdf',
                caption: text
              });
            }
          } else {
            await sock.sendMessage(jid, { text });
          }
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          console.error(`Send failed for ${phone}:`, err.message);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } finally {
      userBusy.set(uid, false);
    }
  })();
});

app.listen(PORT, HOST, () => {
  console.log(`WhatsApp Broadcast Simple Server listening on http://${HOST}:${PORT}`);
});
