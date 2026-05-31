const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const supabase = require('./db');
const {
  getBitrixConfig, saveBitrixConfig,
  registerConnector, registerEventHandlers,
  sendMessageToBitrix, callBitrix,
} = require('./bitrix');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── Bitrix24 reply polling ───────────────────────────────────────────────────
// event.bind delivery from Bitrix24 cloud → Hostinger is unreliable (network/
// firewall), so we poll im.dialog.messages.get every 8 s as a reliable fallback.

// convId → { chatId, externalUserId, lastMsgId }
const bitrixChatSessions = new Map();
const processedBitrixMsgIds = new Set(); // dedup within process lifetime

function stripBBCode(text) {
  return String(text)
    .replace(/\[b\](.*?)\[\/b\]/gi, '$1')
    .replace(/\[i\](.*?)\[\/i\]/gi, '$1')
    .replace(/\[u\](.*?)\[\/u\]/gi, '$1')
    .replace(/\[url=[^\]]*\](.*?)\[\/url\]/gi, '$1')
    .replace(/\[br\]/gi, '\n')
    .replace(/\[\/?\w+[^\]]*\]/g, '')
    .trim();
}

async function pollBitrixReplies() {
  try {
  if (!bitrixChatSessions.size) return;
  let bCfg;
  try { bCfg = await getBitrixConfig(); } catch (e) { return; }
  if (!bCfg?.bitrix_auth_token || !bCfg?.connector_active) return;

  const { data: spSettings } = await supabase.from('settings').select('key, value');
  const sp = Object.fromEntries((spSettings || []).map(r => [r.key, r.value]));
  if (!sp.client_id || !sp.client_secret) return;

  let access_token;
  try {
    const r = await fetch('https://api.sendpulse.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: sp.client_id, client_secret: sp.client_secret }),
    });
    ({ access_token } = await r.json());
  } catch (e) { return; }
  if (!access_token) return;

  for (const [convId, session] of bitrixChatSessions) {
    if (!session.chatId) continue;
    try {
      const result = await callBitrix(bCfg, 'im.dialog.messages.get', {
        DIALOG_ID: `chat${session.chatId}`,
        LIMIT: 20,
      });

      const rawMsgs = result?.messages || result?.MESSAGES || {};
      const msgs = Array.isArray(rawMsgs) ? rawMsgs : Object.values(rawMsgs);
      let newLastId = session.lastMsgId || 0;

      for (const msg of msgs) {
        const msgId = Number(msg.id || msg.ID || 0);
        if (!msgId || msgId <= (session.lastMsgId || 0)) continue;
        if (processedBitrixMsgIds.has(msgId)) continue;
        newLastId = Math.max(newLastId, msgId);

        const authorId = Number(msg.authorId || msg.AUTHOR_ID || msg.FROM_USER_ID || 0);
        // Skip messages the customer sent (forwarded by us to Bitrix24)
        if (session.externalUserId && authorId === Number(session.externalUserId)) continue;
        // Skip system / empty
        if (msg.system || msg.SYSTEM) continue;
        const text = stripBBCode(msg.text || msg.MESSAGE || '');
        if (!text) continue;

        const { data: convData } = await supabase.from('conversations').select('*').eq('id', convId).maybeSingle();
        if (!convData?.phone || !convData?.bot_id) {
          console.error('[bitrix poll] No phone/bot_id for conv', convId);
          continue;
        }

        const sendRes = await fetch('https://api.sendpulse.com/whatsapp/contacts/sendByPhone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
          body: JSON.stringify({ bot_id: convData.bot_id, phone: convData.phone, message: { type: 'text', text: { body: text } } }),
        });

        if (sendRes.ok) {
          processedBitrixMsgIds.add(msgId);
          const ts = Date.now();
          const { data: msgData } = await supabase.from('messages').insert({
            conversation_id: convId, body: text, direction: 'out', ts,
          }).select().single();
          await supabase.from('conversations').update({ last_message: text, last_time: ts }).eq('id', convId);
          const { data: conv } = await supabase.from('conversations').select('*').eq('id', convId).single();
          broadcast({ type: 'new_message', message: msgData, conversation: conv });
          console.log('[bitrix poll] Agent reply sent → phone', convData.phone, '| text:', text.slice(0, 60));
        } else {
          console.error('[bitrix poll] SendPulse error:', await sendRes.text());
        }
      }

      session.lastMsgId = newLastId;
      bitrixChatSessions.set(convId, session);

      // Prevent Set from growing unbounded
      if (processedBitrixMsgIds.size > 2000) {
        const arr = [...processedBitrixMsgIds];
        arr.slice(0, 1000).forEach(id => processedBitrixMsgIds.delete(id));
      }
    } catch (err) {
      console.error('[bitrix poll] Error for conv', convId, ':', err.message);
    }
  }
  } catch (err) {
    console.error('[bitrix poll] Outer error:', err.message);
  }
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

    // Forward to Bitrix24 Open Channel if connector is active
    try {
      const bCfg = await getBitrixConfig();
      if (bCfg?.connector_active) {
        const bxResult = await sendMessageToBitrix(bCfg, conv, text, ts);
        // Capture Bitrix24 chat ID for reply polling
        // imconnector.send.messages returns { CHAT_ID, SESSION_ID, CONTACTS: [{ID, USER_CODE}] }
        // or an object keyed by session id — handle both shapes.
        const firstVal = bxResult && typeof bxResult === 'object'
          ? (bxResult.CHAT_ID ? bxResult : Object.values(bxResult)[0])
          : null;
        const chatId      = firstVal?.CHAT_ID;
        const extUserId   = firstVal?.CONTACTS?.[0]?.ID;
        recentBitrixEvents.unshift({
          ts: new Date().toISOString(), event: 'FORWARD_OK',
          conv_id: conv.id, chatId: chatId || null,
          bxResult: JSON.stringify(bxResult).slice(0, 300),
        });
        if (recentBitrixEvents.length > 20) recentBitrixEvents.pop();

        if (chatId) {
          const existing = bitrixChatSessions.get(conv.id) || {};
          bitrixChatSessions.set(conv.id, {
            ...existing,
            chatId,
            externalUserId: extUserId || existing.externalUserId,
          });
          // Persist so sessions survive server restarts
          supabase.from('conversations')
            .update({ bitrix_chat_id: String(chatId) })
            .eq('id', conv.id)
            .then(() => {})
            .catch(() => {}); // column may not exist yet — silent
          console.log('[webhook] Tracking Bitrix24 chat', chatId, 'for conv', conv.id);
        } else {
          console.log('[webhook] imconnector result (no CHAT_ID):', JSON.stringify(bxResult).slice(0, 300));
        }
      }
    } catch (bErr) {
      console.error('[webhook] Bitrix24 forward error:', bErr.message);
      recentBitrixEvents.unshift({ ts: new Date().toISOString(), event: 'FORWARD_ERROR', error: bErr.message, conv_id: conv?.id });
      if (recentBitrixEvents.length > 20) recentBitrixEvents.pop();
    }

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

