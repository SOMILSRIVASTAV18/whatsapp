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
const userBroadcastJobs = new Map();
const manualStops = new Set();

const MAX_CONTACTS_PER_WAVE = 5;
const MAX_PACING_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours (240 minutes)
const MAX_PACING_WINDOW_MINUTES = 240;

function randomInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function buildSafeWaves(list, maxPerWave = MAX_CONTACTS_PER_WAVE) {
  if (list.length <= 1) return list.length ? [list.slice()] : [];
  const waves = [];
  let idx = 0;

  // Ensure >= 2 waves whenever >= 2 contacts so first & last messages span the 4-hour window, never > 5 per wave
  const minWaveSize = list.length <= 5 ? 1 : 2;
  const effectiveMax = list.length <= 5 ? Math.min(2, maxPerWave) : (list.length <= 12 ? Math.min(3, maxPerWave) : maxPerWave);

  while (idx < list.length) {
    const remaining = list.length - idx;
    let size;
    if (remaining <= effectiveMax) {
      size = (waves.length === 0 && remaining >= 2 && list.length <= 5) ? 1 : remaining;
    } else {
      size = randomInt(minWaveSize, effectiveMax);
    }
    waves.push(list.slice(idx, idx + size));
    idx += size;
  }
  return waves;
}

function generateUnusualWaveDelays(numWaves, _contactCount, targetWindowMs = MAX_PACING_WINDOW_MS) {
  const gapCount = numWaves - 1;
  if (gapCount <= 0) return [];

  // Reserve estimated typing + send overhead so wall-clock time between first and last message lands ~4 hours
  const estExecMs = Math.min(30 * 60 * 1000, numWaves * 9000);
  const maxDelayBudgetMs = Math.max(60000, targetWindowMs - estExecMs);
  const minDelayBudgetMs = Math.max(60000, Math.round(maxDelayBudgetMs * 0.94));
  const targetTotalMs = randomInt(minDelayBudgetMs, maxDelayBudgetMs);

  if (gapCount === 1) {
    return [targetTotalMs];
  }

  // Bounded irregular weights (0.35x to 2.20x average) ensure unusual unpredictable intervals
  // while preventing waves from bunching in the first hour.
  const rawWeights = Array.from({ length: gapCount }, () => 0.35 + Math.pow(Math.random(), 1.7) * 1.85);
  const weightSum = rawWeights.reduce((acc, w) => acc + w, 0);

  const delays = rawWeights.map((w) => {
    const base = Math.round((w / weightSum) * targetTotalMs);
    const oddJitter = randomInt(-2950, 2950);
    return Math.max(15000, base + oddJitter);
  });

  // Normalize exact sum so last wave consistently fires ~4 hours after the first wave
  const currentSum = delays.reduce((a, b) => a + b, 0);
  if (currentSum > 0) {
    const scale = targetTotalMs / currentSum;
    for (let i = 0; i < delays.length; i++) {
      delays[i] = Math.max(12000, Math.floor(delays[i] * scale));
    }
  }
  return delays;
}

function resolveSpintaxMessage(template, recipientName, autoVary = true) {
  let raw = String(template || '');
  if (!raw) return '';

  // Protect double-brace tokens like {{name}} before parsing single-brace {a|b|c} spintax
  const tokens = [];
  raw = raw.replace(/\{\{[^}]*\}\}/g, (match) => {
    const idx = tokens.length;
    tokens.push(match);
    return `\uE000TOK_${idx}\uE001`;
  });

  const hasExplicitSpintax = /\{[^{}]*\|[^{}]*\}/.test(raw);
  if (autoVary && !hasExplicitSpintax) {
    // Automatically vary common opening greetings cleanly when user didn't add manual spintax
    raw = raw.replace(/^(\s*)(Hi|Hello|Hey)\b/i, (_m, lead, word) => {
      const options = ['Hi', 'Hello', 'Hey'];
      const chosen = options[randomInt(0, options.length - 1)];
      return lead + (word === word.toUpperCase() ? chosen.toUpperCase() : chosen);
    });
    // Subtle organic newline variance on multi-line messages so every message isn't byte-identical
    if (raw.includes('\n\n') && Math.random() < 0.35) {
      raw = raw.replace('\n\n', '\n');
    }
  }

  // Iteratively resolve nested spintax {option1|option2|...}
  let guard = 0;
  while (/\{([^{}]*\|[^{}]*)\}/.test(raw) && guard < 15) {
    raw = raw.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, inner) => {
      const choices = inner.split('|');
      return choices[randomInt(0, choices.length - 1)] ?? '';
    });
    guard++;
  }

  // Restore double-brace placeholders and inject recipient name
  raw = raw.replace(/\uE000TOK_(\d+)\uE001/g, (_m, idx) => tokens[Number(idx)] ?? '');
  return raw.replace(/\{\{\s*name\s*\}\}/gi, recipientName);
}

