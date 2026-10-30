// netlify/functions/qb-estimate-pdf.js
// Returns the real QuickBooks PDF for an estimate:  /.netlify/functions/qb-estimate-pdf?doc=1855
//
// Security: only logged-in tracker users ("Authorization: Bearer <login token>").
// Looks up the QuickBooks estimate ID from qb_estimates (kept fresh by qb-sync), falling back
// to asking QuickBooks directly. Saves the rotated refresh token like the other QB functions.

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const QB_API = 'https://quickbooks.api.intuit.com';

const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function requireUser(event) {
  const token = ((event.headers || {}).authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}

async function getSetting(key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${key}&select=value`, { headers: sbHeaders });
  const rows = await r.json().catch(() => []);
  return rows && rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`Saving ${key} failed (${r.status})`);
}

async function getAccessToken() {
  const refresh = await getSetting('QB_REFRESH_TOKEN');
  if (!refresh) throw new Error('QuickBooks is not connected.');
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
  });
  const tok = await r.json().catch(() => ({}));
  if (!tok.access_token) throw new Error('QuickBooks refused the saved token. A QuickBooks admin needs to reconnect.');
  if (tok.refresh_token && tok.refresh_token !== refresh) await setSetting('QB_REFRESH_TOKEN', tok.refresh_token);
  return tok.access_token;
}

exports.handler = async function (event) {
  if (!SB_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY in Netlify' });
  try {
    if (!(await requireUser(event))) return json(401, { error: 'Please log in to the tracker again.' });

    const doc = String((event.queryStringParameters || {}).doc || '').trim();
    if (!/^[\w-]{1,30}$/.test(doc)) return json(400, { error: 'Missing or invalid estimate number' });

    const realm = (await getSetting('QB_REALM_ID')) || process.env.QB_REALM_ID;
    const accessToken = await getAccessToken();
    const qbHeaders = { Authorization: `Bearer ${accessToken}` };

    // Find the QuickBooks internal ID for this estimate number
    let qbId = null;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/qb_estimates?estimate_number=eq.${encodeURIComponent(doc)}&select=qb_estimate_id&limit=1`, { headers: sbHeaders });
    const rows = await r.json().catch(() => []);
    if (rows && rows[0]) qbId = rows[0].qb_estimate_id;
    if (!qbId) {
      const q = encodeURIComponent(`SELECT Id FROM Estimate WHERE DocNumber = '${doc}'`);
      const qr = await fetch(`${QB_API}/v3/company/${realm}/query?query=${q}&minorversion=73`, { headers: { ...qbHeaders, Accept: 'application/json' } });
      const data = await qr.json().catch(() => ({}));
      const found = data.QueryResponse && data.QueryResponse.Estimate && data.QueryResponse.Estimate[0];
      if (found) qbId = found.Id;
    }
    if (!qbId) return json(404, { error: `Estimate #${doc} was not found in QuickBooks.` });

    const pr = await fetch(`${QB_API}/v3/company/${realm}/estimate/${qbId}/pdf?minorversion=73`, {
      headers: { ...qbHeaders, Accept: 'application/pdf' },
    });
    if (!pr.ok) return json(502, { error: `QuickBooks could not produce the PDF (${pr.status}).` });
    const buf = Buffer.from(await pr.arrayBuffer());

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Estimate-${doc}.pdf"`, 'Cache-Control': 'private, no-store' },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    return json(500, { error: e.message });
  }
};
