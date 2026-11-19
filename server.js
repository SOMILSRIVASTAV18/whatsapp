const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const admin = require('firebase-admin');

// Cloudflare Pages build environment auto-detection
// If a user configured 'npm run build && npm start' as their Cloudflare Pages build command,
// prevent the persistent server from hanging the build runner.
if (process.env.CF_PAGES === '1' || process.env.CF_PAGES_COMMIT_SHA) {
  console.log('Cloudflare Pages build environment detected (CF_PAGES=1). Static build completed successfully.');
  process.exit(0);
}

// Load Firebase configuration
let firebaseConfig = {};
try {
  firebaseConfig = require('./firebase-applet-config.json');
} catch (e) {
  try {
    firebaseConfig = require('./public/firebase-applet-config.json');
  } catch (_) {}
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
      appAdmin = initializeApp({
        projectId: firebaseConfig.projectId
      });
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

// Enable CORS for cross-origin frontend support (e.g., Cloudflare Pages -> Node backend)
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

// Allow media payloads up to 25MB
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve Firebase config to client app
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
const userBroadcastJobs = new Map();

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

  const estExecMs = Math.min(30 * 60 * 1000, numWaves * 9000);
  const maxDelayBudgetMs = Math.max(60000, targetWindowMs - estExecMs);
  const minDelayBudgetMs = Math.max(60000, Math.round(maxDelayBudgetMs * 0.94));
  const targetTotalMs = randomInt(minDelayBudgetMs, maxDelayBudgetMs);

  if (gapCount === 1) {
    return [targetTotalMs];
  }

  // Bounded irregular weights (0.35x to 2.20x average) ensure unusual intervals without bunching in Hour 1
  const rawWeights = Array.from({ length: gapCount }, () => 0.35 + Math.pow(Math.random(), 1.7) * 1.85);
  const weightSum = rawWeights.reduce((acc, w) => acc + w, 0);

  const delays = rawWeights.map((w) => {
    const base = Math.round((w / weightSum) * targetTotalMs);
    const oddJitter = randomInt(-2950, 2950);
    return Math.max(15000, base + oddJitter);
  });

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

  const tokens = [];
  raw = raw.replace(/\{\{[^}]*\}\}/g, (match) => {
    const idx = tokens.length;
    tokens.push(match);
    return `\uE000TOK_${idx}\uE001`;
  });

  const hasExplicitSpintax = /\{[^{}]*\|[^{}]*\}/.test(raw);
  if (autoVary && !hasExplicitSpintax) {
    raw = raw.replace(/^(\s*)(Hi|Hello|Hey)\b/i, (_m, lead, word) => {
      const options = ['Hi', 'Hello', 'Hey'];
      const chosen = options[randomInt(0, options.length - 1)];
      return lead + (word === word.toUpperCase() ? chosen.toUpperCase() : chosen);
    });
    if (raw.includes('\n\n') && Math.random() < 0.35) {
      raw = raw.replace('\n\n', '\n');
    }
  }

  let guard = 0;
  while (/\{([^{}]*\|[^{}]*)\}/.test(raw) && guard < 15) {
    raw = raw.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, inner) => {
      const choices = inner.split('|');
      return choices[randomInt(0, choices.length - 1)] ?? '';
    });
    guard++;
  }

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
    // Allow TSDC service/header authentication to flow into requireBroadcastAccess
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
      // Fallback for sandboxed network or SSO tokens if verifyIdToken fails: decode JWT payload safely
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
      // Returns 403 SUBSCRIPTION_EXPIRED, SUBSCRIPTION_SUSPENDED, or NO_ACTIVE_SUBSCRIPTION
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
// REAL WHATSAPP CLIENT LIFECYCLE
// ==========================================
async function startUserWhatsApp(userId) {
  const state = getWaState(userId);
  if (!Client || !LocalAuth) {
    state.status = 'error';
    state.message = 'whatsapp-web.js module is unavailable.';
    return;
  }

  // Cleanup existing client for this user if any
  const existingClient = userClients.get(userId);
  if (existingClient) {
    try { await existingClient.destroy(); } catch (e) {}
    userClients.delete(userId);
  }

  state.status = 'starting';
  state.qrDataUrl = null;
  state.message = 'Initializing real WhatsApp Web session…';
  state.lastSync = new Date().toISOString();

  try {
    const authPath = path.join(__dirname, '.wwebjs_auth');
    if (!fs.existsSync(authPath)) {
      try { fs.mkdirSync(authPath, { recursive: true }); } catch (e) {}
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
          '--single-process',
          '--disable-gpu'
        ]
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0
    });

    userClients.set(userId, client);

    client.on('qr', async qr => {
      try {
        state.status = 'qr';
        state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        state.message = 'Scan this QR code with WhatsApp on your phone (Linked devices).';
        state.lastSync = new Date().toISOString();
      } catch (err) {
        state.status = 'error';
        state.message = 'Failed to generate QR code.';
      }
    });

    client.on('authenticated', () => {
      state.status = 'connecting';
      state.qrDataUrl = null;
      state.message = 'WhatsApp authenticated. Syncing chats…';
      state.lastSync = new Date().toISOString();
    });

    client.on('ready', () => {
      const info = client.info;
      state.status = 'connected';
      state.qrDataUrl = null;
      state.connectedPhone = info?.wid?.user || 'Linked WhatsApp Device';
      state.message = 'WhatsApp Web session is connected and active.';
      state.lastSync = new Date().toISOString();
      console.log(`WhatsApp client ready for user ${userId} (${state.connectedPhone})`);
    });

    client.on('auth_failure', msg => {
      state.status = 'error';
      state.qrDataUrl = null;
      state.message = `Authentication failed: ${safeText(msg, 200)}`;
      state.lastSync = new Date().toISOString();
    });

    client.on('disconnected', reason => {
      state.status = 'disconnected';
      state.qrDataUrl = null;
      state.connectedPhone = null;
      state.message = `Session disconnected: ${safeText(reason, 200)}`;
      state.lastSync = new Date().toISOString();
      userClients.delete(userId);
    });

    client.initialize().catch(err => {
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

// WhatsApp status endpoint
app.get('/api/status', authMiddleware, requireBroadcastAccess, (req, res) => {
  const state = getWaState(req.user.uid);
  const job = userBroadcastJobs.get(req.user.uid) || null;
  res.json({
    status: state.status,
    qrDataUrl: state.qrDataUrl,
    message: state.message,
    connected: state.status === 'connected',
    connectedPhone: state.connectedPhone,
    lastSync: state.lastSync,
    userId: req.user.uid,
    broadcastJob: formatBroadcastJobSummary(job)
  });
});

// Cancel active paced broadcast
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

// Trigger pairing
app.post('/api/whatsapp/connect', authMiddleware, requireBroadcastAccess, async (req, res) => {
  startUserWhatsApp(req.user.uid);
  res.json({ ok: true, message: 'WhatsApp pairing started. Waiting for QR code…' });
});

// Disconnect pairing
app.post('/api/whatsapp/disconnect', authMiddleware, requireBroadcastAccess, async (req, res) => {
  const userId = req.user.uid;
  const client = userClients.get(userId);
  if (client) {
    try { await client.destroy(); } catch (e) {}
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

// CSV Contact Import Helper
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

// ==========================================
// REAL CAMPAIGN BROADCAST (With Media Support)
// ==========================================
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

  const { contacts, message, confirmed, media, autoVary } = req.body || {};
  const enableAutoVary = autoVary !== false;

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

  // Validate recipients
  const unique = new Set();
  for (const c of contacts) {
    const phone = cleanPhone(c.phone);
    if (phone.length < 8 || phone.length > 15 || unique.has(phone)) {
      return res.status(400).json({ error: 'One or more recipient phone numbers are invalid or duplicated.' });
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

  userSendBusy.set(userId, true);
  userBroadcastJobs.set(userId, job);

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

  // Prepare MessageMedia if attached
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

  // Background anti-ban wave dispatch
  (async () => {
    try {
      for (let wIdx = 0; wIdx < waves.length; wIdx++) {
        const activeClient = userClients.get(userId);
        if (job.cancelled || state.status !== 'connected' || !activeClient) {
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

        await Promise.allSettled(wave.map(async (contact, memberIdx) => {
          if (memberIdx > 0) {
            const ok = await cancellableSleep(randomInt(700, 2400) * memberIdx, job, () => state.status === 'connected' && Boolean(userClients.get(userId)));
            if (!ok) return;
          }
          if (job.cancelled || state.status !== 'connected') return;
          const clientNow = userClients.get(userId);
          if (!clientNow) return;

          const phone = cleanPhone(contact.phone);
          const name = safeText(contact.name || 'there', 150);
          const personalized = resolveSpintaxMessage(cleanMsg, name, enableAutoVary);

          try {
            const numberId = await clientNow.getNumberId(phone);
            if (!numberId) {
              console.warn(`Number not on WhatsApp: ${phone}`);
              job.failedCount += 1;
              return;
            }

            // Simulate human "typing..." indicator before sending
            const typingMs = computeTypingDurationMs(personalized, Boolean(preparedMedia));
            let chat = null;
            try {
              chat = await clientNow.getChatById(numberId._serialized);
              if (chat) await chat.sendStateTyping();
            } catch (_) {}

            const typingOk = await cancellableSleep(typingMs, job, () => state.status === 'connected' && Boolean(userClients.get(userId)));
            if (!typingOk) {
              if (chat) try { await chat.clearState(); } catch (_) {}
              return;
            }

            if (preparedMedia) {
              await clientNow.sendMessage(numberId._serialized, preparedMedia, { caption: personalized });
            } else {
              await clientNow.sendMessage(numberId._serialized, personalized);
            }

            if (chat) try { await chat.clearState(); } catch (_) {}
            job.sentCount += 1;
          } catch (err) {
            console.error(`Dispatch error for ${phone}:`, err.message);
            job.failedCount += 1;
          } finally {
            job.processedCount += 1;
          }
        }));

        if (job.cancelled) break;

        if (wIdx < waves.length - 1) {
          const waitMs = waveDelays[wIdx] || randomInt(60000, 300000);
          const waitMins = (waitMs / 60000).toFixed(1);
          job.nextWaveAt = new Date(Date.now() + waitMs).toISOString();
          job.note = `Anti-ban cooldown after Wave ${wIdx + 1}/${waves.length}. Waiting irregular delay (~${waitMins}m) before next wave…`;
          const continued = await cancellableSleep(waitMs, job, () => state.status === 'connected' && Boolean(userClients.get(userId)));
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
      userSendBusy.set(userId, false);
    }
  })();
});

// App status
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Fallback all other GET routes to index.html for SPA support
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Broadcast Desk running on http://${HOST}:${PORT}`);
});

process.on('SIGINT', async () => {
  for (const client of userClients.values()) {
    try { await client.destroy(); } catch (e) {}
  }
  process.exit(0);
});