// ─── Bitrix24 ────────────────────────────────────────────────────────────────

const recentBitrixEvents = [];
app.get('/api/bitrix/event-log', (_req, res) => res.json(recentBitrixEvents));

// Capture last install request for diagnostics (like recentPayloads for webhooks)
let lastInstallRequest = null;

// Called by Bitrix24 when the local app is installed
app.all('/bitrix/install', async (req, res) => {
  const p = { ...req.query, ...req.body };

  // Capture everything for the debug endpoint
  lastInstallRequest = {
    captured_at: new Date().toISOString(),
    method:      req.method,
    content_type: req.headers['content-type'] || '',
    query:       req.query,
    body:        req.body,
    merged:      p,
  };
  console.log('[bitrix/install] captured:', JSON.stringify(lastInstallRequest));

  // Accept all known Bitrix24 param name variants
  const DOMAIN    = p.DOMAIN    || p.domain    || '';
  const AUTH_ID   = p.AUTH_ID   || p.access_token || '';
  const REFRESH_ID = p.REFRESH_ID || p.refresh_token || '';
  const AUTH_EXPIRES = p.AUTH_EXPIRES || p.expires_in || '';
  const member_id = p.member_id || p.MEMBER_ID || '';

  if (!AUTH_ID) {
    // No token received — still respond 200 so Bitrix24 doesn't error
    console.warn('[bitrix/install] No AUTH_ID received — body was:', JSON.stringify(p));
    return res.status(200).json({ status: 'success', note: 'no_token' });
  }

  // Prefer credentials already saved via Settings UI; fall back to env vars
  const existing     = await getBitrixConfig();
  const appId        = existing?.bitrix_app_id        || process.env.BITRIX_APP_ID        || '';
  const clientSecret = existing?.bitrix_client_secret || process.env.BITRIX_CLIENT_SECRET || '';
  const appUrl       = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

  const config = {
    bitrix_member_id:        member_id,
    bitrix_app_id:           appId,
    bitrix_client_secret:    clientSecret,
    bitrix_auth_token:       AUTH_ID,
    bitrix_refresh_token:    REFRESH_ID,
    bitrix_token_expires_at: new Date(Date.now() + (Number(AUTH_EXPIRES) || 3600) * 1000).toISOString(),
    bitrix_domain:           DOMAIN,
    connector_id:            'basicpulse',
    connector_active:        false,
  };

  try {
    await saveBitrixConfig(config);
    console.log('[bitrix/install] Credentials saved for', DOMAIN);
  } catch (saveErr) {
    console.error('[bitrix/install] FAILED to save:', saveErr.message);
    lastInstallRequest.save_error = saveErr.message;
    return res.status(200).json({ status: 'error', errors: { save: saveErr.message } });
  }

  // Register connector and event handlers (non-fatal)
  try {
    const saved = await getBitrixConfig();
    await registerConnector(saved, appUrl);
    await registerEventHandlers(saved, appUrl);
    console.log('[bitrix/install] Connector + events registered');
  } catch (err) {
    console.error('[bitrix/install] Post-install setup error:', err.message);
    lastInstallRequest.setup_error = err.message;
  }

  res.status(200).json({ status: 'success' });
});

