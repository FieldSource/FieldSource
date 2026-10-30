// netlify/functions/qb-connect.js
// QuickBooks OAuth for the Field Source Tracker.
//
//   1. Ryan opens  /.netlify/functions/qb-connect   -> sent to Intuit to sign in and approve
//   2. Intuit sends him back here with ?code=...&realmId=...
//   3. We trade the code for tokens and store them in Supabase app_settings:
//        QB_REFRESH_TOKEN, QB_REALM_ID, QB_CONNECTED_AT
//   4. Ryan lands on the tracker at ?qb=connected
//
// Register this exact Redirect URI in developer.intuit.com (Production keys):
//   https://fieldsourcetracker.netlify.app/.netlify/functions/qb-connect
//
// Security: the connect link must include the shared secret:
//   https://fieldsourcetracker.netlify.app/.netlify/functions/qb-connect?key=<ESTIMATE_SYNC_SECRET>
// The return trip from Intuit is verified with a signed, 15-minute "state" value.

const https = require('https');
const crypto = require('crypto');
const SECRET = process.env.ESTIMATE_SYNC_SECRET;
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
function makeState() { const v = `${crypto.randomBytes(8).toString('hex')}.${Date.now()}`; return `${v}.${sign(v)}`; }
function stateOk(s) {
  const parts = String(s || '').split('.');
  if (parts.length !== 3) return false;
  const v = `${parts[0]}.${parts[1]}`;
  const good = sign(v);
  if (parts[2].length !== good.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(good))) return false;
  return Date.now() - Number(parts[1]) < 15 * 60 * 1000;
}

const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const REDIRECT_URI = 'https://fieldsourcetracker.netlify.app/.netlify/functions/qb-connect';
const TRACKER_URL = 'https://fieldsourcetracker.netlify.app/';
const SUPABASE_HOST = 'pldlvtlbgxizbppaliag.supabase.co';

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const page = (title, msg, ok) => ({
  statusCode: ok ? 200 : 500,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;line-height:1.5">
<h2 style="color:${ok ? '#15803d' : '#b91c1c'}">${title}</h2><p>${msg}</p>
<p><a href="${TRACKER_URL}">Back to the tracker</a></p></body>`,
});

async function saveSetting(key, value, supabaseKey) {
  const body = JSON.stringify({ key, value, updated_at: new Date().toISOString() });
  const res = await request({
    hostname: SUPABASE_HOST,
    path: '/rest/v1/app_settings?on_conflict=key',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
  }, body);
  if (res.status >= 300) throw new Error(`Saving ${key} failed (${res.status}): ${res.body}`);
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const CLIENT_ID = process.env.QB_CLIENT_ID;
  const CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!CLIENT_ID || !CLIENT_SECRET) return page('QuickBooks not configured', 'QB_CLIENT_ID or QB_CLIENT_SECRET is missing in Netlify.', false);
  if (!SUPABASE_KEY || !SECRET) return page('Not configured', 'SUPABASE_SERVICE_KEY or ESTIMATE_SYNC_SECRET is missing in Netlify.', false);

  // Intuit sent back an error (e.g. Ryan clicked Cancel)
  if (q.error) {
    return page('QuickBooks was not connected', `Intuit returned: ${q.error}${q.error_description ? ' - ' + q.error_description : ''}. Nothing was changed. You can try the connect link again.`, false);
  }

  // Step 2: callback from Intuit. Must be checked BEFORE the redirect below,
  // otherwise the callback (which has no ?action) would bounce back to Intuit forever.
  if (q.code) {
    if (!stateOk(q.state)) return page('Connection rejected', 'This did not start from the tracker\'s connect link, or it took longer than 15 minutes. Start again.', false);
    try {
      const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: REDIRECT_URI }).toString();
      const res = await request({
        hostname: 'oauth.platform.intuit.com',
        path: '/oauth2/v1/tokens/bearer',
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, body);

      let tokens = {};
      try { tokens = JSON.parse(res.body); } catch (e) {}
      if (!tokens.refresh_token) {
        return page('QuickBooks did not return a token', `Intuit said: ${res.status} ${tokens.error || ''} ${tokens.error_description || res.body.slice(0, 300)}`, false);
      }

      await saveSetting('QB_REFRESH_TOKEN', tokens.refresh_token, SUPABASE_KEY);
      if (q.realmId) await saveSetting('QB_REALM_ID', q.realmId, SUPABASE_KEY);
      await saveSetting('QB_CONNECTED_AT', new Date().toISOString(), SUPABASE_KEY);

      const envRealm = process.env.QB_REALM_ID;
      const mismatch = envRealm && q.realmId && envRealm !== q.realmId;
      if (mismatch) {
        return page('Connected, but check the company',
          `QuickBooks connected company ID ${q.realmId}, but Netlify's QB_REALM_ID is ${envRealm}. If ${q.realmId} is the Field Source company, update QB_REALM_ID in Netlify to match.`, true);
      }

      return { statusCode: 302, headers: { Location: `${TRACKER_URL}?qb=connected` }, body: '' };
    } catch (e) {
      return page('QuickBooks connection failed', e.message, false);
    }
  }

  // Step 1: send the person to Intuit to sign in and approve (only with the shared secret)
  if (!q.key || q.key !== SECRET) return page('Link not valid', 'Use the full QuickBooks connect link, including its ?key= part.', false);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state: makeState(),
  });
  return { statusCode: 302, headers: { Location: `${QB_AUTH_URL}?${params.toString()}` }, body: '' };
};
