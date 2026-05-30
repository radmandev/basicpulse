const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Broadcast to all connected WebSocket clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ─── Webhook ────────────────────────────────────────────────────────────────

app.post('/webhook', (req, res) => {
  try {
    const payload = req.body;

    // SendPulse webhook payload shape (adapt as needed per channel)
    const contactId   = String(payload.contact?.id   || payload.subscriber_id || payload.from || 'unknown');
    const contactName = payload.contact?.name         || payload.subscriber?.name || payload.from || 'Unknown';
    const text        = payload.message?.text         || payload.text || payload.body || '';
    const channel     = payload.channel               || payload.type || 'unknown';
    const ts          = payload.timestamp
      ? new Date(payload.timestamp).getTime()
      : Date.now();

    if (!text) return res.status(200).json({ ok: true, skipped: true });

    // Upsert conversation
    const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(contactId);
    if (existing) {
      db.prepare(`
        UPDATE conversations SET last_message = ?, last_time = ?, unread = unread + 1
        WHERE id = ?
      `).run(text, ts, contactId);
    } else {
      db.prepare(`
        INSERT INTO conversations (id, contact_name, channel, last_message, last_time, unread)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(contactId, contactName, channel, text, ts);
    }

    // Insert message
    const result = db.prepare(`
      INSERT INTO messages (conversation_id, text, direction, timestamp)
      VALUES (?, ?, 'in', ?)
    `).run(contactId, text, ts);

    const newMessage = {
      id: result.lastInsertRowid,
      conversation_id: contactId,
      text,
      direction: 'in',
      timestamp: ts,
    };

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(contactId);

    broadcast({ type: 'new_message', message: newMessage, conversation: conv });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/conversations', (_req, res) => {
  const rows = db.prepare(`
    SELECT * FROM conversations ORDER BY last_time DESC
  `).all();
  res.json(rows);
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC
  `).all(req.params.id);

  // Mark as read
  db.prepare('UPDATE conversations SET unread = 0 WHERE id = ?').run(req.params.id);

  res.json(rows);
});

app.get('/api/settings', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const { client_id, client_secret } = req.body;
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  if (client_id   !== undefined) upsert.run('client_id',   client_id);
  if (client_secret !== undefined) upsert.run('client_secret', client_secret);
  res.json({ ok: true });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BasicPulse running at http://localhost:${PORT}`);
});
