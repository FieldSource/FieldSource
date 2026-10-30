// netlify/functions/qb-sync.js
// Pulls QuickBooks estimates (and their line items) into Supabase:
//   qb_estimates       one row per QuickBooks estimate (matched on qb_estimate_id)
//   qb_estimate_lines  line items, replaced fresh for each estimate that changed
//
// Incremental: only estimates changed since the last sync are pulled, oldest change first,
// and the position is saved in app_settings (QB_SYNC_CURSOR). Each run works for ~8 seconds;
// if more remain it returns hasMore: true, so just call it again until hasMore is false.
// The very first run walks through all estimates over several calls.
//
// Never overwrites the `status` column on qb_estimates (the tracker's own approval status).
// Saves the new refresh token QuickBooks returns on every run, so the connection stays alive.
//
// Optional: ?reset=1 starts over from the beginning (re-pulls every estimate).

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const QB_API = 'https://quickbooks.api.intuit.com';
const PAGE = 100;
const TIME_BUDGET_MS = 8000;

async function sb(method, path, body, prefer = 'return=representation') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${r.status}: ${text.slice(0, 300)}`);
  try { return text ? JSON.parse(text) : null; } catch (e) { return text; }
}

async function getSetting(key) {
  const rows = await sb('GET', `app_settings?key=eq.${key}&select=value`);
  return rows && rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await sb('POST', 'app_settings?on_conflict=key',
    { key, value, updated_at: new Date().toISOString() },
    'resolution=merge-duplicates,return=minimal');
}

async function getAccessToken() {
  const refreshToken = (await getSetting('QB_REFRESH_TOKEN')) || process.env.QB_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('QuickBooks is not connected (no refresh token). Open /.netlify/functions/qb-connect as a QuickBooks admin.');

  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  const tokens = await r.json().catch(() => ({}));
  if (!tokens.access_token) {
    throw new Error(`QuickBooks refused the saved token (${r.status} ${tokens.error || ''}). Have a QuickBooks admin open /.netlify/functions/qb-connect again.`);
  }
  // QuickBooks rotates refresh tokens. Save the new one BEFORE doing anything else.
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    await setSetting('QB_REFRESH_TOKEN', tokens.refresh_token);
  }
  return tokens.access_token;
}

async function qbQuery(accessToken, realmId, sql) {
  const r = await fetch(`${QB_API}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=73`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.Fault) {
    const f = data.Fault && data.Fault.Error && data.Fault.Error[0];
    throw new Error(`QuickBooks query failed (${r.status}): ${f ? `${f.Message} - ${f.Detail || ''}` : JSON.stringify(data).slice(0, 300)}`);
  }
  return (data.QueryResponse && data.QueryResponse.Estimate) || [];
}

function estimateRow(est, realmId, now) {
  return {
    qb_estimate_id: String(est.Id),
    realm_id: realmId,
    customer_id: (est.CustomerRef && est.CustomerRef.value) || '',
    customer_name: (est.CustomerRef && est.CustomerRef.name) || 'Unknown',
    estimate_number: est.DocNumber || '',
    estimate_date: est.TxnDate || null,
    due_date: est.DueDate || null,
    total: parseFloat(est.TotalAmt || 0),
    qb_status: est.TxnStatus || 'Draft',
    synced_at: now,
    updated_at: now,
  };
}

function lineRows(est, dbId) {
  const out = [];
  (est.Line || []).forEach((line, i) => {
    if (line.DetailType !== 'SalesItemLineDetail' && line.DetailType !== 'DescriptionOnly') return;
    const d = line.SalesItemLineDetail || {};
    out.push({
      estimate_id: dbId,
      qb_line_id: String(line.Id || i),
      line_number: i + 1,
      description: line.Description || (d.ItemRef && d.ItemRef.name) || '',
      quantity: parseFloat(d.Qty || 1),
      unit_price: parseFloat(d.UnitPrice || 0),
      amount: parseFloat(line.Amount || 0),
      item_type: line.DetailType,
    });
  });
  return out;
}

async function saveBatch(estimates, realmId) {
  const now = new Date().toISOString();
  const ids = estimates.map(e => String(e.Id));

  // Which of these already exist?
  const existing = await sb('GET', `qb_estimates?qb_estimate_id=in.(${ids.join(',')})&select=id,qb_estimate_id`);
  const dbIdByQb = new Map((existing || []).map(r => [String(r.qb_estimate_id), r.id]));

  // Update existing ones (QuickBooks fields only, never `status`), insert new ones in bulk.
  const updates = estimates.filter(e => dbIdByQb.has(String(e.Id)));
  const inserts = estimates.filter(e => !dbIdByQb.has(String(e.Id)));
  await Promise.all(updates.map(e =>
    sb('PATCH', `qb_estimates?id=eq.${dbIdByQb.get(String(e.Id))}`, estimateRow(e, realmId, now), 'return=minimal')));
  if (inserts.length) {
    const created = await sb('POST', 'qb_estimates', inserts.map(e => estimateRow(e, realmId, now)));
    (created || []).forEach(r => dbIdByQb.set(String(r.qb_estimate_id), r.id));
  }

  // Replace line items for every estimate in this batch.
  const dbIds = estimates.map(e => dbIdByQb.get(String(e.Id))).filter(Boolean);
  if (dbIds.length) {
    await sb('DELETE', `qb_estimate_lines?estimate_id=in.(${dbIds.join(',')})`, null, 'return=minimal');
    const lines = estimates.flatMap(e => {
      const id = dbIdByQb.get(String(e.Id));
      return id ? lineRows(e, id) : [];
    });
    for (let i = 0; i < lines.length; i += 500) {
      await sb('POST', 'qb_estimate_lines', lines.slice(i, i + 500), 'return=minimal');
    }
  }
  return { updated: updates.length, inserted: inserts.length };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  const started = Date.now();
  const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  try {
    const q = event.queryStringParameters || {};
    const realmId = (await getSetting('QB_REALM_ID')) || process.env.QB_REALM_ID;
    if (!realmId) throw new Error('No QuickBooks company ID (QB_REALM_ID) found.');

    const accessToken = await getAccessToken();

    let cursor = q.reset === '1' ? null : await getSetting('QB_SYNC_CURSOR');
    let synced = 0, inserted = 0, updated = 0, hasMore = true;

    while (hasMore && Date.now() - started < TIME_BUDGET_MS) {
      const where = cursor ? ` WHERE MetaData.LastUpdatedTime > '${cursor}'` : '';
      const page = await qbQuery(accessToken, realmId,
        `SELECT * FROM Estimate${where} ORDERBY MetaData.LastUpdatedTime ASC MAXRESULTS ${PAGE}`);
      if (!page.length) { hasMore = false; break; }

      const res = await saveBatch(page, realmId);
      synced += page.length; inserted += res.inserted; updated += res.updated;

      cursor = page[page.length - 1].MetaData.LastUpdatedTime;
      await setSetting('QB_SYNC_CURSOR', cursor);
      hasMore = page.length === PAGE;
    }

    await setSetting('QB_LAST_SYNC_AT', new Date().toISOString());
    return json(200, { synced, inserted, updated, hasMore, cursor, errors: [], synced_at: new Date().toISOString() });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