function computeTypingDurationMs(text, hasMedia) {
  const len = String(text || '').length;
  const estimated = 2200 + Math.min(4800, len * 32) + (hasMedia ? 900 : 0) + randomInt(-450, 1250);
  return Math.max(2500, Math.min(8500, estimated));
}

async function cancellableSleep(ms, job, canContinueFn) {
  if (ms <= 0) return !(job?.cancelled) && (!canContinueFn || canContinueFn());
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (job?.cancelled) return false;
    if (canContinueFn && !canContinueFn()) return false;
    const step = Math.min(1000, deadline - Date.now());
    if (step > 0) await new Promise((r) => setTimeout(r, step));
  }
  return !(job?.cancelled) && (!canContinueFn || canContinueFn());
}

function formatBroadcastJobSummary(job) {
  if (!job) return null;
  return {
    id: job.id,
    active: Boolean(job.active),
    status: job.status,
    totalContacts: job.totalContacts,
    processedCount: job.processedCount,
    sentCount: job.sentCount,
    failedCount: job.failedCount,
    currentWave: job.currentWave,
    totalWaves: job.totalWaves,
    currentWaveSize: job.currentWaveSize,
    maxPerWave: job.maxPerWave,
    maxSpanMinutes: job.maxSpanMinutes,
    typingSimulation: Boolean(job.typingSimulation),
    spintaxEnabled: Boolean(job.spintaxEnabled),
    nextWaveAt: job.nextWaveAt,
    estimatedEndAt: job.estimatedEndAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    note: job.note || ''
  };
}

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
  const job = userBroadcastJobs.get(req.user.uid) || null;
  res.json({
    status: s.status,
    qrDataUrl: s.qrDataUrl,
    message: s.message,
    connected: s.status === 'connected',
    connectedPhone: s.connectedPhone,
    lastSync: s.lastSync,
    userId: req.user.uid,
    broadcastJob: formatBroadcastJobSummary(job)
  });
});

