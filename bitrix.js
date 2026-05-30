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

// WhatsApp icon as base64-encoded SVG (more reliable than URL-encoded)
const CONNECTOR_ICON = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<circle cx="12" cy="12" r="12" fill="#25D366"/>' +
  '<path fill="#fff" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15' +
  '-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475' +
  '-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52' +
  '.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207' +
  '-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372' +
  '-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074' +
  '.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625' +
  '.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413' +
  '.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347' +
  'm-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982' +
  '.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884' +
  ' 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994' +
  'c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0' +
  'C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24' +
  'l6.305-1.654a11.882 11.882 0 005.683 1.448h.005' +
  'c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>' +
  '</svg>'
).toString('base64');

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

  // Bind to Contact Center so the connector card appears there
  // "already binded" is not an error — it means it was registered before
  try {
    await callBitrix(config, 'placement.bind', {
      PLACEMENT: 'CONTACT_CENTER',
      HANDLER:   `${appUrl}/bitrix/connector`,
      TITLE:     'BasicPulse',
    });
  } catch (err) {
    if (!err.message.includes('already binded')) throw err;
  }
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
