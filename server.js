const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcrypt');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const config = require('./config.json');
const PORT = process.env.PORT || config.port || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: config.session_secret || 'dev_secret',
  resave: false,
  saveUninitialized: false
}));

app.use(express.static(path.join(__dirname, 'public')));

// --- Database setup ---
const dbFile = path.join(__dirname, 'data.db');
const dbExists = fs.existsSync(dbFile);
const db = new sqlite3.Database(dbFile);

db.serialize(() => {
  if (!dbExists) {
    db.run(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT,
      role TEXT DEFAULT 'buyer'
    )`);
    db.run(`CREATE TABLE packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      price REAL,
      robux INTEGER,
      description TEXT
    )`);
    db.run(`CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      package_id INTEGER,
      price REAL,
      status TEXT DEFAULT 'pending',
      pix_copy TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      user_id INTEGER,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const bcryptSalt = 10;
    const sellerPass = bcrypt.hashSync('sellerpass', bcryptSalt);
    const buyerPass = bcrypt.hashSync('buyerpass', bcryptSalt);

    db.run('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', ['seller@store.test', sellerPass, 'seller']);
    db.run('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', ['buyer@store.test', buyerPass, 'buyer']);

    const packs = [
      ['400 Robux', 8, 400, 'Pacote 400 Robux'],
      ['1700 Robux', 15, 1700, 'Pacote 1700 Robux'],
      ['2000 Robux', 23, 2000, 'Pacote 2k Robux'],
      ['4500 Robux', 40, 4500, 'Pacote 4.5k Robux'],
      ['10000 Robux', 50, 10000, 'Pacote 10k Robux'],
      ['22500 Robux', 80, 22500, 'Pacote 22.5k Robux']
    ];
    const stmt = db.prepare('INSERT INTO packages (name, price, robux, description) VALUES (?, ?, ?, ?)');
    for (const p of packs) stmt.run(p);
    stmt.finalize();
  }
});

// --- Helpers ---
function ensureAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

// --- Auth routes ---
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'missing' });
  const hash = await bcrypt.hash(password, 10);
  db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash], function(err) {
    if (err) return res.status(400).json({ error: 'email_exists' });
    res.json({ ok: true });
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'invalid' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'invalid' });
    req.session.user = { id: user.id, email: user.email, role: user.role };
    res.json({ ok: true, user: req.session.user });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// --- Packages & orders ---
app.get('/api/packages', (req, res) => {
  db.all('SELECT * FROM packages', [], (err, rows) => res.json(rows));
});

app.post('/api/purchase', ensureAuth, (req, res) => {
  const { package_id } = req.body;
  db.get('SELECT * FROM packages WHERE id = ?', [package_id], (err, pack) => {
    if (err || !pack) return res.status(400).json({ error: 'invalid_package' });
    db.run('INSERT INTO orders (user_id, package_id, price, pix_copy) VALUES (?, ?, ?, ?)', [
      req.session.user.id,
      package_id,
      pack.price,
      `PIX_${Date.now()}_${Math.floor(Math.random()*9000)+1000}`
    ], function(err) {
      if (err) return res.status(500).json({ error: 'db' });
      const orderId = this.lastID;
      io.to('admin').emit('new_order', { orderId, package: pack.name, price: pack.price });
      res.json({ ok: true, orderId });
    });
  });
});

app.get('/api/orders', ensureAuth, (req, res) => {
  if (req.session.user.role === 'seller') {
    db.all('SELECT o.*, p.name as package_name, u.email as buyer_email FROM orders o JOIN packages p ON p.id=o.package_id JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC', [], (err, rows) => res.json(rows));
  } else {
    db.all('SELECT o.*, p.name as package_name FROM orders o JOIN packages p ON p.id=o.package_id WHERE o.user_id = ? ORDER BY o.created_at DESC', [req.session.user.id], (err, rows) => res.json(rows));
  }
});

app.post('/api/orders/:id/mark', ensureAuth, (req, res) => {
  const id = req.params.id;
  if (req.session.user.role !== 'seller') return res.status(403).json({ error: 'forbidden' });
  const { status } = req.body;
  db.run('UPDATE orders SET status = ? WHERE id = ?', [status, id], function(err) {
    if (err) return res.status(500).json({ error: 'db' });
    res.json({ ok: true });
  });
});

// --- Messages (chat per order) ---
app.get('/api/messages/:orderId', ensureAuth, (req, res) => {
  const orderId = req.params.orderId;
  db.all('SELECT m.*, u.email as author FROM messages m LEFT JOIN users u ON u.id=m.user_id WHERE order_id = ? ORDER BY created_at ASC', [orderId], (err, rows) => {
    res.json(rows);
  });
});

app.post('/api/messages/:orderId', ensureAuth, (req, res) => {
  const orderId = req.params.orderId;
  const content = req.body.content;
  db.run('INSERT INTO messages (order_id, user_id, content) VALUES (?, ?, ?)', [orderId, req.session.user.id, content], function(err) {
    if (err) return res.status(500).json({ error: 'db' });
    io.to('order_' + orderId).emit('message', { orderId, author: req.session.user.email, content, created_at: new Date() });
    res.json({ ok: true });
  });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  socket.on('join_admin', () => socket.join('admin'));
  socket.on('join_order', (orderId) => socket.join('order_' + orderId));
});

// --- Serve client ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
