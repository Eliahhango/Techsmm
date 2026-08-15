const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 4000;
const JWT_SECRET = 'techsmm-tz-secret-key-2026';
const TECHSMM_API = 'https://techsmm.com/api/v2';
const TECHSMM_KEY = '7d25b47d8b80cb60127b5f1d140ef292';
const MARKUP_MULTIPLIER = 3; // 3x price markup for profit

// ─── Database ──────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'panel.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    balance_tzs REAL DEFAULT 0,
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
`);

// ─── Middleware ─────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  const body = new URLSearchParams({ key: TECHSMM_KEY, action, ...params });
  const resp = await fetch(TECHSMM_API, { method: 'POST', body });
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
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) return res.status(400).json({ error: 'User already exists' });

    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hash);

    const token = jwt.sign({ id: result.lastInsertRowid, username, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: result.lastInsertRowid, username, email, balance_tzs: 0 } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auth: Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, balance_tzs: user.balance_tzs } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current user
app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, email, balance_tzs, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// Get services (with TZS conversion)
app.get('/api/services', authMiddleware, async (req, res) => {
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

// Deposit: create deposit request
app.post('/api/deposit', authMiddleware, (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const result = db.prepare('INSERT INTO deposits (user_id, amount_tzs) VALUES (?, ?)').run(req.user.id, amount);
    res.json({ deposit_id: result.lastInsertRowid, amount_tzs: amount, status: 'Pending' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: approve deposit (for manual testing)
app.post('/api/admin/deposit/:id/approve', authMiddleware, (req, res) => {
  try {
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(req.params.id);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    if (deposit.status === 'Approved') return res.status(400).json({ error: 'Already approved' });

    db.prepare("UPDATE deposits SET status = 'Approved' WHERE id = ?").run(deposit.id);
    db.prepare('UPDATE users SET balance_tzs = balance_tzs + ? WHERE id = ?').run(deposit.amount_tzs, deposit.user_id);

    const user = db.prepare('SELECT balance_tzs FROM users WHERE id = ?').get(deposit.user_id);
    res.json({ success: true, new_balance: user.balance_tzs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get deposit history
app.get('/api/deposits', authMiddleware, (req, res) => {
  const deposits = db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ deposits });
});

// Place order
app.post('/api/order', authMiddleware, async (req, res) => {
  try {
    const { service_id, link, quantity } = req.body;
    if (!service_id || !link || !quantity) return res.status(400).json({ error: 'service_id, link, quantity required' });

    // Get service and calculate TZS price
    const services = await getServices();
    const service = services.find(s => s.service === Number(service_id));
    if (!service) return res.status(400).json({ error: 'Service not found' });

    const rate = db.prepare('SELECT rate FROM exchange_rate WHERE id = 1').get()?.rate || 2500;
    const chargeUsd = (parseFloat(service.rate) / 1000) * Number(quantity);
    const chargeTzs = Math.ceil(chargeUsd * rate * MARKUP_MULTIPLIER);

    // Check balance
    const user = db.prepare('SELECT balance_tzs FROM users WHERE id = ?').get(req.user.id);
    if (user.balance_tzs < chargeTzs) {
      return res.status(400).json({ error: 'Insufficient balance', required: chargeTzs, available: user.balance_tzs });
    }

    // Deduct balance
    db.prepare('UPDATE users SET balance_tzs = balance_tzs - ? WHERE id = ?').run(chargeTzs, req.user.id);

    // Place order on TechSMM
    const result = await techsmmAPI('add', {
      service: service_id,
      link,
      quantity: String(quantity),
    });

    if (result.order) {
      const orderResult = db.prepare(
        'INSERT INTO orders (user_id, techsmm_order_id, service_id, link, quantity, charge_tzs, charge_usd, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.user.id, String(result.order), service_id, link, quantity, chargeTzs, chargeUsd, 'Pending');

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
      res.status(400).json({ error: 'Order failed', details: result });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
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

  // Initialize services cache
  const services = await getServices();
  console.log(`Cached ${Array.isArray(services) ? services.length : 0} services`);
});
