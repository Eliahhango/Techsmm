const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET is not configured; tokens will reset when the server restarts.');
const TECHSMM_API = 'https://techsmm.com/api/v2';
const TECHSMM_KEY = process.env.TECHSMM_API_KEY || '';
if (!TECHSMM_KEY) console.warn('TECHSMM_API_KEY is not configured; provider requests will fail safely.');
const MARKUP_MULTIPLIER = 3; // 3x price markup for profit

// ─── Database ──────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'panel.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    balance_tzs REAL DEFAULT 0,
    language TEXT NOT NULL DEFAULT 'en',
    timezone INTEGER NOT NULL DEFAULT 10800,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    techsmm_order_id TEXT,
    service_id INTEGER NOT NULL,
    link TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    charge_tzs REAL NOT NULL,
    charge_usd REAL NOT NULL,
    status TEXT DEFAULT 'Pending',
    start_count TEXT DEFAULT '0',
    remains TEXT DEFAULT '0',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount_tzs REAL NOT NULL,
    status TEXT DEFAULT 'Pending',
    method TEXT DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS services_cache (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS exchange_rate (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rate REAL NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_user_id) REFERENCES users(id)
  );
`);

const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
if (!userColumns.includes('role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}
if (!userColumns.includes('api_key')) {
  db.exec('ALTER TABLE users ADD COLUMN api_key TEXT');
}
if (!userColumns.includes('language')) {
  db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
}
if (!userColumns.includes('timezone')) {
  db.exec('ALTER TABLE users ADD COLUMN timezone INTEGER NOT NULL DEFAULT 10800');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_api_key_unique ON users(api_key) WHERE api_key IS NOT NULL');

// ─── Middleware ─────────────────────────────────────────────
const allowedOrigins = new Set((process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(origin => origin.trim()).filter(Boolean));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  },
  credentials: true,
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      rateBuckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    next();
  };
}

app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));
app.use('/api/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.admin = user;
    next();
  });
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 128) return 'Password must be 8 to 128 characters';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return 'Password must include uppercase, lowercase, and a number';
  }
  return null;
}

function validateRegistration(username, email, password, confirmation) {
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return 'Username must be 3-30 letters, numbers, or underscores';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'A valid email address is required';
  const passwordError = validatePassword(password);
  if (passwordError) return passwordError;
  if (password !== confirmation) return 'Passwords do not match';
  return null;
}

// ─── Exchange Rate (USD → TZS) ─────────────────────────────
async function getExchangeRate() {
  // Check cache (refresh daily)
  const cached = db.prepare('SELECT * FROM exchange_rate WHERE id = 1').get();
  if (cached) {
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (age < 24 * 60 * 60 * 1000) return cached.rate;
  }

  // Fetch fresh rate from exchangerate-api
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await resp.json();
    const rate = data.rates?.TZS;
    if (rate) {
      db.prepare(`INSERT OR REPLACE INTO exchange_rate (id, rate, updated_at) VALUES (1, ?, datetime('now'))`).run(rate);
      return rate;
    }
  } catch (e) {
    console.error('Exchange rate fetch failed:', e.message);
  }

  // Fallback rate
  return cached?.rate || 2500;
}

function usdToTzs(usdPrice) {
  // This is async-aware; rate should be pre-fetched
  const cached = db.prepare('SELECT rate FROM exchange_rate WHERE id = 1').get();
  const rate = cached?.rate || 2500;
  return Math.ceil(usdPrice * rate * MARKUP_MULTIPLIER);
}

// ─── TechSMM API Helper ────────────────────────────────────
async function techsmmAPI(action, params = {}) {
  if (!TECHSMM_KEY) throw new Error('Provider API key is not configured');
  const body = new URLSearchParams({ key: TECHSMM_KEY, action, ...params });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let resp;
  try {
    resp = await fetch(TECHSMM_API, { method: 'POST', body, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) throw new Error(`Provider returned HTTP ${resp.status}`);
  return resp.json();
}

// ─── Services ──────────────────────────────────────────────
async function getServices() {
  // Check cache (refresh every 6 hours)
  const cached = db.prepare('SELECT * FROM services_cache WHERE id = 1').get();
  if (cached) {
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (age < 6 * 60 * 60 * 1000) return JSON.parse(cached.data);
  }

  const services = await techsmmAPI('services');
  if (Array.isArray(services)) {
    db.prepare(`INSERT OR REPLACE INTO services_cache (id, data, updated_at) VALUES (1, ?, datetime('now'))`)
      .run(JSON.stringify(services));
  }
  return services;
}

// Clear stale services cache on startup
db.prepare('DELETE FROM services_cache').run();

function convertServices(services) {
  const rate = db.prepare('SELECT rate FROM exchange_rate WHERE id = 1').get()?.rate || 2500;
  return services.map(s => ({
    ...s,
    rate_tzs: Math.ceil(parseFloat(s.rate) * rate * MARKUP_MULTIPLIER),
    min_tzs: Math.ceil(parseFloat(s.min || 0) * rate * MARKUP_MULTIPLIER),
    max_tzs: Math.ceil(parseFloat(s.max || 0) * rate * MARKUP_MULTIPLIER),
    rate_usd: s.rate,
    currency: 'TZS',
  }));
}

// ─── Routes ────────────────────────────────────────────────

// Auth: Register
app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const confirmation = String(req.body.password_confirmation || '');
    const validationError = validateRegistration(username, email, password, confirmation);
    if (validationError) return res.status(400).json({ error: validationError });

    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) return res.status(400).json({ error: 'User already exists' });

    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hash);

    const token = jwt.sign({ id: result.lastInsertRowid, username, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: result.lastInsertRowid, username, email, balance_tzs: 0 } });
  } catch (e) {
    console.error('Registration failed:', e.message);
    res.status(500).json({ error: 'Unable to create account' });
  }
});

// Auth: Login
app.post('/api/login', async (req, res) => {
  try {
    const identity = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!identity || !password) return res.status(400).json({ error: 'Username/email and password are required' });
    const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?').get(identity, identity);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, balance_tzs: user.balance_tzs } });
  } catch (e) {
    console.error('Login failed:', e.message);
    res.status(500).json({ error: 'Unable to sign in' });
  }
});

// Get current user
app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, email, balance_tzs, language, timezone, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

app.put('/api/account/password', authMiddleware, async (req, res) => {
  try {
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.password || '');
    const confirmation = String(req.body.confirm_password || '');
    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) return res.status(400).json({ error: 'Current password is incorrect' });
    const validationError = validatePassword(newPassword);
    if (validationError) return res.status(400).json({ error: validationError });
    if (newPassword !== confirmation) return res.status(400).json({ error: 'Passwords do not match' });
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Password change failed:', e.message);
    res.status(500).json({ error: 'Unable to change password' });
  }
});

app.put('/api/account/email', authMiddleware, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email address is required' });
    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Current password is incorrect' });
    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(email, req.user.id);
    if (existing) return res.status(409).json({ error: 'Email address is already in use' });
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    res.json({ success: true, email });
  } catch (e) {
    console.error('Email change failed:', e.message);
    res.status(500).json({ error: 'Unable to change email' });
  }
});

app.post('/api/account/api-key', authMiddleware, (req, res) => {
  try {
    const apiKey = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(apiKey, req.user.id);
    db.prepare('INSERT INTO audit_logs (actor_user_id, action, entity_type) VALUES (?, ?, ?)')
      .run(req.user.id, 'api_key.generated', 'user');
    res.json({ api_key: apiKey });
  } catch (e) {
    console.error('API key generation failed:', e.message);
    res.status(500).json({ error: 'Unable to generate API key' });
  }
});

app.delete('/api/account/api-key', authMiddleware, (req, res) => {
  try {
    db.prepare('UPDATE users SET api_key = NULL WHERE id = ?').run(req.user.id);
    db.prepare('INSERT INTO audit_logs (actor_user_id, action, entity_type) VALUES (?, ?, ?)')
      .run(req.user.id, 'api_key.revoked', 'user');
    res.json({ success: true });
  } catch (e) {
    console.error('API key revocation failed:', e.message);
    res.status(500).json({ error: 'Unable to revoke API key' });
  }
});

app.put('/api/account/preferences', authMiddleware, (req, res) => {
  try {
    const language = String(req.body.language || '').trim().toLowerCase();
    const timezone = Number(req.body.timezone);
    const supportedLanguages = new Set(['en', 'ru', 'tr', 'bp', 'ko', 'ar', 'bn']);
    if (!supportedLanguages.has(language)) return res.status(400).json({ error: 'Unsupported language' });
    if (!Number.isInteger(timezone) || timezone < -43200 || timezone > 50400 || timezone % 900 !== 0) {
      return res.status(400).json({ error: 'Invalid timezone' });
    }
    db.prepare('UPDATE users SET language = ?, timezone = ? WHERE id = ?').run(language, timezone, req.user.id);
    res.json({ success: true, language, timezone });
  } catch (e) {
    console.error('Account preferences update failed:', e.message);
    res.status(500).json({ error: 'Unable to update account preferences' });
  }
});

// Get services (with TZS conversion) - public endpoint
app.get('/api/services', async (req, res) => {
  try {
    const services = await getServices();
    if (!Array.isArray(services)) return res.status(500).json({ error: 'Failed to fetch services' });
    const converted = convertServices(services);

    // Group by category
    const categories = {};
    converted.forEach(s => {
      const cat = s.category || 'Uncategorized';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(s);
    });

    res.json({ services: converted, categories, rate: db.prepare('SELECT rate FROM exchange_rate WHERE id = 1').get()?.rate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get exchange rate
app.get('/api/exchange-rate', authMiddleware, async (req, res) => {
  const rate = await getExchangeRate();
  res.json({ rate, markup: MARKUP_MULTIPLIER, currency: 'TZS' });
});

// Search services by query string - public endpoint
app.get('/api/services/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.json({ services: [] });
    const services = await getServices();
    if (!Array.isArray(services)) return res.json({ services: [] });
    const rate = db.prepare('SELECT rate FROM exchange_rate WHERE id = 1').get()?.rate || 2500;
    const results = services
      .filter(s => (s.name || '').toLowerCase().includes(q) || String(s.service).includes(q) || (s.category || '').toLowerCase().includes(q))
      .slice(0, 50)
      .map(s => ({
        service: s.service,
        name: s.name,
        category: s.category,
        rate: s.rate,
        rate_tzs: Math.ceil(parseFloat(s.rate) * rate * MARKUP_MULTIPLIER),
        min: s.min,
        max: s.max,
        refill: s.refill,
        cancel: s.cancel,
      }));
    res.json({ services: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Deposit: create deposit request
app.post('/api/deposit', authMiddleware, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const method = String(req.body.method || 'manual').trim().toLowerCase();
    if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 100000000) {
      return res.status(400).json({ error: 'Amount must be a whole number between TSH 1,000 and TSH 100,000,000' });
    }
    if (!['manual', 'selcom'].includes(method)) return res.status(400).json({ error: 'Unsupported payment method' });
    const result = db.prepare('INSERT INTO deposits (user_id, amount_tzs, method) VALUES (?, ?, ?)').run(req.user.id, amount, method);
    res.status(201).json({ deposit_id: result.lastInsertRowid, amount_tzs: amount, method, status: 'Pending' });
  } catch (e) {
    console.error('Deposit creation failed:', e.message);
    res.status(500).json({ error: 'Unable to create deposit request' });
  }
});

// Admin: approve deposit after verified payment confirmation
app.post('/api/admin/deposit/:id/approve', adminMiddleware, (req, res) => {
  try {
    const depositId = Number(req.params.id);
    if (!positiveInteger(depositId)) return res.status(400).json({ error: 'Invalid deposit ID' });
    const approveDeposit = db.transaction(() => {
      const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
      if (!deposit) return { error: 'Deposit not found', status: 404 };
      if (deposit.status !== 'Pending') return { error: `Deposit is already ${deposit.status.toLowerCase()}`, status: 409 };
      const updated = db.prepare("UPDATE deposits SET status = 'Approved' WHERE id = ? AND status = 'Pending'").run(deposit.id);
      if (updated.changes !== 1) return { error: 'Deposit was already processed', status: 409 };
      db.prepare('UPDATE users SET balance_tzs = balance_tzs + ? WHERE id = ?').run(deposit.amount_tzs, deposit.user_id);
      db.prepare('INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id) VALUES (?, ?, ?, ?)')
        .run(req.user.id, 'deposit.approved', 'deposit', String(deposit.id));
      const user = db.prepare('SELECT balance_tzs FROM users WHERE id = ?').get(deposit.user_id);
      return { success: true, new_balance: user.balance_tzs };
    });
    const result = approveDeposit();
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (e) {
    console.error('Deposit approval failed:', e.message);
    res.status(500).json({ error: 'Unable to approve deposit' });
  }
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const users = db.prepare('SELECT id, username, email, balance_tzs, role, created_at FROM users ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ users });
});

app.get('/api/admin/orders', adminMiddleware, (req, res) => {
  const orders = db.prepare(`
    SELECT orders.*, users.username, users.email
    FROM orders JOIN users ON users.id = orders.user_id
    ORDER BY orders.created_at DESC LIMIT 100
  `).all();
  res.json({ orders });
});

app.get('/api/admin/deposits', adminMiddleware, (req, res) => {
  const deposits = db.prepare(`
    SELECT deposits.*, users.username, users.email
    FROM deposits JOIN users ON users.id = deposits.user_id
    ORDER BY deposits.created_at DESC LIMIT 100
  `).all();
  res.json({ deposits });
});

app.get('/api/admin/audit-logs', adminMiddleware, (req, res) => {
  const logs = db.prepare(`
    SELECT audit_logs.*, users.username AS actor_username
    FROM audit_logs
    LEFT JOIN users ON users.id = audit_logs.actor_user_id
    ORDER BY audit_logs.created_at DESC LIMIT 100
  `).all();
  res.json({ logs });
});

// Get deposit history
app.get('/api/deposits', authMiddleware, (req, res) => {
  const deposits = db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ deposits });
});

// Place order
app.post('/api/order', authMiddleware, async (req, res) => {
  let debitedAmount = 0;
  try {
    const serviceId = Number(req.body.service_id);
    const link = String(req.body.link || '').trim();
    const quantity = Number(req.body.quantity);
    if (!positiveInteger(serviceId) || !link || !positiveInteger(quantity)) {
      return res.status(400).json({ error: 'service_id, link, and a positive whole-number quantity are required' });
    }
    let parsedLink;
    try { parsedLink = new URL(link); } catch { return res.status(400).json({ error: 'A valid order link is required' }); }
    if (!['http:', 'https:'].includes(parsedLink.protocol)) return res.status(400).json({ error: 'Order link must use HTTP or HTTPS' });

    // Get service and calculate TZS price
    const services = await getServices();
    const service = services.find(s => Number(s.service) === serviceId);
    if (!service) return res.status(400).json({ error: 'Service not found' });

    const min = Number(service.min);
    const max = Number(service.max);
    if (Number.isFinite(min) && quantity < min || Number.isFinite(max) && quantity > max) {
      return res.status(400).json({ error: `Quantity must be between ${min} and ${max}` });
    }

    const rate = db.prepare('SELECT rate FROM exchange_rate WHERE id = 1').get()?.rate || 2500;
    const chargeUsd = (parseFloat(service.rate) / 1000) * quantity;
    const chargeTzs = Math.ceil(chargeUsd * rate * MARKUP_MULTIPLIER);
    if (!Number.isFinite(chargeTzs) || chargeTzs <= 0) return res.status(400).json({ error: 'Unable to calculate order price' });

    const debited = db.prepare('UPDATE users SET balance_tzs = balance_tzs - ? WHERE id = ? AND balance_tzs >= ?')
      .run(chargeTzs, req.user.id, chargeTzs);
    if (debited.changes !== 1) {
      const user = db.prepare('SELECT balance_tzs FROM users WHERE id = ?').get(req.user.id);
      return res.status(400).json({ error: 'Insufficient balance', required: chargeTzs, available: user?.balance_tzs || 0 });
    }
    debitedAmount = chargeTzs;

    // Place order on TechSMM
    const result = await techsmmAPI('add', {
      service: serviceId,
      link,
      quantity: String(quantity),
    });

    if (result.order) {
      const orderResult = db.prepare(
        'INSERT INTO orders (user_id, techsmm_order_id, service_id, link, quantity, charge_tzs, charge_usd, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.user.id, String(result.order), serviceId, link, quantity, chargeTzs, chargeUsd, 'Pending');
      debitedAmount = 0;

      res.json({
        order_id: orderResult.lastInsertRowid,
        techsmm_order_id: result.order,
        charge_tzs: chargeTzs,
        charge_usd: chargeUsd,
        status: 'Pending',
      });
    } else {
      // Refund on failure
      db.prepare('UPDATE users SET balance_tzs = balance_tzs + ? WHERE id = ?').run(chargeTzs, req.user.id);
      debitedAmount = 0;
      res.status(400).json({ error: 'Order failed', details: result });
    }
  } catch (e) {
    if (debitedAmount > 0) {
      db.prepare('UPDATE users SET balance_tzs = balance_tzs + ? WHERE id = ?').run(debitedAmount, req.user.id);
    }
    console.error('Order creation failed:', e.message);
    res.status(502).json({ error: 'Unable to place order. The provider did not confirm the request.' });
  }
});

// Get orders
app.get('/api/orders', authMiddleware, async (req, res) => {
  const { status: filterStatus } = req.query;
  let query = 'SELECT * FROM orders WHERE user_id = ?';
  const params = [req.user.id];

  if (filterStatus) {
    query += ' AND status = ?';
    params.push(filterStatus);
  }
  query += ' ORDER BY created_at DESC';

  const orders = db.prepare(query).all(...params);
  res.json({ orders });
});

// Refresh order status from TechSMM
app.post('/api/orders/refresh', authMiddleware, async (req, res) => {
  try {
    const pendingOrders = db.prepare(
      "SELECT * FROM orders WHERE user_id = ? AND status NOT IN ('Completed', 'Canceled', 'Partial')"
    ).all(req.user.id);

    if (pendingOrders.length === 0) return res.json({ updated: 0 });

    const orderIds = pendingOrders.map(o => o.techsmm_order_id).join(',');
    const statusResult = await techsmmAPI('status', { orders: orderIds });

    let updated = 0;
    if (typeof statusResult === 'object' && !Array.isArray(statusResult)) {
      for (const order of pendingOrders) {
        const s = statusResult[order.techsmm_order_id];
        if (s && s.status) {
          db.prepare('UPDATE orders SET status = ?, start_count = ?, remains = ? WHERE id = ?')
            .run(s.status, s.start_count || '0', s.remains || '0', order.id);
          updated++;
        }
      }
    }

    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve static frontend in production
app.use(express.static(path.join(__dirname, '../dist')));
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// ─── Start ─────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Backend running on http://localhost:${PORT}`);

  // Initialize exchange rate on startup
  await getExchangeRate();
  const rate = db.prepare('SELECT rate FROM exchange_rate WHERE id = 1').get();
  console.log(`Exchange rate: 1 USD = ${rate?.rate || 'unknown'} TZS (markup: ${MARKUP_MULTIPLIER}x)`);

  // Initialize services cache when provider credentials are configured.
  if (TECHSMM_KEY) {
    const services = await getServices();
    console.log(`Cached ${Array.isArray(services) ? services.length : 0} services`);
  } else {
    console.warn('Skipping provider service cache; configure TECHSMM_API_KEY to enable services and orders.');
  }
});
