// netlify/functions/qb-customers.js
// Active QuickBooks customers for the quote builder's client dropdown (name, email, billing address).
// Cached for an hour in app_settings. Logged-in tracker users only. Add ?refresh=1 to bypass the cache.

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const QB_API = 'https://quickbooks.api.intuit.com';
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function requireUser(event) {
  const token = ((event.headers || {}).authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}
async function getSetting(key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${key}&select=value`, { headers: sbH });
  const rows = await r.json().catch(() => []);
  return rows && rows[0] ? rows[0].value : null;
}
async function setSetting(key, value) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: 'POST',
    headers: { ...sbH, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}
async function qbAccess() {
  const refresh = await getSetting('QB_REFRESH_TOKEN');
  if (!refresh) throw new Error('QuickBooks is not connected.');
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
  });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error('QuickBooks refused the saved token. A QuickBooks admin needs to reconnect.');
  if (t.refresh_token && t.refresh_token !== refresh) await setSetting('QB_REFRESH_TOKEN', t.refresh_token);
  return t.access_token;
}

exports.handler = async function (event) {
  if (!SB_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY in Netlify' });
  try {
    if (!(await requireUser(event))) return json(401, { error: 'Please log in to the tracker again.' });
    const refresh = (event.queryStringParameters || {}).refresh === '1';
    if (!refresh) {
      const cached = await getSetting('QB_CUSTOMERS_CACHE');
      if (cached) { try { const c = JSON.parse(cached); if (Date.now() - c.at < 60 * 60 * 1000) return json(200, { customers: c.customers }); } catch (e) {} }
    }
    const realm = (await getSetting('QB_REALM_ID')) || process.env.QB_REALM_ID;
    const token = await qbAccess();
    const customers = [];
    for (let start = 1; start < 5000; start += 1000) {
      const q = encodeURIComponent(`SELECT * FROM Customer WHERE Active = true ORDERBY DisplayName STARTPOSITION ${start} MAXRESULTS 1000`);
      const r = await fetch(`${QB_API}/v3/company/${realm}/query?query=${q}&minorversion=73`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      const d = await r.json().catch(() => ({}));
      if (d.Fault) throw new Error('QuickBooks customer lookup failed');
      const page = (d.QueryResponse && d.QueryResponse.Customer) || [];
      page.forEach(c => {
        const a = c.BillAddr || {};
        customers.push({
          id: String(c.Id), name: c.DisplayName,
          email: (c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address) || '',
          street: [a.Line1, a.Line2].filter(Boolean).join(', '),
          city_line: a.City ? `${a.City}, ${a.CountrySubDivisionCode || ''} ${a.PostalCode || ''}`.trim() : '',
        });
      });
      if (page.length < 1000) break;
    }
    await setSetting('QB_CUSTOMERS_CACHE', JSON.stringify({ at: Date.now(), customers }));
    return json(200, { customers });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