app.post('/api/send/cancel', authMiddleware, requireBroadcastAccess, (req, res) => {
  const uid = req.user.uid;
  const job = userBroadcastJobs.get(uid);
  if (!job || !job.active) {
    return res.json({ ok: true, active: false, message: 'No active broadcast to cancel.' });
  }
  job.cancelled = true;
  job.status = 'cancelled';
  job.note = 'Broadcast stopped by user.';
  res.json({ ok: true, active: true, cancelled: true, message: 'Stopping broadcast after current step…' });
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

  const { contacts, message, confirmed, media, autoVary } = req.body || {};
  const enableAutoVary = autoVary !== false;
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

  const waves = buildSafeWaves(contacts, MAX_CONTACTS_PER_WAVE);
  const waveDelays = generateUnusualWaveDelays(waves.length, contacts.length, MAX_PACING_WINDOW_MS);
  const totalDelayMs = waveDelays.reduce((a, b) => a + b, 0);
  const startedAtMs = Date.now();
  const estimatedEndIso = new Date(startedAtMs + totalDelayMs + waves.length * 6000).toISOString();

  const job = {
    id: `job_${startedAtMs}_${Math.random().toString(36).slice(2, 7)}`,
    active: true,
    cancelled: false,
    status: 'running',
    totalContacts: contacts.length,
    processedCount: 0,
    sentCount: 0,
    failedCount: 0,
    currentWave: 0,
    totalWaves: waves.length,
    currentWaveSize: 0,
    maxPerWave: MAX_CONTACTS_PER_WAVE,
    maxSpanMinutes: MAX_PACING_WINDOW_MINUTES,
    typingSimulation: true,
    spintaxEnabled: true,
    startedAt: new Date(startedAtMs).toISOString(),
    nextWaveAt: null,
    estimatedEndAt: estimatedEndIso,
    finishedAt: null,
    note: `Anti-ban pacing active: max ${MAX_CONTACTS_PER_WAVE}/wave with typing simulation & spintax spread across ~4 hours.`
  };

  userBusy.set(uid, true);
  userBroadcastJobs.set(uid, job);

  res.json({
    accepted: true,
    count: contacts.length,
    hasMedia: Boolean(media),
    safetyMode: {
      maxPerWave: MAX_CONTACTS_PER_WAVE,
      maxSpanMinutes: MAX_PACING_WINDOW_MINUTES,
      totalWaves: waves.length,
      typingSimulation: true,
      spintaxEnabled: true,
      estimatedFinishAt: estimatedEndIso
    },
    note: `Anti-ban pacing active: ${waves.length} wave(s) (max ${MAX_CONTACTS_PER_WAVE}/wave), typing simulation & Spintax spread across ~4 hours.`
  });

  const mediaBuf = media?.base64 ? Buffer.from(media.base64, 'base64') : null;

  (async () => {
    try {
      for (let wIdx = 0; wIdx < waves.length; wIdx++) {
        const activeSock = userSockets.get(uid);
        if (job.cancelled || state.status !== 'connected' || !activeSock) {
          if (!job.cancelled) {
            job.status = 'aborted';
            job.note = 'Broadcast paused/aborted because WhatsApp disconnected.';
          }
          break;
        }

        const wave = waves[wIdx];
        job.currentWave = wIdx + 1;
        job.currentWaveSize = wave.length;
        job.nextWaveAt = null;
        job.note = `Simulating typing & sending Wave ${wIdx + 1} of ${waves.length} (${wave.length} recipient${wave.length > 1 ? 's' : ''}, max ${MAX_CONTACTS_PER_WAVE})…`;

        // Dispatch up to MAX_CONTACTS_PER_WAVE (5) recipients with organic stagger + simulated "typing…" presence
        await Promise.allSettled(wave.map(async (c, memberIdx) => {
          if (memberIdx > 0) {
            const ok = await cancellableSleep(randomInt(700, 2400) * memberIdx, job, () => state.status === 'connected' && Boolean(userSockets.get(uid)));
            if (!ok) return;
          }
          if (job.cancelled || state.status !== 'connected') return;
          const sockNow = userSockets.get(uid);
          if (!sockNow) return;

          const phone = cleanPhone(c.phone);
          const name = safeText(c.name || 'there', 150);
          const text = resolveSpintaxMessage(cleanMsg, name, enableAutoVary);
          try {
            const results = await sockNow.onWhatsApp(phone);
            const match = Array.isArray(results) ? results.find(r => r.exists) : null;
            const jid = match?.jid || `${phone}@s.whatsapp.net`;

            // Simulate human "typing..." indicator before sending
            const typingMs = computeTypingDurationMs(text, Boolean(mediaBuf));
            try {
              await sockNow.presenceSubscribe(jid).catch(() => {});
              await sockNow.sendPresenceUpdate('composing', jid);
            } catch (_) {}

            const typingOk = await cancellableSleep(typingMs, job, () => state.status === 'connected' && Boolean(userSockets.get(uid)));
            if (!typingOk) {
              try { await sockNow.sendPresenceUpdate('paused', jid); } catch (_) {}
              return;
            }

            if (mediaBuf && media?.mimetype) {
              if (media.mimetype.startsWith('image/')) {
                await sockNow.sendMessage(jid, { image: mediaBuf, caption: text });
              } else if (media.mimetype.startsWith('video/')) {
                await sockNow.sendMessage(jid, { video: mediaBuf, caption: text });
              } else {
                await sockNow.sendMessage(jid, {
                  document: mediaBuf,
                  mimetype: media.mimetype,
                  fileName: media.filename || 'attachment.pdf',
                  caption: text
                });
              }
            } else {
              await sockNow.sendMessage(jid, { text });
            }

            try { await sockNow.sendPresenceUpdate('paused', jid); } catch (_) {}
            job.sentCount += 1;
          } catch (err) {
            console.error(`Send failed for ${phone}:`, err.message);
            job.failedCount += 1;
          } finally {
            job.processedCount += 1;
          }
        }));

        if (job.cancelled) break;

        // Unusual irregular delay before next wave (distributed evenly enough across all 4 hours)
        if (wIdx < waves.length - 1) {
          const waitMs = waveDelays[wIdx] || randomInt(60000, 300000);
          const waitMins = (waitMs / 60000).toFixed(1);
          job.nextWaveAt = new Date(Date.now() + waitMs).toISOString();
          job.note = `Anti-ban cooldown after Wave ${wIdx + 1}/${waves.length}. Waiting irregular delay (~${waitMins}m) before next wave…`;
          const continued = await cancellableSleep(waitMs, job, () => state.status === 'connected' && Boolean(userSockets.get(uid)));
          if (!continued) {
            if (!job.cancelled) {
              job.status = 'aborted';
              job.note = 'Broadcast stopped because WhatsApp session disconnected.';
            }
            break;
          }
        }
      }

      if (job.status === 'running') {
        job.status = job.cancelled ? 'cancelled' : 'completed';
        job.note = job.cancelled
          ? `Broadcast stopped by user (${job.sentCount}/${job.totalContacts} sent).`
          : `Completed safely across ${waves.length} wave(s) over 4-hour schedule: ${job.sentCount} sent, ${job.failedCount} failed.`;
      }
    } finally {
      job.active = false;
      job.nextWaveAt = null;
      job.finishedAt = new Date().toISOString();
      userBusy.set(uid, false);
    }
  })();
});

app.listen(PORT, HOST, () => {
  console.log(`WhatsApp Broadcast Simple Server listening on http://${HOST}:${PORT}`);
});
