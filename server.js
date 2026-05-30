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
        await sendMessageToBitrix(bCfg, conv, text, ts);
      }
    } catch (bErr) {
      console.error('[webhook] Bitrix24 forward error:', bErr.message);
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
  console.log('[bitrix/event]', event, JSON.stringify(data).slice(0, 300));

  try {
    if (event === 'ONIMCONNECTORMESSAGEADD') {
      // Agent replied inside Bitrix24 — forward to WhatsApp via SendPulse
      const chatId      = data?.CHAT?.ID || data?.chat?.id || '';
      const messageText = data?.MESSAGE?.text || data?.message?.text || '';

      if (!chatId || !messageText) return;

      const { data: convData } = await supabase
        .from('conversations').select('*').eq('id', chatId).maybeSingle();

      if (!convData?.phone || !convData?.bot_id) {
        console.error('[bitrix/event] No phone/bot_id for conversation', chatId);
        return;
      }

      // Get SendPulse token
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

      // Send to WhatsApp
      const sendRes = await fetch('https://api.sendpulse.com/whatsapp/contacts/sendByPhone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
        body: JSON.stringify({
          bot_id: convData.bot_id,
          phone: convData.phone,
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

// Connector configuration page — embedded inside Bitrix24 Contact Center
// Also captures auth tokens if Bitrix24 POSTs them here (initial install path)
app.all('/bitrix/connector', async (req, res) => {
  const p = { ...req.query, ...req.body };
  const token = p.AUTH_ID || p.access_token || '';
  if (token) {
    try {
      await saveBitrixConfig({
        bitrix_auth_token:       token,
        bitrix_refresh_token:    p.REFRESH_ID || p.refresh_token || '',
        bitrix_domain:           p.DOMAIN     || p.domain        || '',
        bitrix_member_id:        p.member_id  || '',
        bitrix_token_expires_at: new Date(Date.now() + (Number(p.AUTH_EXPIRES || p.expires_in) || 3600) * 1000).toISOString(),
      });
      console.log('[bitrix/connector] Auth token captured from POST');
    } catch (err) {
      console.error('[bitrix/connector] Token save error:', err.message);
    }
  }
  res.sendFile(path.join(__dirname, 'public', 'bitrix-connector.html'));
});

// Sends a test message to the connected Bitrix24 Open Line — confirms delivery end-to-end
app.post('/api/bitrix/test-message', async (_req, res) => {
  try {
    const cfg = await getBitrixConfig();
    if (!cfg?.bitrix_auth_token) return res.status(400).json({ error: 'Not connected to Bitrix24' });
    if (!cfg?.open_channel_id)  return res.status(400).json({ error: 'No open line configured' });

    await callBitrix(cfg, 'imconnector.send.message', {
      CONNECTOR: 'basicpulse',
      LINE:      String(cfg.open_channel_id),
      MESSAGES: [{
        id:   String(Date.now()),
        chat: { id: 'test-contact', name: 'BasicPulse Test', url: '' },
        user: { id: 'test-contact', name: 'BasicPulse Test', phone: '', picture: '', url: '' },
        message: { text: '✅ Test message from BasicPulse — connection is working!', files: [] },
        chat_message_status: 'received',
        timestamp: Math.floor(Date.now() / 1000),
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

    await saveBitrixConfig({
      bitrix_auth_token:       access_token,
      bitrix_refresh_token:    refresh_token || '',
      bitrix_token_expires_at: new Date(Date.now() + (Number(expires_in) || 3600) * 1000).toISOString(),
      bitrix_domain:           domain        || '',
      bitrix_member_id:        member_id     || '',
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('/api/bitrix/token error:', err);
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
      ACTIVE:    'Y',
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
        ACTIVE:    'N',
      });
    }
    await saveBitrixConfig({ connector_active: false, open_channel_id: null });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
