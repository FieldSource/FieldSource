// netlify/functions/dropbox-connect.js
// Connects the company Dropbox to the tracker and stores its tokens in app_settings.
//
// Security: the connect link must include the shared secret:
//   https://fieldsourcetracker.netlify.app/.netlify/functions/dropbox-connect?key=<ESTIMATE_SYNC_SECRET>
// Without it, a stranger could connect THEIR Dropbox and receive the company's invoices.
// The return trip from Dropbox is verified with a signed, 15-minute "state" value.

const crypto = require('crypto');

const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const REDIRECT_URI = 'https://fieldsourcetracker.netlify.app/.netlify/functions/dropbox-connect';
const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const SECRET = process.env.ESTIMATE_SYNC_SECRET;

const page = (ok, title, msg) => ({
  statusCode: ok ? 200 : 400,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;line-height:1.5">
<h2 style="color:${ok ? '#15803d' : '#b91c1c'}">${title}</h2><p>${msg}</p></body>`,
});

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

async function setSetting(key, value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`Saving ${key} failed (${r.status}): ${await r.text()}`);
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const APP_KEY = process.env.DROPBOX_APP_KEY;
  const APP_SECRET = process.env.DROPBOX_APP_SECRET;
  if (!SB_KEY || !SECRET) return page(false, 'Not configured', 'SUPABASE_SERVICE_KEY or ESTIMATE_SYNC_SECRET is missing in Netlify.');

  if (q.error) return page(false, 'Dropbox was not connected', `Dropbox returned: ${q.error}. Nothing was changed.`);

  // Return trip from Dropbox
  if (q.code) {
    if (!stateOk(q.state)) return page(false, 'Connection rejected', 'This did not start from the tracker\'s connect link, or it took longer than 15 minutes. Start again.');
    const creds = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: q.code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }).toString(),
    });
    const tokens = await r.json().catch(() => ({}));
    if (!tokens.access_token) return page(false, 'Dropbox did not return a token', `${r.status} ${tokens.error || ''} ${tokens.error_description || ''}`);
    try {
      await setSetting('DROPBOX_ACCESS_TOKEN', tokens.access_token);
      if (tokens.refresh_token) await setSetting('DROPBOX_REFRESH_TOKEN', tokens.refresh_token);
    } catch (e) {
      return page(false, 'Could not save the Dropbox connection', e.message);
    }
    return { statusCode: 302, headers: { Location: 'https://fieldsourcetracker.netlify.app/?dropbox=connected' }, body: '' };
  }

  // Start: only with the shared secret
  if (!q.key || q.key !== SECRET) return page(false, 'Link not valid', 'Use the full Dropbox connect link, including its ?key= part.');
  const params = new URLSearchParams({
    client_id: APP_KEY, redirect_uri: REDIRECT_URI, response_type: 'code',
    token_access_type: 'offline', state: makeState(),
  });
  return { statusCode: 302, headers: { Location: `${DROPBOX_AUTH_URL}?${params.toString()}` }, body: '' };
};
