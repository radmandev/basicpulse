const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// Node.js 18 has no native WebSocket — pass the 'ws' package explicitly so
// @supabase/realtime-js doesn't throw at startup on this version.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: { transport: WebSocket },
  }
);

module.exports = supabase;
