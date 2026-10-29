// netlify/functions/sync-estimates.js
// Receives QuickBooks estimate rows from the Field Source Billing Tracker (Apps Script)
// and upserts them into the Supabase `estimates` table, keyed on qb_estimate_number.
//
// New estimate #s are inserted as full rows.
// Existing ones only get their QuickBooks fields refreshed (amount, client, date, QB status,
// invoiced/unbilled). Status, notes, due date, days, scope, etc. that people edit in the
// tracker are never overwritten - except an estimate that turns Accepted in QuickBooks is
// moved to "Approved" if it's still at a pre-approval status.
//
// Env vars (Netlify > Site settings > Environment variables):
//   SUPABASE_SERVICE_KEY   - Supabase service_role key (required)
//   ESTIMATE_SYNC_SECRET   - shared secret, must match SYNC_SECRET in the Apps Script (required)
//   SUPABASE_URL           - optional, defaults to the Field Source project

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pldlvtlbgxizbppaliag.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SYNC_SECRET = process.env.ESTIMATE_SYNC_SECRET;

const PRE_APPROVAL = ['Not Started', 'Needs Site Visit', 'Needs Shot', 'Estimate In Progress',
  'Estimate Distributed Internally', 'Estimate Sent'];

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function guessType(text) {
  const t = (text || '').toLowerCase();
  if (/consult|feasibility|design|study|review|cost estimating|stakeholder/.test(t)) return 'Consulting';
  if (/plant health|maintenance|aeration|aerification|fertiliz|weed|overseed|topdress|winteriz|infield prep|program/.test(t)) return 'Maintenance';
  return 'Construction';
}

async function sb(method, path, body) {
  const res = await fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!SERVICE_KEY || !SYNC_SECRET) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY or ESTIMATE_SYNC_SECRET env var' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  if (payload.secret !== SYNC_SECRET) return json(401, { error: 'Unauthorized' });

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) return json(200, { inserted: 0, updated: 0, skipped: 0 });

  // Normalize + dedupe by estimate #. Accepted beats Pending if both appear.
  const byNum = new Map();
  for (const r of rows) {
    const num = String(r.estimate_number || '').trim();
    if (!/^\d+$/.test(num)) continue;
    const qbStatus = (r.qb_status || '').trim() || 'Pending';
    const prev = byNum.get(num);
    if (prev && prev.qb_status === 'Accepted' && qbStatus !== 'Accepted') continue;
    byNum.set(num, {
      qb_estimate_number: num,
      client: (r.client || '').trim(),
      job_name: (r.job_name || '').trim(),
      first_line: (r.first_line || '').trim(),
      amount: money(r.amount),
      est_created_date: isoDate(r.estimate_date),
      accepted_date: isoDate(r.accepted_date),
      qb_status: qbStatus,
      invoiced_to_date: money(r.invoiced_to_date),
      unbilled_balance: money(r.unbilled_balance),
      qb_link: /^https?:\/\//.test(String(r.qb_link||'')) ? String(r.qb_link) : null,
      line_items: Array.isArray(r.line_items) ? r.line_items.map(l => ({
        item: String(l.item || '').slice(0, 200),
        description: String(l.description || '').slice(0, 600),
        qty: l.qty === '' || l.qty == null ? null : Number(l.qty),
        rate: money(l.rate),
        value: money(l.value),
        pct: l.pct === '' || l.pct == null ? null : Number(l.pct),
        earned: money(l.earned) || 0,
        notes: String(l.notes || '').slice(0, 300),
      })) : null,
      prior_invoices: Array.isArray(r.prior_invoices) ? r.prior_invoices.map(i => ({
        number: String(i.number || ''),
        date: isoDate(i.date),
        amount: money(i.amount),
        notes: String(i.notes || '').slice(0, 300),
      })) : null,
    });
  }

  // Look up which estimate #s already exist in the tracker.
  const nums = [...byNum.keys()];
  const existing = new Map();
  for (let i = 0; i < nums.length; i += 100) {
    const chunk = nums.slice(i, i + 100).join(',');
    const found = await sb('GET', `/rest/v1/estimates?select=id,qb_estimate_number,status&qb_estimate_number=in.(${chunk})`);
    (found || []).forEach(f => existing.set(String(f.qb_estimate_number), f));
  }

  const now = new Date().toISOString();
  const inserts = [];
  let updated = 0;
  const errors = [];

  for (const [num, r] of byNum) {
    const qbFields = {
      client: r.client,
      amount: r.amount,
      est_created_date: r.est_created_date,
      accepted_date: r.accepted_date,
      qb_status: r.qb_status,
      invoiced_to_date: r.invoiced_to_date,
      unbilled_balance: r.unbilled_balance,
      qb_link: r.qb_link,
      line_items: r.line_items,
      prior_invoices: r.prior_invoices,
      qb_synced_at: now,
    };
    const ex = existing.get(num);
    if (ex) {
      const patch = { ...qbFields };
      if (r.qb_status === 'Accepted' && PRE_APPROVAL.includes(ex.status)) patch.status = 'Approved';
      try { await sb('PATCH', `/rest/v1/estimates?id=eq.${ex.id}`, patch); updated++; }
      catch (e) { errors.push(`#${num}: ${e.message}`); }
    } else {
      const name = r.job_name || [r.client, r.first_line].filter(Boolean).join(' - ');
      inserts.push({
        ...qbFields,
        qb_estimate_number: num,
        project_name: name.slice(0, 140) || `Estimate #${num}`,
        project_date: (r.est_created_date || '').slice(0, 4),
        type: guessType(`${r.job_name} ${r.first_line}`),
        scope: r.job_name ? r.first_line.slice(0, 200) : '',
        status: r.qb_status === 'Accepted' ? 'Approved' : 'Estimate Sent',
        notes: '',
        source: 'quickbooks',
        updated_at: now,
      });
    }
  }

  let inserted = 0;
  for (let i = 0; i < inserts.length; i += 50) {
    try { const res = await sb('POST', '/rest/v1/estimates', inserts.slice(i, i + 50)); inserted += (res || []).length; }
    catch (e) { errors.push(`insert batch ${i / 50 + 1}: ${e.message}`); }
  }

  return json(errors.length ? 207 : 200, {
    received: rows.length, inserted, updated, skipped: rows.length - byNum.size, errors,
  });
};
