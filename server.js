const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Initialize Database Tables ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      player_name TEXT NOT NULL,
      cashout NUMERIC,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS buyins (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER REFERENCES entries(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Database tables initialized');
}

// --- API Routes ---

// GET all sessions (summary view)
app.get('/api/sessions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.name, s.date, s.status, s.created_at,
        COUNT(DISTINCT e.id) AS player_count,
        COALESCE(SUM(b.amount), 0) AS total_buyins,
        COALESCE(SUM(e.cashout), 0) AS total_cashouts
      FROM sessions s
      LEFT JOIN entries e ON e.session_id = s.id
      LEFT JOIN buyins b ON b.entry_id = e.id
      GROUP BY s.id
      ORDER BY s.date DESC, s.created_at DESC
    `);
    const sessions = result.rows.map(r => ({
      id: r.id,
      name: r.name,
      date: r.date,
      status: r.status,
      playerCount: parseInt(r.player_count),
      totalBuyins: parseFloat(r.total_buyins),
      totalCashouts: parseFloat(r.total_cashouts),
    }));
    res.json(sessions);
  } catch (err) {
    console.error('GET /api/sessions error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST new session
app.post('/api/sessions', async (req, res) => {
  try {
    const name = req.body.name || 'Game Night';
    const date = req.body.date || new Date().toISOString().split('T')[0];
    const result = await pool.query(
      'INSERT INTO sessions (name, date) VALUES ($1, $2) RETURNING *',
      [name, date]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/sessions error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET single session with entries, buyins, and PnL
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const sessionRes = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id]);
    if (sessionRes.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    const session = sessionRes.rows[0];

    const entriesRes = await pool.query(
      'SELECT * FROM entries WHERE session_id = $1 ORDER BY created_at',
      [req.params.id]
    );

    const entries = [];
    for (const entry of entriesRes.rows) {
      const buyinsRes = await pool.query(
        'SELECT * FROM buyins WHERE entry_id = $1 ORDER BY created_at',
        [entry.id]
      );
      const buyins = buyinsRes.rows.map(b => ({ id: b.id, amount: parseFloat(b.amount), time: b.created_at }));
      const totalBuyin = buyins.reduce((sum, b) => sum + b.amount, 0);
      const cashout = entry.cashout !== null ? parseFloat(entry.cashout) : null;
      const pnl = cashout !== null ? cashout - totalBuyin : null;

      entries.push({
        id: entry.id,
        playerName: entry.player_name,
        buyins,
        totalBuyin,
        cashout,
        pnl,
      });
    }

    const totalBuyins = entries.reduce((s, e) => s + e.totalBuyin, 0);
    const totalCashouts = entries.reduce((s, e) => s + (e.cashout || 0), 0);
    const totalPnl = entries.filter(e => e.pnl !== null).reduce((s, e) => s + e.pnl, 0);
    const allCashedOut = entries.length > 0 && entries.every(e => e.cashout !== null);

    res.json({
      id: session.id,
      name: session.name,
      date: session.date,
      status: session.status,
      entries,
      tally: {
        totalBuyins,
        totalCashouts,
        totalPnl,
        balanced: allCashedOut && Math.abs(totalPnl) < 0.01,
      },
    });
  } catch (err) {
    console.error('GET /api/sessions/:id error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT update session (name, date, status)
app.put('/api/sessions/:id', async (req, res) => {
  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (req.body.name !== undefined) { fields.push(`name = $${idx++}`); values.push(req.body.name); }
    if (req.body.date !== undefined) { fields.push(`date = $${idx++}`); values.push(req.body.date); }
    if (req.body.status !== undefined) { fields.push(`status = $${idx++}`); values.push(req.body.status); }

    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE sessions SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/sessions/:id error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST add player entry to session
app.post('/api/sessions/:id/entries', async (req, res) => {
  try {
    const sessionRes = await pool.query('SELECT id FROM sessions WHERE id = $1', [req.params.id]);
    if (sessionRes.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const entryRes = await pool.query(
      'INSERT INTO entries (session_id, player_name) VALUES ($1, $2) RETURNING *',
      [req.params.id, req.body.playerName]
    );
    const entry = entryRes.rows[0];

    const buyin = req.body.buyin || 0;
    await pool.query(
      'INSERT INTO buyins (entry_id, amount) VALUES ($1, $2)',
      [entry.id, buyin]
    );

    res.status(201).json({ id: entry.id, playerName: entry.player_name, buyins: [{ amount: buyin }], cashout: null });
  } catch (err) {
    console.error('POST entries error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST rebuy for a player entry
app.post('/api/sessions/:sid/entries/:eid/rebuy', async (req, res) => {
  try {
    const amount = req.body.amount || 0;
    await pool.query(
      'INSERT INTO buyins (entry_id, amount) VALUES ($1, $2)',
      [req.params.eid, amount]
    );
    res.json({ success: true, amount });
  } catch (err) {
    console.error('POST rebuy error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT cashout for a player entry
app.put('/api/sessions/:sid/entries/:eid/cashout', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE entries SET cashout = $1 WHERE id = $2 RETURNING *',
      [req.body.amount, req.params.eid]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT cashout error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE player entry from session
app.delete('/api/sessions/:sid/entries/:eid', async (req, res) => {
  try {
    await pool.query('DELETE FROM entries WHERE id = $1', [req.params.eid]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE entry error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET known player names (for autocomplete)
app.get('/api/players', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT player_name FROM entries ORDER BY player_name'
    );
    res.json(result.rows.map(r => r.player_name));
  } catch (err) {
    console.error('GET players error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Start ---
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Poker Tracker running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
