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
    const phone       = String(item.contact?.phone || '');
    const botId       = item.bot?.id || '';
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
        ...(phone  && { phone }),
        ...(botId  && { bot_id: botId }),
      }).eq('id', contactId);
    } else {
      await supabase.from('conversations').insert({
        id: contactId,
        contact_name: contactName,
        channel,
        last_message: text,
        last_time: ts,
        unread: 1,
        phone,
        bot_id: botId,
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

app.post('/api/conversations/:id/reply', async (req, res) => {
  try {
    const contactId = req.params.id;
    const { text } = req.body;

    if (!text?.trim()) return res.status(400).json({ error: 'text required' });

    const { data: settings } = await supabase.from('settings').select('key, value');
    const s = Object.fromEntries((settings || []).map(r => [r.key, r.value]));

    if (!s.client_id || !s.client_secret) {
      return res.status(400).json({ error: 'SendPulse credentials not configured' });
    }

    // Get OAuth token
    const tokenRes = await fetch('https://api.sendpulse.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: s.client_id, client_secret: s.client_secret }),
    });
    const { access_token } = await tokenRes.json();

    if (!access_token) return res.status(502).json({ error: 'Could not authenticate with SendPulse' });

    // Fetch conversation to get phone + bot_id stored from incoming webhook
    const { data: convData } = await supabase
      .from('conversations').select('phone, bot_id, channel').eq('id', contactId).single();

    if (!convData?.phone || !convData?.bot_id) {
      return res.status(400).json({ error: 'Cannot reply — phone or bot_id not yet stored. Send a message to this contact first.' });
    }

    // Send via SendPulse WhatsApp API
    const sendRes = await fetch('https://api.sendpulse.com/whatsapp/contacts/sendByPhone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
      body: JSON.stringify({
        bot_id: convData.bot_id,
        phone: convData.phone,
        message: { type: 'text', text: { body: text.trim() } },
      }),
    });

    if (!sendRes.ok) {
      const detail = await sendRes.text();
      console.error('[reply] SendPulse error:', detail);
      return res.status(502).json({ error: 'SendPulse API error', detail });
    }

    const ts = Date.now();

    const { data: msgData } = await supabase.from('messages').insert({
      conversation_id: contactId,
      body: text.trim(),
      direction: 'out',
      ts,
    }).select().single();

    await supabase.from('conversations').update({ last_message: text.trim(), last_time: ts }).eq('id', contactId);

    const { data: conv } = await supabase.from('conversations').select('*').eq('id', contactId).single();
    broadcast({ type: 'new_message', message: msgData, conversation: conv });

    res.json({ ok: true, message: msgData });
  } catch (err) {
    console.error('Reply error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
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
