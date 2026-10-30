// netlify/functions/quote-to-qb.js
// Quote builder, step 2: after staff approve the draft, create the matching QuickBooks estimate
// (internal only - never emailed from QuickBooks, no e-signature or payment links) and return
// its number so the PDF can be rebuilt as "Quote No. <number>". Logged-in tracker users only.

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
const esc = s => String(s).replace(/'/g, "\\'");

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!SB_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY in Netlify' });
  try {
    const user = await requireUser(event);
    if (!user) return json(401, { error: 'Please log in to the tracker again.' });
    const { draft, customerId } = JSON.parse(event.body || '{}');
    if (!draft || !Array.isArray(draft.items) || !draft.items.length) return json(400, { error: 'The quote has no line items.' });
    const missing = draft.items.filter(i => !i.qb_item_id || i.unit_price === null || i.unit_price === '' || isNaN(Number(i.unit_price)));
    if (missing.length) return json(400, { error: `Every line needs a QuickBooks item and a price. Check: ${missing.map(i => i.title).join(', ')}` });

    const realm = (await getSetting('QB_REALM_ID')) || process.env.QB_REALM_ID;
    const token = await qbAccess();
    const qb = async (path, opts = {}) => {
      const r = await fetch(`${QB_API}/v3/company/${realm}/${path}${path.includes('?') ? '&' : '?'}minorversion=73`, {
        ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.Fault) {
        const f = d.Fault && d.Fault.Error && d.Fault.Error[0];
        throw new Error(`QuickBooks: ${f ? `${f.Message} - ${f.Detail || ''}` : r.status}`);
      }
      return d;
    };

    // Find the customer: exact name, then close matches. Ambiguous -> ask staff to pick.
    let custId = customerId;
    if (!custId) {
      const name = String(draft.client || '').trim();
      if (!name) return json(400, { error: 'The quote needs a client.' });
      let d = await qb(`query?query=${encodeURIComponent(`SELECT Id, DisplayName FROM Customer WHERE DisplayName = '${esc(name)}'`)}`);
      let found = (d.QueryResponse && d.QueryResponse.Customer) || [];
      if (found.length !== 1) {
        const word = name.split(/\s+/).sort((a, b) => b.length - a.length)[0] || name;
        d = await qb(`query?query=${encodeURIComponent(`SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '%${esc(word)}%' MAXRESULTS 25`)}`);
        const close = (d.QueryResponse && d.QueryResponse.Customer) || [];
        return json(409, { error: found.length ? 'More than one QuickBooks customer has that name.' : `No QuickBooks customer is named "${name}".`,
                           candidates: close.map(c => ({ id: c.Id, name: c.DisplayName })) });
      }
      custId = found[0].Id;
    }

    const lines = draft.items.map(it => {
      const qty = Number(it.qty) || 1, price = Number(it.unit_price);
      const desc = [it.title, ...(it.bullets || []).filter(Boolean).map(b => '- ' + b)].join('\n').slice(0, 3900);
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: Math.round(qty * price * 100) / 100,
        Description: desc,
        SalesItemLineDetail: { ItemRef: { value: String(it.qb_item_id) }, Qty: qty, UnitPrice: price },
      };
    });

    const created = await qb('estimate', {
      method: 'POST',
      body: JSON.stringify({
        CustomerRef: { value: String(custId) },
        TxnDate: new Date().toISOString().slice(0, 10),
        Line: lines,
        TxnStatus: 'Pending',
        PrivateNote: `Created from the Field Source Tracker quote builder by ${user.email}. ${draft.title || ''}`.slice(0, 4000),
      }),
    });
    const est = created.Estimate;
    if (!est.DocNumber) return json(200, { docNumber: null, id: est.Id, total: est.TotalAmt,
      warning: 'QuickBooks created the estimate but gave it no number (custom transaction numbers may be on). Open it in QuickBooks and set the number.' });
    return json(200, { docNumber: est.DocNumber, id: est.Id, total: est.TotalAmt });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
