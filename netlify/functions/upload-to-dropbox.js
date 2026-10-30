// netlify/functions/upload-to-dropbox.js
// Uploads an invoice file to Dropbox (/Field Source Ohio/Accounts Payable/).
//
// Security: only logged-in tracker users. The tracker sends the user's login token
// as "Authorization: Bearer <token>", which is checked with Supabase Auth.
// Reads/writes Dropbox tokens in app_settings with the service key (works with RLS on).

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

async function requireUser(event) {
  const auth = (event.headers || {}).authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}

async function getSetting(key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${key}&select=value`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Reading ${key} failed (${r.status})`);
  const rows = await r.json();
  return rows && rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) console.error(`Saving ${key} failed (${r.status}): ${await r.text()}`);
}

async function getAccessToken() {
  const refreshToken = await getSetting('DROPBOX_REFRESH_TOKEN');
  if (refreshToken) {
    const creds = Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString('base64');
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    const tokens = await r.json().catch(() => ({}));
    if (!tokens.access_token) throw new Error('Dropbox refused the saved token. Reconnect Dropbox.');
    await setSetting('DROPBOX_ACCESS_TOKEN', tokens.access_token);
    return tokens.access_token;
  }
  const staticToken = (await getSetting('DROPBOX_ACCESS_TOKEN')) || process.env.DROPBOX_ACCESS_TOKEN;
  if (!staticToken) throw new Error('No Dropbox token available. Reconnect Dropbox.');
  return staticToken;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!SB_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY in Netlify' });

  try {
    if (!(await requireUser(event))) return json(401, { error: 'Please log in to the tracker again.' });

    const { fileData, fileName } = JSON.parse(event.body || '{}');
    if (!fileData || !fileName) return json(400, { error: 'fileData and fileName are required' });
    const safeName = String(fileName).replace(/[\\/]/g, '-').slice(0, 200);

    const accessToken = await getAccessToken();
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: `/Field Source Ohio/Accounts Payable/${safeName}`, mode: 'overwrite', autorename: false, mute: false })
          .replace(/[\u007f-\uffff]/g, c => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4)),
      },
      body: Buffer.from(fileData, 'base64'),
    });
    const result = await r.json().catch(async () => ({ error_summary: await r.text() }));
    if (!r.ok || result.error_summary) throw new Error(result.error_summary || `Dropbox ${r.status}`);

    return json(200, { success: true, path: result.path_display });
  } catch (e) {
    console.error('Dropbox upload error:', e.message);
    return json(500, { error: e.message });
  }
};