// Called by Bitrix24 for all registered events
app.post('/bitrix/event', async (req, res) => {
  res.status(200).json({ ok: true }); // Acknowledge immediately

  const event = req.body?.event || req.body?.EVENT || '';
  const data  = req.body?.data  || req.body?.DATA  || {};

  // Log every event for diagnostics
  recentBitrixEvents.unshift({ ts: new Date().toISOString(), event, body: req.body });
  if (recentBitrixEvents.length > 10) recentBitrixEvents.pop();

  console.log('[bitrix/event]', event, JSON.stringify(req.body).slice(0, 500));

  try {
    if (event === 'ONIMCONNECTORMESSAGEADD') {
      // Agent replied inside Bitrix24 — forward each message to WhatsApp via SendPulse.
      // Bitrix24 sends: data.MESSAGES = [{im:{chat_id,message_id}, message:{text}, chat:{id}}]
      // chat.id is the external ID we supplied when calling imconnector.send.messages.
      const lineId   = String(data?.LINE || data?.line || '');
      const messages = data?.MESSAGES || data?.messages || [];
      if (!messages.length) {
        console.warn('[bitrix/event] ONIMCONNECTORMESSAGEADD with no MESSAGES:', JSON.stringify(data));
        return;
      }

      // Fetch SendPulse credentials once for all messages
      const { data: settings } = await supabase.from('settings').select('key, value');
      const s = Object.fromEntries((settings || []).map(r => [r.key, r.value]));
      if (!s.client_id || !s.client_secret) {
        console.error('[bitrix/event] SendPulse credentials not configured');
        return;
      }

      const tokenRes = await fetch('https://api.sendpulse.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: s.client_id, client_secret: s.client_secret }),
      });
      const { access_token } = await tokenRes.json();
      if (!access_token) {
        console.error('[bitrix/event] Could not get SendPulse token');
        return;
      }

      const bCfg = await getBitrixConfig();

      for (const msg of messages) {
        const imData  = msg?.im || {};
        const chatId  = msg?.chat?.id || '';
        const rawText = msg?.message?.text || '';
        // Strip Bitrix24 BBCode formatting before sending to WhatsApp
        const messageText = rawText
          .replace(/\[b\](.*?)\[\/b\]/gi, '$1')
          .replace(/\[i\](.*?)\[\/i\]/gi, '$1')
          .replace(/\[u\](.*?)\[\/u\]/gi, '$1')
          .replace(/\[url=[^\]]*\](.*?)\[\/url\]/gi, '$1')
          .replace(/\[br\]/gi, '\n')
          .replace(/\[\/?\w+[^\]]*\]/g, '')
          .trim();

        if (!chatId || !messageText) {
          console.warn('[bitrix/event] Skipping — missing chat.id or text. raw:', JSON.stringify(msg));
          continue;
        }

        const { data: convData } = await supabase
          .from('conversations').select('*').eq('id', chatId).maybeSingle();

        if (!convData?.phone || !convData?.bot_id) {
          console.error('[bitrix/event] No phone/bot_id for chatId:', chatId, '| conv:', JSON.stringify(convData));
          continue;
        }

        const sendRes = await fetch('https://api.sendpulse.com/whatsapp/contacts/sendByPhone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
          body: JSON.stringify({
            bot_id: convData.bot_id,
            phone:  convData.phone,
            message: { type: 'text', text: { body: messageText } },
          }),
        });

        if (sendRes.ok) {
          const ts = Date.now();
          const { data: msgData } = await supabase.from('messages').insert({
            conversation_id: chatId,
            body: messageText,
            direction: 'out',
            ts,
          }).select().single();

          await supabase.from('conversations')
            .update({ last_message: messageText, last_time: ts })
            .eq('id', chatId);

          const { data: conv } = await supabase.from('conversations').select('*').eq('id', chatId).single();
          broadcast({ type: 'new_message', message: msgData, conversation: conv });
          console.log('[bitrix/event] Outbound message sent to', convData.phone);

          // Confirm delivery back to Bitrix24
          if (bCfg?.bitrix_auth_token && imData.chat_id && lineId) {
            callBitrix(bCfg, 'imconnector.send.status.delivery', {
              CONNECTOR: 'basicpulse',
              LINE:      lineId,
              MESSAGES: [{
                im:      imData,
                message: { id: [String(ts)] },
                chat:    { id: chatId },
              }],
            }).catch(e => console.warn('[bitrix/event] delivery status error:', e.message));
          }
        } else {
          const errText = await sendRes.text();
          console.error('[bitrix/event] SendPulse send failed:', errText);
        }
      }

    } else if (event === 'ONIMCONNECTORSTATUSDELETE') {
      const chatId = data?.CHAT?.ID || data?.chat?.id || '';
      console.log('[bitrix] Chat closed in Bitrix24:', chatId);

    } else if (event === 'ONAPPUNINSTALL') {
      console.log('[bitrix] App uninstalled — marking connector inactive');
      await saveBitrixConfig({ connector_active: false });
    }
  } catch (err) {
    console.error('[bitrix/event] handler error:', err);
  }
});

