const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Data Layer ---
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { sessions: [], players: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// --- API Routes ---

// GET all sessions (summary view)
app.get('/api/sessions', (req, res) => {
  const data = loadData();
  const summaries = data.sessions.map(s => ({
    id: s.id,
    name: s.name,
    date: s.date,
    status: s.status,
    playerCount: s.entries.length,
    totalBuyins: s.entries.reduce((sum, e) => sum + e.buyins.reduce((bs, b) => bs + b.amount, 0), 0),
    totalCashouts: s.entries.reduce((sum, e) => sum + (e.cashout || 0), 0),
  }));
  res.json(summaries.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

// POST new session
app.post('/api/sessions', (req, res) => {
  const data = loadData();
  const session = {
    id: generateId(),
    name: req.body.name || `Game Night`,
    date: req.body.date || new Date().toISOString().split('T')[0],
    status: 'active',
    entries: [],
    createdAt: new Date().toISOString(),
  };
  data.sessions.push(session);
  saveData(data);
  res.status(201).json(session);
});

// GET single session
app.get('/api/sessions/:id', (req, res) => {
  const data = loadData();
  const session = data.sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Calculate PnL for each entry
  const enriched = {
    ...session,
    entries: session.entries.map(e => {
      const totalBuyin = e.buyins.reduce((sum, b) => sum + b.amount, 0);
      const pnl = e.cashout !== null ? e.cashout - totalBuyin : null;
      return { ...e, totalBuyin, pnl };
    }),
  };

  // Calculate session tally
  const totalBuyins = enriched.entries.reduce((s, e) => s + e.totalBuyin, 0);
  const totalCashouts = enriched.entries.reduce((s, e) => s + (e.cashout || 0), 0);
  const totalPnl = enriched.entries
    .filter(e => e.pnl !== null)
    .reduce((s, e) => s + e.pnl, 0);
  const allCashedOut = enriched.entries.length > 0 && enriched.entries.every(e => e.cashout !== null);

  enriched.tally = { totalBuyins, totalCashouts, totalPnl, balanced: allCashedOut && Math.abs(totalPnl) < 0.01 };
  res.json(enriched);
});

// PUT update session (name, date, status)
app.put('/api/sessions/:id', (req, res) => {
  const data = loadData();
  const session = data.sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (req.body.name !== undefined) session.name = req.body.name;
  if (req.body.date !== undefined) session.date = req.body.date;
  if (req.body.status !== undefined) session.status = req.body.status;
  saveData(data);
  res.json(session);
});

// POST add player entry to session
app.post('/api/sessions/:id/entries', (req, res) => {
  const data = loadData();
  const session = data.sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const entry = {
    id: generateId(),
    playerName: req.body.playerName,
    buyins: [{ amount: req.body.buyin || 0, time: new Date().toISOString() }],
    cashout: null,
  };
  session.entries.push(entry);

  // Track player name globally
  if (!data.players.includes(req.body.playerName)) {
    data.players.push(req.body.playerName);
  }

  saveData(data);
  res.status(201).json(entry);
});

// POST rebuy for a player entry
app.post('/api/sessions/:sid/entries/:eid/rebuy', (req, res) => {
  const data = loadData();
  const session = data.sessions.find(s => s.id === req.params.sid);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const entry = session.entries.find(e => e.id === req.params.eid);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  entry.buyins.push({ amount: req.body.amount || 0, time: new Date().toISOString() });
  saveData(data);
  res.json(entry);
});

// PUT cashout for a player entry
app.put('/api/sessions/:sid/entries/:eid/cashout', (req, res) => {
  const data = loadData();
  const session = data.sessions.find(s => s.id === req.params.sid);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const entry = session.entries.find(e => e.id === req.params.eid);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  entry.cashout = req.body.amount;
  saveData(data);
  res.json(entry);
});

// DELETE player entry from session
app.delete('/api/sessions/:sid/entries/:eid', (req, res) => {
  const data = loadData();
  const session = data.sessions.find(s => s.id === req.params.sid);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.entries = session.entries.filter(e => e.id !== req.params.eid);
  saveData(data);
  res.json({ success: true });
});

// GET known player names (for autocomplete)
app.get('/api/players', (req, res) => {
  const data = loadData();
  res.json(data.players);
});

app.listen(PORT, () => {
  console.log(`Poker Tracker running on http://localhost:${PORT}`);
});
