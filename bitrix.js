const supabase = require('./db');

const CONNECTOR_ID = 'basicpulse';

// ─── Config helpers ────────────────────────────────────────────────────────────

async function getBitrixConfig() {
  const { data } = await supabase
    .from('bitrix_config')
    .select('*')
    .limit(1)
    .maybeSingle();
  return data;
}

async function saveBitrixConfig(fields) {
  const existing = await getBitrixConfig();
  if (existing) {
    await supabase
      .from('bitrix_config')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    await supabase.from('bitrix_config').insert(fields);
  }
}

// ─── Token management ──────────────────────────────────────────────────────────

async function ensureFreshToken(config) {
  if (!config?.bitrix_auth_token) return config;
  const expires = config.bitrix_token_expires_at
    ? new Date(config.bitrix_token_expires_at).getTime()
    : 0;
  // Refresh if expiring within 5 minutes
  if (Date.now() >= expires - 5 * 60 * 1000) {
    return refreshToken(config);
  }
  return config;
}

async function refreshToken(config) {
  const url =
    `https://${config.bitrix_domain}/oauth/token/` +
    `?grant_type=refresh_token` +
    `&client_id=${encodeURIComponent(config.bitrix_app_id)}` +
    `&client_secret=${encodeURIComponent(config.bitrix_client_secret)}` +
    `&refresh_token=${encodeURIComponent(config.bitrix_refresh_token)}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.access_token) {
    throw new Error('Bitrix24 token refresh failed: ' + JSON.stringify(data));
  }

  const updates = {
    bitrix_auth_token: data.access_token,
    bitrix_refresh_token: data.refresh_token || config.bitrix_refresh_token,
    bitrix_token_expires_at: new Date(
      Date.now() + (data.expires_in || 3600) * 1000
    ).toISOString(),
  };
  await saveBitrixConfig(updates);
  return { ...config, ...updates };
}

// ─── API call ──────────────────────────────────────────────────────────────────

async function callBitrix(config, method, params = {}) {
  config = await ensureFreshToken(config);
  const res = await fetch(`https://${config.bitrix_domain}/rest/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth: config.bitrix_auth_token, ...params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(
      `Bitrix24[${method}]: ${json.error} — ${json.error_description || ''}`
    );
  }
  return json.result;
}

// ─── Installation helpers ──────────────────────────────────────────────────────

async function registerConnector(config, appUrl) {
  await callBitrix(config, 'imconnector.register', {
    ID: CONNECTOR_ID,
    NAME: 'BasicPulse',
    ICON: { DATA_IMAGE: '' },
    IFRAME: `${appUrl}/bitrix/connector`,
    IFRAME_WIDTH: 800,
    IFRAME_HEIGHT: 500,
    PROPERTIES: { COLOR: '#25D366' },
  });
}

async function registerEventHandlers(config, appUrl) {
  for (const event of [
    'ONIMCONNECTORMESSAGEADD',
    'ONIMCONNECTORSTATUSDELETE',
    'ONAPPUNINSTALL',
  ]) {
    await callBitrix(config, 'event.bind', {
      EVENT: event,
      HANDLER: `${appUrl}/bitrix/event`,
    });
  }
}

// ─── Messaging ────────────────────────────────────────────────────────────────

async function sendMessageToBitrix(config, conversation, messageText, messageTs) {
  if (!config?.open_channel_id || !config.connector_active) return;

  await callBitrix(config, 'imconnector.send.message', {
    CONNECTOR: CONNECTOR_ID,
    LINE: String(config.open_channel_id),
    MESSAGES: [
      {
        id: String(messageTs || Date.now()),
        chat: {
          id: conversation.id,
          name: conversation.contact_name || 'Unknown',
          url: '',
        },
        user: {
          id: conversation.phone || conversation.id,
          name: conversation.contact_name || 'Unknown',
          phone: conversation.phone || '',
          picture: '',
          url: '',
        },
        message: { text: messageText, files: [] },
        chat_message_status: 'received',
        timestamp: Math.floor((messageTs || Date.now()) / 1000),
      },
    ],
  });
}

module.exports = {
  CONNECTOR_ID,
  getBitrixConfig,
  saveBitrixConfig,
  ensureFreshToken,
  refreshToken,
  callBitrix,
  registerConnector,
  registerEventHandlers,
  sendMessageToBitrix,
};