// GET — opens as the connector settings page inside Bitrix24 (slider/iframe)
app.get('/bitrix/connector', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'bitrix-connector.html'));
});

// POST — unified handler for all Bitrix24 POSTs to the PLACEMENT_HANDLER URL.
// Handles: SETTING_CONNECTOR activation, outgoing message events, auth token capture.
app.post('/bitrix/connector', async (req, res) => {
  const p = req.body;
  const rawSnippet = (req.rawBody || '').slice(0, 800);
  console.log('[bitrix/connector POST] ct:', req.headers['content-type'], 'raw:', rawSnippet);

  // Log to event store for diagnostics — include raw body snippet so we can
  // see the exact format Bitrix24 sends even if parsing fails.
  const evtName = p.event || p.EVENT || p.PLACEMENT || '(unknown)';
  recentBitrixEvents.unshift({
    ts: new Date().toISOString(),
    via: 'connector',
    event: evtName,
    content_type: req.headers['content-type'] || '',
    body: p,
    raw: rawSnippet,
  });
  if (recentBitrixEvents.length > 20) recentBitrixEvents.pop();

  // ── Outgoing message: agent replied in Open Line ──────────────────────────
  const event = p.event || p.EVENT || '';
  if (event === 'ONIMCONNECTORMESSAGEADD') {
    res.send('ok');
    const data = p.data || p.DATA || {};
    const lineId = String(data?.LINE || data?.line || '');
    const messages = data?.MESSAGES || data?.messages || [];
    if (!messages.length) {
      console.warn('[bitrix/connector] ONIMCONNECTORMESSAGEADD — no MESSAGES:', JSON.stringify(data));
      return;
    }
    try {
      const { data: settings } = await supabase.from('settings').select('key, value');
      const s = Object.fromEntries((settings || []).map(r => [r.key, r.value]));
      if (!s.client_id || !s.client_secret) return;

      const tokenRes = await fetch('https://api.sendpulse.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: s.client_id, client_secret: s.client_secret }),
      });
      const { access_token } = await tokenRes.json();
      if (!access_token) return;

      const bCfg = await getBitrixConfig();

      for (const msg of messages) {
        const imData      = msg?.im   || {};
        const chatId      = msg?.chat?.id || '';
        const rawText     = msg?.message?.text || '';
        // Strip Bitrix24 BBCode formatting before sending to WhatsApp
        const messageText = rawText
          .replace(/\[b\](.*?)\[\/b\]/gi, '$1')
          .replace(/\[i\](.*?)\[\/i\]/gi, '$1')
          .replace(/\[u\](.*?)\[\/u\]/gi, '$1')
          .replace(/\[url=[^\]]*\](.*?)\[\/url\]/gi, '$1')
          .replace(/\[br\]/gi, '\n')
          .replace(/\[\/?\w+[^\]]*\]/g, '')
          .trim();

        if (!chatId || !messageText) {
          console.warn('[bitrix/connector] Skipping — missing chat.id or text. raw:', JSON.stringify(msg));
          continue;
        }

        const { data: convData } = await supabase
          .from('conversations').select('*').eq('id', chatId).maybeSingle();
        if (!convData?.phone || !convData?.bot_id) {
          console.error('[bitrix/connector] No phone/bot_id for chatId:', chatId, '| conv:', JSON.stringify(convData));
          continue;
        }

        const sendRes = await fetch('https://api.sendpulse.com/whatsapp/contacts/sendByPhone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
          body: JSON.stringify({ bot_id: convData.bot_id, phone: convData.phone,
            message: { type: 'text', text: { body: messageText } } }),
        });

        if (sendRes.ok) {
          const ts = Date.now();
          const { data: msgData } = await supabase.from('messages').insert({
            conversation_id: chatId, body: messageText, direction: 'out', ts,
          }).select().single();
          await supabase.from('conversations').update({ last_message: messageText, last_time: ts }).eq('id', chatId);
          const { data: conv } = await supabase.from('conversations').select('*').eq('id', chatId).single();
          broadcast({ type: 'new_message', message: msgData, conversation: conv });
          console.log('[bitrix/connector] Outbound sent to', convData.phone);

          // Confirm delivery back to Bitrix24 so the message shows as delivered
          if (bCfg?.bitrix_auth_token && imData.chat_id && lineId) {
            callBitrix(bCfg, 'imconnector.send.status.delivery', {
              CONNECTOR: 'basicpulse',
              LINE:      lineId,
              MESSAGES: [{
                im:      imData,
                message: { id: [String(ts)] },
                chat:    { id: chatId },
              }],
            }).catch(e => console.warn('[bitrix/connector] delivery status error:', e.message));
          }
        } else {
          const errText = await sendRes.text();
          console.error('[bitrix/connector] SendPulse error:', errText);
        }
      }
    } catch (err) {
      console.error('[bitrix/connector] ONIMCONNECTORMESSAGEADD error:', err.message);
    }
    return;
  }

  if (event === 'ONIMCONNECTORSTATUSDELETE') {
    console.log('[bitrix/connector] Chat closed:', JSON.stringify(p.data || {}));
    return res.send('ok');
  }

  if (event === 'ONAPPUNINSTALL') {
    await saveBitrixConfig({ connector_active: false }).catch(() => {});
    return res.send('ok');
  }

  // ── Contact Center activation ─────────────────────────────────────────────
  if (p.PLACEMENT === 'SETTING_CONNECTOR' && p.PLACEMENT_OPTIONS) {
    try {
      const opts = typeof p.PLACEMENT_OPTIONS === 'string'
        ? JSON.parse(p.PLACEMENT_OPTIONS) : p.PLACEMENT_OPTIONS;
      const lineId = String(opts.LINE || opts.line || '');
      const active = String(parseInt(opts.ACTIVE_STATUS ?? opts.active_status ?? 1, 10) || 0);
      console.log('[bitrix/connector] SETTING_CONNECTOR — line:', lineId, 'active:', active);
      const cfg = await getBitrixConfig();
      if (cfg?.bitrix_auth_token && lineId) {
        await callBitrix(cfg, 'imconnector.activate', { CONNECTOR: 'basicpulse', LINE: lineId, ACTIVE: active });
        await saveBitrixConfig({ open_channel_id: lineId, connector_active: active === '1' });
      }
    } catch (err) {
      console.error('[bitrix/connector] SETTING_CONNECTOR error:', err.message);
    }
    return res.send('successfully');
  }

  // ── Auth token capture (slider open / install) ────────────────────────────
  const token = p.AUTH_ID || p.access_token || '';
  if (token) {
    try {
      const upd = {
        bitrix_auth_token:       token,
        bitrix_token_expires_at: new Date(Date.now() + (Number(p.AUTH_EXPIRES || p.expires_in) || 3600) * 1000).toISOString(),
      };
      const domain   = p.DOMAIN    || p.domain    || '';
      const memberId = p.member_id || p.MEMBER_ID || '';
      const refresh  = p.REFRESH_ID || p.refresh_token || '';
      if (domain)   upd.bitrix_domain       = domain;
      if (memberId) upd.bitrix_member_id    = memberId;
      if (refresh)  upd.bitrix_refresh_token = refresh;
      await saveBitrixConfig(upd);
      console.log('[bitrix/connector] Auth token captured');
    } catch (err) {
      console.error('[bitrix/connector] Token save error:', err.message);
    }
  }

  res.sendFile(path.join(__dirname, 'public', 'bitrix-connector.html'));
});

