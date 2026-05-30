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
  // Local apps (ID starts with 'local.') refresh on the portal domain.
  // Marketplace apps refresh on oauth.bitrix.info.
  const isLocal = (config.bitrix_app_id || '').startsWith('local.');
  const base = isLocal
    ? `https://${config.bitrix_domain}/oauth/token/`
    : `https://oauth.bitrix.info/oauth/token/`;

  const url =
    base +
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

// Simple WhatsApp-green icon — URL-encoded SVG (Bitrix24's documented format)
const CONNECTOR_ICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
  '<circle cx="24" cy="24" r="24" fill="#25D366"/>' +
  '<text x="24" y="34" text-anchor="middle" font-family="Arial,sans-serif" ' +
  'font-size="26" font-weight="bold" fill="#ffffff">W</text>' +
  '</svg>'
);

async function registerConnector(config, appUrl) {
  // Register the connector type
  await callBitrix(config, 'imconnector.register', {
    ID:                CONNECTOR_ID,
    NAME:              'BasicPulse',
    ICON:              { DATA_IMAGE: CONNECTOR_ICON, COLOR: '#25D366' },
    ICON_DISABLED:     { DATA_IMAGE: CONNECTOR_ICON, COLOR: '#aaaaaa' },
    PLACEMENT_HANDLER: `${appUrl}/bitrix/connector`,
    COMMENT:           'WhatsApp connector via SendPulse',
  });

  // Unbind first so we can update GROUP_NAME and other options cleanly
  try {
    await callBitrix(config, 'placement.unbind', {
      PLACEMENT: 'CONTACT_CENTER',
      HANDLER:   `${appUrl}/bitrix/connector`,
    });
  } catch (_) {}

  // Bind to Contact Center with GROUP_NAME 'im' so the card is grouped
  // with messaging connectors and rendered visibly in the Contact Center grid
  await callBitrix(config, 'placement.bind', {
    PLACEMENT: 'CONTACT_CENTER',
    HANDLER:   `${appUrl}/bitrix/connector`,
    TITLE:     'BasicPulse',
    DESCRIPTION: 'WhatsApp connector via SendPulse',
    LANG_ALL:  {
      en: { TITLE: 'BasicPulse', DESCRIPTION: 'WhatsApp connector via SendPulse', GROUP_NAME: 'im' },
    },
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

  const ts = Math.floor((messageTs || Date.now()) / 1000);

  await callBitrix(config, 'imconnector.send.messages', {
    CONNECTOR: CONNECTOR_ID,
    LINE:      String(config.open_channel_id),
    MESSAGES: [
      {
        user: {
          id:    conversation.phone || conversation.id,
          name:  conversation.contact_name || 'Unknown',
          phone: conversation.phone || '',
        },
        message: {
          id:   String(messageTs || Date.now()),
          date: ts,
          text: messageText,
        },
        chat: {
          id:   conversation.id,
          name: conversation.contact_name || 'Unknown',
          url:  '',
        },
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
