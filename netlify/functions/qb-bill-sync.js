// netlify/functions/qb-bill-sync.js
// Pulls QuickBooks Bills (what Field Source owes vendors: vendor, invoice #, due date, open balance, project)
// into Supabase. Incremental (cursor QB_BILL_CURSOR); paying a bill changes its balance, so payments show up next run.
// Runs hourly from qb-sync-hourly.js. Open in a browser for a manual run; ?reset=1 re-pulls everything.

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const QB_API = 'https://quickbooks.api.intuit.com';
const PAGE = 300, TIME_BUDGET_MS = 8000;

async function sb(method, path, body, prefer = 'return=representation') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: prefer }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${r.status}: ${t.slice(0, 300)}`);
  try { return t ? JSON.parse(t) : null; } catch (e) { return t; }
}
async function getSetting(key) { const rows = await sb('GET', `app_settings?key=eq.${key}&select=value`); return rows && rows[0] ? rows[0].value : null; }
async function setSetting(key, value) { await sb('POST', 'app_settings?on_conflict=key', { key, value, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal'); }
async function getAccessToken() {
  const refreshToken = await getSetting('QB_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('QuickBooks is not connected.');
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', { method: 'POST', headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString() });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error(`QuickBooks refused the saved token (${r.status} ${t.error || ''}).`);
  if (t.refresh_token && t.refresh_token !== refreshToken) await setSetting('QB_REFRESH_TOKEN', t.refresh_token);
  return t.access_token;
}
async function qbQuery(token, realm, sql) {
  const r = await fetch(`${QB_API}/v3/company/${realm}/query?query=${encodeURIComponent(sql)}&minorversion=73`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.Fault) { const f = d.Fault && d.Fault.Error && d.Fault.Error[0]; throw new Error(`QuickBooks query failed (${r.status}): ${f ? f.Message + ' - ' + (f.Detail || '') : ''}`); }
  return (d.QueryResponse && d.QueryResponse.Bill) || [];
}
function billRow(b, now) {
  const projects = [...new Set((b.Line || []).map(l => { const d = l.AccountBasedExpenseLineDetail || l.ItemBasedExpenseLineDetail || {}; return d.CustomerRef && d.CustomerRef.name; }).filter(Boolean))];
  const paid = Number(b.Balance || 0) <= 0.005;
  const payDates = (b.LinkedTxn || []).filter(l => /Payment|Check/i.test(l.TxnType)).length;
  return { qb_bill_id: String(b.Id), doc_number: b.DocNumber || '', vendor_id: (b.VendorRef && b.VendorRef.value) || '', vendor_name: (b.VendorRef && b.VendorRef.name) || '',
    txn_date: b.TxnDate || null, due_date: b.DueDate || null, total: parseFloat(b.TotalAmt || 0), balance: parseFloat(b.Balance || 0), projects,
    private_note: b.PrivateNote || '', memo: (b.Memo && b.Memo.value) || '', paid_on: paid && payDates ? ((b.MetaData && b.MetaData.LastUpdatedTime) || '').slice(0, 10) || null : null,
    qb_updated_at: (b.MetaData && b.MetaData.LastUpdatedTime) || null, synced_at: now };
}
async function run(reset) {
  const started = Date.now(), now = new Date().toISOString();
  const realm = (await getSetting('QB_REALM_ID')) || process.env.QB_REALM_ID;
  const token = await getAccessToken();
  let cursor = reset ? null : await getSetting('QB_BILL_CURSOR'), synced = 0, hasMore = true;
  while (hasMore && Date.now() - started < TIME_BUDGET_MS) {
    const where = cursor ? ` WHERE MetaData.LastUpdatedTime > '${cursor}'` : '';
    const page = await qbQuery(token, realm, `SELECT * FROM Bill${where} ORDERBY MetaData.LastUpdatedTime ASC MAXRESULTS ${PAGE}`);
    if (!page.length) { hasMore = false; break; }
    await sb('POST', 'qb_bills?on_conflict=qb_bill_id', page.map(b => billRow(b, now)), 'resolution=merge-duplicates,return=minimal');
    synced += page.length;
    cursor = page[page.length - 1].MetaData.LastUpdatedTime; await setSetting('QB_BILL_CURSOR', cursor);
    hasMore = page.length === PAGE;
  }
  return { synced, hasMore, cursor };
}
exports.run = run;
exports.handler = async function (event) {
  const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (!SB_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY' });
  try { return json(200, await run((event.queryStringParameters || {}).reset === '1')); } catch (e) { return json(500, { error: e.message }); }
};