// Explicitly registers the connector and returns each step's result or error
app.post('/api/bitrix/register', async (_req, res) => {
  try {
    const cfg    = await getBitrixConfig();
    if (!cfg?.bitrix_auth_token) return res.status(400).json({ error: 'Not connected — open connector page inside Bitrix24 first' });
    const appUrl = process.env.APP_URL || 'https://rosybrown-marten-491343.hostingersite.com';

    const results = {};

    try {
      await registerConnector(cfg, appUrl);
      results.imconnector_register = 'ok';
    } catch (e) { results.imconnector_register_error = e.message; }

    try {
      await registerEventHandlers(cfg, appUrl);
      results.event_bind = 'ok';
    } catch (e) { results.event_bind_error = e.message; }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sends a test message to the connected Bitrix24 Open Line — confirms delivery end-to-end
app.post('/api/bitrix/test-message', async (_req, res) => {
  try {
    const cfg = await getBitrixConfig();
    if (!cfg?.bitrix_auth_token) return res.status(400).json({ error: 'Not connected to Bitrix24' });
    if (!cfg?.open_channel_id)  return res.status(400).json({ error: 'No open line configured' });

    await callBitrix(cfg, 'imconnector.send.messages', {
      CONNECTOR: 'basicpulse',
      LINE:      String(cfg.open_channel_id),
      MESSAGES: [{
        user:    { id: 'test-contact', name: 'BasicPulse Test', phone: '' },
        message: { id: String(Date.now()), date: Math.floor(Date.now() / 1000), text: 'Test message from BasicPulse — connection is working!' },
        chat:    { id: 'test-contact', name: 'BasicPulse Test', url: '' },
      }],
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[test-message]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Shows the raw request Bitrix24 sent to /bitrix/install — open in browser after reinstalling
app.get('/api/bitrix/install-debug', (_req, res) => {
  if (!lastInstallRequest) {
    return res.json({ called: false, message: 'Handler has not been called since last server start' });
  }
  res.json({ called: true, ...lastInstallRequest });
});

// Lists all event.bind handlers registered for this app
app.get('/api/bitrix/event-bindings', async (_req, res) => {
  try {
    const cfg = await getBitrixConfig();
    if (!cfg?.bitrix_auth_token) return res.status(400).json({ error: 'Not connected' });
    const result = await callBitrix(cfg, 'event.get', {});
    res.json({ ok: true, events: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-bind all event handlers (run this if ONIMCONNECTORMESSAGEADD stops firing)
app.post('/api/bitrix/rebind-events', async (_req, res) => {
  try {
    const cfg    = await getBitrixConfig();
    if (!cfg?.bitrix_auth_token) return res.status(400).json({ error: 'Not connected' });
    const appUrl = process.env.APP_URL || 'https://rosybrown-marten-491343.hostingersite.com';
    await registerEventHandlers(cfg, appUrl);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lists all registered imconnectors — confirms basicpulse is in the registry
app.get('/api/bitrix/connector-list', async (_req, res) => {
  try {
    const cfg = await getBitrixConfig();
    if (!cfg?.bitrix_auth_token) return res.status(400).json({ error: 'Not connected' });
    const result = await callBitrix(cfg, 'imconnector.list', {});
    res.json({ ok: true, connectors: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lists all placement.bind handlers to check CONTACT_CENTER registration
app.get('/api/bitrix/placement-list', async (_req, res) => {
  try {
    const cfg = await getBitrixConfig();
    if (!cfg?.bitrix_auth_token) return res.status(400).json({ error: 'Not connected' });
    const result = await callBitrix(cfg, 'placement.get', { PLACEMENT: 'CONTACT_CENTER' });
    res.json({ ok: true, placements: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tests whether the bitrix_config table exists and is reachable in Supabase
app.get('/api/bitrix/db-test', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('bitrix_config').select('id').limit(1);
    if (error) return res.json({ ok: false, error: error.message, hint: error.hint || '' });
    res.json({ ok: true, rows: (data || []).length });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Receives fresh tokens from BX24.getAuth() called inside the Bitrix24 iframe
app.post('/api/bitrix/token', async (req, res) => {
  try {
    const { access_token, refresh_token, expires_in, domain, member_id } = req.body;
    if (!access_token) return res.status(400).json({ error: 'access_token required' });

    const tokenUpdate = {
      bitrix_auth_token:       access_token,
      bitrix_token_expires_at: new Date(Date.now() + (Number(expires_in) || 3600) * 1000).toISOString(),
    };
    if (refresh_token) tokenUpdate.bitrix_refresh_token    = refresh_token;
    if (domain)        tokenUpdate.bitrix_domain           = domain;
    if (member_id)     tokenUpdate.bitrix_member_id        = member_id;
    await saveBitrixConfig(tokenUpdate);

    res.json({ ok: true });
  } catch (err) {
    console.error('/api/bitrix/token error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Restore a missing domain (one-time recovery when domain got wiped)
app.post('/api/bitrix/set-domain', async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain required' });
    await saveBitrixConfig({ bitrix_domain: domain });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Bitrix24 App ID + Secret Key entered via the Settings UI
app.post('/api/bitrix/credentials', async (req, res) => {
  try {
    const { app_id, app_secret } = req.body;
    if (!app_id) return res.status(400).json({ error: 'app_id required' });
    const updates = { bitrix_app_id: app_id };
    if (app_secret) updates.bitrix_client_secret = app_secret;
    await saveBitrixConfig(updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint — shows what was saved from the install handler
app.get('/api/bitrix/debug', async (_req, res) => {
  const cfg = await getBitrixConfig();
  if (!cfg) return res.json({ saved: false });
  res.json({
    saved:            true,
    app_id:           cfg.bitrix_app_id   || null,
    has_secret:       !!cfg.bitrix_client_secret,
    domain:           cfg.bitrix_domain   || null,
    member_id:        cfg.bitrix_member_id || null,
    has_auth_token:   !!cfg.bitrix_auth_token,
    has_refresh_token: !!cfg.bitrix_refresh_token,
    token_expires_at: cfg.bitrix_token_expires_at,
    connector_active: cfg.connector_active,
    open_channel_id:  cfg.open_channel_id || null,
  });
});

// Status endpoint — used by the connector page and settings page
app.get('/api/bitrix/status', async (_req, res) => {
  const cfg = await getBitrixConfig();
  res.json({
    connected:        !!cfg?.bitrix_auth_token,
    has_credentials:  !!(cfg?.bitrix_app_id && cfg?.bitrix_client_secret),
    domain:           cfg?.bitrix_domain   || null,
    member_id:        cfg?.bitrix_member_id || null,
    connector_active: cfg?.connector_active || false,
    open_channel_id:  cfg?.open_channel_id  || null,
  });
});

// Activate connector on a specific Bitrix24 Open Line
app.post('/api/bitrix/connect', async (req, res) => {
  try {
    const { open_channel_id } = req.body;
    if (!open_channel_id) return res.status(400).json({ error: 'open_channel_id required' });

    const cfg = await getBitrixConfig();
    if (!cfg?.bitrix_auth_token) return res.status(400).json({ error: 'Bitrix24 not connected — open this page inside Bitrix24 first' });

    const appUrl = process.env.APP_URL || 'https://rosybrown-marten-491343.hostingersite.com';

    // Register connector first (safe to call even if already registered)
    try {
      await registerConnector(cfg, appUrl);
    } catch (regErr) {
      console.warn('[connect] registerConnector:', regErr.message);
    }

    // Register event handlers
    try {
      await registerEventHandlers(cfg, appUrl);
    } catch (evtErr) {
      console.warn('[connect] registerEventHandlers:', evtErr.message);
    }

    // Activate connector for the chosen open line
    // Correct param is CONNECTOR (not ID)
    await callBitrix(cfg, 'imconnector.activate', {
      CONNECTOR: 'basicpulse',
      LINE:      String(open_channel_id),
      ACTIVE:    '1',
    });

    await saveBitrixConfig({ open_channel_id: String(open_channel_id), connector_active: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('Bitrix connect error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Deactivate connector
app.post('/api/bitrix/disconnect', async (_req, res) => {
  try {
    const cfg = await getBitrixConfig();
    if (cfg?.open_channel_id) {
      await callBitrix(cfg, 'imconnector.activate', {
        CONNECTOR: 'basicpulse',
        LINE:      String(cfg.open_channel_id),
        ACTIVE:    '0',
      });
    }
    await saveBitrixConfig({ connector_active: false, open_channel_id: null });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/version', (_req, res) => res.json({ version: 'v8', started: new Date().toISOString() }));

// Shows active polling sessions — useful to verify chatId was captured
app.get('/api/bitrix/poll-sessions', (_req, res) => {
  const sessions = {};
  for (const [k, v] of bitrixChatSessions) sessions[k] = v;
  res.json({ count: bitrixChatSessions.size, sessions });
});

// ─── Start ───────────────────────────────────────────────────────────────────

// Catch any unhandled errors so the process stays alive
process.on('uncaughtException',  err => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

server.on('error', err => console.error('[server error]', err.message));

function start() {
  // Sync env-var credentials to Supabase settings — fire-and-forget so they
  // never block the port from binding.
  if (process.env.SENDPULSE_CLIENT_ID) {
    supabase.from('settings').upsert({ key: 'client_id', value: process.env.SENDPULSE_CLIENT_ID }, { onConflict: 'key' }).catch(() => {});
  }
  if (process.env.SENDPULSE_CLIENT_SECRET) {
    supabase.from('settings').upsert({ key: 'client_secret', value: process.env.SENDPULSE_CLIENT_SECRET }, { onConflict: 'key' }).catch(() => {});
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`BasicPulse running on port ${PORT}`);

    // Restore Bitrix24 chat sessions in the background — never blocks startup
    supabase.from('conversations')
      .select('id, bitrix_chat_id')
      .not('bitrix_chat_id', 'is', null)
      .then(({ data: convs }) => {
        for (const c of convs || []) {
          if (c.bitrix_chat_id) {
            bitrixChatSessions.set(c.id, { chatId: c.bitrix_chat_id });
            console.log('[start] Restored session conv', c.id, '→ chatId', c.bitrix_chat_id);
          }
        }
      })
      .catch(err => console.warn('[start] Could not restore sessions:', err.message));
  });

  setInterval(pollBitrixReplies, 8000);
}

start();
