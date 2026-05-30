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

// WhatsApp-green chat icon as SVG Data URI (required format for Bitrix24)
const CONNECTOR_ICON =
  'data:image/svg+xml;charset=US-ASCII,' +
  '%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E' +
  '%3Cpath%20fill%3D%22%2325D366%22%20d%3D%22M17.472%2014.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15' +
  '-.197.297-.767.966-.94%201.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475' +
  '-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52' +
  '.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207' +
  '-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198%200-.52.074-.792.372' +
  '-.272.297-1.04%201.016-1.04%202.479%200%201.462%201.065%202.875%201.213%203.074' +
  '.149.198%202.096%203.2%205.077%204.487.709.306%201.262.489%201.694.625' +
  '.712.227%201.36.195%201.871.118.571-.085%201.758-.719%202.006-1.413' +
  '.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347' +
  'm-5.421%207.403h-.004a9.87%209.87%200%2001-5.031-1.378l-.361-.214-3.741.982' +
  '.998-3.648-.235-.374a9.86%209.86%200%2001-1.51-5.26c.001-5.45%204.436-9.884%209.888-9.884' +
  '%202.64%200%205.122%201.03%206.988%202.898a9.825%209.825%200%20012.893%206.994' +
  'c-.003%205.45-4.437%209.884-9.885%209.884m8.413-18.297A11.815%2011.815%200%200012.05%200' +
  'C5.495%200%20.16%205.335.157%2011.892c0%202.096.547%204.142%201.588%205.945L.057%2024' +
  'l6.305-1.654a11.882%2011.882%200%20005.683%201.448h.005' +
  'c6.554%200%2011.89-5.335%2011.893-11.893a11.821%2011.821%200%2000-3.48-8.413z%22%2F%3E%3C%2Fsvg%3E';

async function registerConnector(config, appUrl) {
  await callBitrix(config, 'imconnector.register', {
    ID:                CONNECTOR_ID,
    NAME:              'BasicPulse',
    ICON:              { DATA_IMAGE: CONNECTOR_ICON, COLOR: '#25D366' },
    ICON_DISABLED:     { DATA_IMAGE: CONNECTOR_ICON, COLOR: '#aaaaaa' },
    PLACEMENT_HANDLER: `${appUrl}/bitrix/connector`,
    COMMENT:           'WhatsApp connector via SendPulse',
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
