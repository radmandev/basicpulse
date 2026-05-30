const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const supabase = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── Webhook ────────────────────────────────────────────────────────────────

const recentPayloads = [];

app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[webhook] received:', JSON.stringify(payload, null, 2));

    recentPayloads.unshift({ ts: Date.now(), payload });
    if (recentPayloads.length > 20) recentPayloads.pop();

    // SendPulse sends an array; unwrap it
    const item = Array.isArray(payload) ? payload[0] : payload;

    const contactId   = String(item.contact?.id || item.contact?.phone || item.subscriber_id || item.from || 'unknown');
    const contactName = item.contact?.name || item.subscriber?.name || 'Unknown';
    const text        = item.info?.message?.channel_data?.message?.text?.body
                     || item.message?.text
                     || item.text
                     || item.body
                     || '';
    const channel     = item.service || item.channel_type || item.channel || 'unknown';
    // SendPulse date is Unix seconds; convert to ms
    const ts          = item.date ? item.date * 1000 : Date.now();

    if (!text) {
      console.log('[webhook] skipped — no text found in payload');
      return res.status(200).json({ ok: true, skipped: true });
    }

    const { data: existing } = await supabase
      .from('conversations')
      .select('id, unread')
      .eq('id', contactId)
      .maybeSingle();

    if (existing) {
      await supabase.from('conversations').update({
        last_message: text,
        last_time: ts,
        unread: existing.unread + 1,
      }).eq('id', contactId);
    } else {
      await supabase.from('conversations').insert({
        id: contactId,
        contact_name: contactName,
        channel,
        last_message: text,
        last_time: ts,
        unread: 1,
      });
    }

    const { data: msgData } = await supabase.from('messages').insert({
      conversation_id: contactId,
      body: text,
      direction: 'in',
      ts,
    }).select().single();

    const { data: conv } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', contactId)
      .single();

    broadcast({ type: 'new_message', message: msgData, conversation: conv });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/conversations', async (_req, res) => {
  const { data } = await supabase
    .from('conversations')
    .select('*')
    .order('last_time', { ascending: false });
  res.json(data || []);
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', req.params.id)
    .order('ts', { ascending: true });

  await supabase.from('conversations').update({ unread: 0 }).eq('id', req.params.id);

  res.json(data || []);
});

app.get('/api/settings', async (_req, res) => {
  const { data } = await supabase.from('settings').select('key, value');
  const settings = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  res.json(settings);
});

app.post('/api/settings', async (req, res) => {
  const { client_id, client_secret } = req.body;
  if (client_id !== undefined) {
    await supabase.from('settings').upsert({ key: 'client_id', value: client_id }, { onConflict: 'key' });
  }
  if (client_secret !== undefined) {
    await supabase.from('settings').upsert({ key: 'client_secret', value: client_secret }, { onConflict: 'key' });
  }
  res.json({ ok: true });
});

app.get('/api/debug/webhooks', (_req, res) => res.json(recentPayloads));

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
  if (process.env.SENDPULSE_CLIENT_ID) {
    await supabase.from('settings').upsert({ key: 'client_id', value: process.env.SENDPULSE_CLIENT_ID }, { onConflict: 'key' });
  }
  if (process.env.SENDPULSE_CLIENT_SECRET) {
    await supabase.from('settings').upsert({ key: 'client_secret', value: process.env.SENDPULSE_CLIENT_SECRET }, { onConflict: 'key' });
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`BasicPulse running at http://localhost:${PORT}`);
  });
}

start();
