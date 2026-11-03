// netlify/functions/qb-invoice-sync.js
// Pulls QuickBooks invoices (with lines, balances, and the estimates they were created from) into Supabase.
// Incremental like qb-sync: only invoices changed since the last run (cursor QB_INV_CURSOR). Recording a payment
// in QuickBooks changes the invoice's balance, so payments show up on the next run.
// Runs hourly from qb-sync-hourly.js. Open in a browser for a manual run; ?reset=1 re-pulls everything.

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const QB_API = 'https://quickbooks.api.intuit.com';
const PAGE = 200, TIME_BUDGET_MS = 8000;

async function sb(method, path, body, prefer = 'return=representation') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: prefer },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${r.status}: ${text.slice(0, 300)}`);
  try { return text ? JSON.parse(text) : null; } catch (e) { return text; }
}
async function getSetting(key) { const rows = await sb('GET', `app_settings?key=eq.${key}&select=value`); return rows && rows[0] ? rows[0].value : null; }
async function setSetting(key, value) { await sb('POST', 'app_settings?on_conflict=key', { key, value, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal'); }

async function getAccessToken() {
  const refreshToken = await getSetting('QB_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('QuickBooks is not connected.');
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST', headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error(`QuickBooks refused the saved token (${r.status} ${t.error || ''}).`);
  if (t.refresh_token && t.refresh_token !== refreshToken) await setSetting('QB_REFRESH_TOKEN', t.refresh_token);
  return t.access_token;
}
async function qbQuery(token, realm, sql) {
  const r = await fetch(`${QB_API}/v3/company/${realm}/query?query=${encodeURIComponent(sql)}&minorversion=73`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.Fault) { const f = d.Fault && d.Fault.Error && d.Fault.Error[0]; throw new Error(`QuickBooks query failed (${r.status}): ${f ? f.Message + ' - ' + (f.Detail || '') : ''}`); }
  return (d.QueryResponse && d.QueryResponse.Invoice) || [];
}

// Most invoices aren't created "from" an estimate in QuickBooks, so they carry no link. Match those the way
// the Billing Tracker does: same customer, an accepted estimate dated on/before the invoice, and (when the
// customer has several) the estimate whose lines best match the invoice's lines.
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
async function autoMatch(invoices) {
  const need = invoices.filter(inv => !(inv.LinkedTxn || []).some(l => l.TxnType === 'Estimate') && inv.CustomerRef && inv.CustomerRef.value);
  const result = {};
  if (!need.length) return result;
  const custIds = [...new Set(need.map(inv => String(inv.CustomerRef.value)))];
  const ests = [];
  for (let i = 0; i < custIds.length; i += 50) {
    const rows = await sb('GET', `qb_estimates?customer_id=in.(${custIds.slice(i, i + 50).join(',')})&qb_status=in.(Accepted,Closed)&select=id,customer_id,estimate_number,estimate_date,total`);
    ests.push(...(rows || []));
  }
  const linesByEst = {};
  for (let i = 0; i < ests.length; i += 100) {
    const rows = await sb('GET', `qb_estimate_lines?estimate_id=in.(${ests.slice(i, i + 100).map(e => e.id).join(',')})&select=estimate_id,item_name,description`);
    (rows || []).forEach(l => { (linesByEst[l.estimate_id] = linesByEst[l.estimate_id] || []).push(l); });
  }
  need.forEach(inv => {
    const cands = ests.filter(e => String(e.customer_id) === String(inv.CustomerRef.value) && (!e.estimate_date || !inv.TxnDate || e.estimate_date <= inv.TxnDate));
    if (!cands.length) return;
    if (cands.length === 1) { result[inv.Id] = { nums: [cands[0].estimate_number], how: 'only accepted estimate for this customer' }; return; }
    const ilines = (inv.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail').map(l => ({ item: norm(l.SalesItemLineDetail && l.SalesItemLineDetail.ItemRef && l.SalesItemLineDetail.ItemRef.name), desc: norm(l.Description) }));
    const score = e => ilines.reduce((t, il) => {
      const el = linesByEst[e.id] || [];
      if (el.some(x => norm(x.item_name) === il.item && il.item && norm(x.description) === il.desc && il.desc)) return t + 3;
      if (el.some(x => il.desc && norm(x.description) === il.desc)) return t + 2;
      if (el.some(x => il.item && norm(x.item_name) === il.item)) return t + 1;
      return t;
    }, 0);
    const ranked = cands.map(e => ({ e, s: score(e) })).sort((a, b) => b.s - a.s);
    if (ranked[0].s > 0 && ranked[0].s > (ranked[1] ? ranked[1].s : 0)) result[inv.Id] = { nums: [ranked[0].e.estimate_number], how: 'matched by line items' };
  });
  return result;
}

async function saveBatch(invoices) {
  const now = new Date().toISOString();
  // Map linked QuickBooks estimate Ids to estimate numbers
  const estIds = [...new Set(invoices.flatMap(inv => (inv.LinkedTxn || []).filter(l => l.TxnType === 'Estimate').map(l => String(l.TxnId))))];
  const numById = {};
  for (let i = 0; i < estIds.length; i += 100) {
    const rows = await sb('GET', `qb_estimates?qb_estimate_id=in.(${estIds.slice(i, i + 100).join(',')})&select=qb_estimate_id,estimate_number`);
    (rows || []).forEach(r => { numById[String(r.qb_estimate_id)] = r.estimate_number; });
  }
  const auto = await autoMatch(invoices);
  const rows = invoices.map(inv => {
    const linked = (inv.LinkedTxn || []).filter(l => l.TxnType === 'Estimate').map(l => String(l.TxnId));
    const am = auto[inv.Id];
    return {
      qb_invoice_id: String(inv.Id), doc_number: inv.DocNumber || '',
      customer_id: (inv.CustomerRef && inv.CustomerRef.value) || '', customer_name: (inv.CustomerRef && inv.CustomerRef.name) || '',
      txn_date: inv.TxnDate || null, due_date: inv.DueDate || null,
      total: parseFloat(inv.TotalAmt || 0), balance: parseFloat(inv.Balance || 0),
      linked_estimate_qb_ids: linked, linked_estimate_numbers: linked.map(id => numById[id]).filter(Boolean),
      memo: (inv.CustomerMemo && inv.CustomerMemo.value) || '', private_note: inv.PrivateNote || '',
      email_status: inv.EmailStatus || '', qb_updated_at: (inv.MetaData && inv.MetaData.LastUpdatedTime) || null, synced_at: now,
      auto_estimate_numbers: am ? am.nums : [], auto_match: am ? am.how : '',
    };
  });
  await sb('POST', 'qb_invoices?on_conflict=qb_invoice_id', rows, 'resolution=merge-duplicates,return=minimal');
  const ids = rows.map(r => r.qb_invoice_id);
  await sb('DELETE', `qb_invoice_lines?qb_invoice_id=in.(${ids.join(',')})`, null, 'return=minimal');
  const lines = [];
  invoices.forEach(inv => (inv.Line || []).forEach((l, i) => {
    if (l.DetailType !== 'SalesItemLineDetail' && l.DetailType !== 'DescriptionOnly') return;
    const d = l.SalesItemLineDetail || {};
    lines.push({ qb_invoice_id: String(inv.Id), line_number: i + 1, item_name: (d.ItemRef && d.ItemRef.name) || '', description: l.Description || '',
      quantity: d.Qty != null ? parseFloat(d.Qty) : null, unit_price: d.UnitPrice != null ? parseFloat(d.UnitPrice) : null, amount: parseFloat(l.Amount || 0) });
  }));
  for (let i = 0; i < lines.length; i += 500) await sb('POST', 'qb_invoice_lines', lines.slice(i, i + 500), 'return=minimal');
  return rows.length;
}

async function run(reset) {
  const started = Date.now();
  const realm = (await getSetting('QB_REALM_ID')) || process.env.QB_REALM_ID;
  const token = await getAccessToken();
  let cursor = reset ? null : await getSetting('QB_INV_CURSOR');
  let synced = 0, hasMore = true;
  while (hasMore && Date.now() - started < TIME_BUDGET_MS) {
    const where = cursor ? ` WHERE MetaData.LastUpdatedTime > '${cursor}'` : '';
    const page = await qbQuery(token, realm, `SELECT * FROM Invoice${where} ORDERBY MetaData.LastUpdatedTime ASC MAXRESULTS ${PAGE}`);
    if (!page.length) { hasMore = false; break; }
    synced += await saveBatch(page);
    cursor = page[page.length - 1].MetaData.LastUpdatedTime;
    await setSetting('QB_INV_CURSOR', cursor);
    hasMore = page.length === PAGE;
  }
  return { synced, hasMore, cursor };
}
exports.run = run;
exports.saveBatch = saveBatch;
exports.handler = async function (event) {
  const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (!SB_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY' });
  try { return json(200, await run((event.queryStringParameters || {}).reset === '1')); }
  catch (e) { return json(500, { error: e.message }); }
};
