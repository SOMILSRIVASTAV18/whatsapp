const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
app.get('/', (req, res) => {
  const info = {
    status: 'ok',
    server: 'WhatsApp Broadcast Simple Server',
    engine: 'baileys-ws',
    healthEndpoint: '/api/health',
    time: new Date().toISOString()
  };
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/html') && req.query.format !== 'json') {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const selfUrl = host ? `${proto}://${host}` : '';
    const dashUrl = selfUrl
      ? `https://broadcast.tsdc.in/?backend=${encodeURIComponent(selfUrl)}`
      : 'https://broadcast.tsdc.in';
    return res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp Broadcast Backend</title></head><body style="font-family:system-ui,-apple-system,sans-serif;background:#f0f2f5;color:#111b21;padding:24px;margin:0;"><div style="max-width:460px;margin:40px auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 6px 20px rgba(0,0,0,0.08);border:1px solid #e9edef;"><div style="display:inline-block;padding:4px 10px;border-radius:999px;background:#e7f7ef;color:#008069;font-size:12px;font-weight:700;margin-bottom:10px;">ONLINE • BAILEYS WS</div><h2 style="margin:0 0 8px;">WhatsApp Broadcast Backend</h2><p style="margin:0 0 18px;color:#54656f;font-size:14px;line-height:1.5;">Your Node.js backend is running. Open your dashboard connected to this server below:</p><a href="${dashUrl}" style="display:block;text-align:center;background:#008069;color:#fff;text-decoration:none;padding:12px 16px;border-radius:8px;font-weight:700;font-size:14px;">Open Broadcast Dashboard</a><p style="margin:14px 0 0;font-size:12px;color:#667781;word-break:break-all;">Backend URL: <code>${selfUrl}</code></p></div></body></html>`);
  }
  res.json(info);
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

function createFirebaseCustomTokenFromEnv(uid, claims = {}) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const sa = JSON.parse(raw);
  if (!sa || !sa.client_email || !sa.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
    claims
  })).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key, 'base64url');
  return `${header}.${payload}.${signature}`;
}

app.post('/api/auth/firebase-token', authMiddleware, requireBroadcastAccess, (req, res) => {
  try {
    const cleanUid = workspaceKey(req.user)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 128);
    const customToken = createFirebaseCustomTokenFromEnv(cleanUid, {
      email: req.user.email || undefined,
      tsdcSso: true
    });
    if (customToken) {
      return res.json({ ok: true, customToken, uid: cleanUid });
    }
  } catch (err) {
    console.warn('Custom token generation skipped:', err.message);
  }
  res.json({ ok: false, reason: 'custom_token_unavailable' });
});

app.get('/api/qr', async (req, res) => {
  const rawUrl = String(req.query.url || '').trim();
  if (!rawUrl || rawUrl.length > 1000 || !/^https?:\/\//i.test(rawUrl)) {
    return res.status(400).json({ error: 'Valid http(s) url parameter required.' });
  }
  try {
    const qrDataUrl = await QRCode.toDataURL(rawUrl, { width: 260, margin: 2 });
    return res.json({ ok: true, qrDataUrl });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate QR code.' });
  }
});

app.get('/api/workspace', authMiddleware, requireBroadcastAccess, (req, res) => {
  const store = readStore();
  const key = workspaceKey(req.user);
  const uidFallback = req.user?.uid && store.tsdcWorkspaces?.[req.user.uid];
  const ws = store.tsdcWorkspaces?.[key] || uidFallback || {
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

function getWaState(accountKey) {
  if (!userStates.has(accountKey)) {
    userStates.set(accountKey, {
      status: 'disconnected',
      qrDataUrl: null,
      message: 'WhatsApp session disconnected. Click "Start Pairing" to generate a QR code.',
      connectedPhone: null,
      lastSync: null
    });
  }
  return userStates.get(accountKey);
}

function safeUserDir(accountKey, legacyUid = null) {
  const primary = path.join(AUTH_BASE_DIR, String(accountKey).replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (fs.existsSync(path.join(primary, 'creds.json'))) return primary;
  if (legacyUid && legacyUid !== accountKey) {
    const legacy = path.join(AUTH_BASE_DIR, String(legacyUid).replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (fs.existsSync(path.join(legacy, 'creds.json'))) return legacy;
  }
  return primary;
}

async function startUserWhatsApp(accountKey, legacyUid = null) {
  const state = getWaState(accountKey);
  manualStops.delete(accountKey);

  const prev = userSockets.get(accountKey);
  if (prev) {
    try { prev.ev.removeAllListeners(); } catch (_) {}
    try { prev.end(); } catch (_) {}
    userSockets.delete(accountKey);
  }

  state.status = 'starting';
  state.qrDataUrl = null;
  state.message = 'Connecting to WhatsApp Web…';
  state.lastSync = new Date().toISOString();

  try {
    const authDir = safeUserDir(accountKey, legacyUid);
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

    userSockets.set(accountKey, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (userSockets.get(accountKey) !== sock) return;
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
        userSockets.delete(accountKey);
        if (manualStops.has(accountKey)) {
          manualStops.delete(accountKey);
          return;
        }
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.restartRequired) {
          return startUserWhatsApp(accountKey, legacyUid);
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
  const accountKey = workspaceKey(req.user);
  const s = getWaState(accountKey);
  if (
    s.status === 'disconnected'
    && !userSockets.has(accountKey)
    && !manualStops.has(accountKey)
    && fs.existsSync(path.join(safeUserDir(accountKey, req.user.uid), 'creds.json'))
  ) {
    startUserWhatsApp(accountKey, req.user.uid);
  }
  res.json({
    status: s.status,
    qrDataUrl: s.qrDataUrl,
    message: s.message,
    connected: s.status === 'connected',
    connectedPhone: s.connectedPhone,
    lastSync: s.lastSync,
    userId: accountKey
  });
});

app.post('/api/whatsapp/connect', authMiddleware, requireBroadcastAccess, (req, res) => {
  const accountKey = workspaceKey(req.user);
  startUserWhatsApp(accountKey, req.user.uid);
  res.json({ ok: true, message: 'WhatsApp pairing started. Waiting for QR code…' });
});

app.post('/api/whatsapp/disconnect', authMiddleware, requireBroadcastAccess, async (req, res) => {
  const accountKey = workspaceKey(req.user);
  manualStops.add(accountKey);
  const sock = userSockets.get(accountKey);
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    try { sock.end(); } catch (_) {}
    userSockets.delete(accountKey);
  }
  try { fs.rmSync(safeUserDir(accountKey, req.user.uid), { recursive: true, force: true }); } catch (_) {}
  const s = getWaState(accountKey);
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
  const uid = workspaceKey(req.user);
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
