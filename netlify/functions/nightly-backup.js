// netlify/functions/nightly-backup.js
// Runs every night (see netlify.toml). Exports every tracker table to CSV and saves them to
// Dropbox at /Field Source Ohio/Tracker Backups/<YYYY-MM-DD>/<table>.csv, plus a summary file.
// Keeps the last 30 nightly folders and deletes older ones.
// Skips app_settings on purpose: it holds the QuickBooks and Dropbox tokens.
// Nothing to do by hand. Uses the service key and the Dropbox connection already in place.

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ROOT = '/Field Source Ohio/Tracker Backups';
const KEEP_DAYS = 30;

const TABLES = [
  'jobs', 'field_reports', 'work_orders', 'estimates', 'materials', 'material_prices',
  'invoice_files', 'invoices_test', 'invoice_approvals_log_test', 'invoice_approval_rules',
  'fleet_loans', 'fuel_transactions', 'direct_costs', 'po_tracker', 'labor_rates',
  'time_off', 'mileage_logs', 'pipeline_projects', 'consulting_projects', 'access_requests',
  'client_profiles', 'qb_estimates', 'qb_estimate_lines', 'qb_estimate_log',
  'tracker_jobs', 'tracker_work_items', 'tracker_visits',
];

const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function getSetting(key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${key}&select=value`, { headers: sbH });
  const rows = await r.json().catch(() => []);
  return rows && rows[0] ? rows[0].value : null;
}

async function dropboxToken() {
  const refresh = await getSetting('DROPBOX_REFRESH_TOKEN');
  if (!refresh) throw new Error('Dropbox is not connected.');
  const creds = Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString('base64');
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
  });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error('Dropbox refused the saved token. Reconnect Dropbox.');
  return t.access_token;
}

async function upload(token, path, text) {
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
    },
    body: Buffer.from(text, 'utf8'),
  });
  if (!r.ok) throw new Error(`Dropbox upload ${path} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

async function dbx(token, endpoint, body) {
  const r = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Dropbox ${endpoint} failed (${r.status}): ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}

async function readTable(table) {
  const rows = [];
  for (let from = 0; from < 200000; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { ...sbH, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    if (r.status === 404 || r.status === 400) return null; // table doesn't exist
    if (!r.ok && r.status !== 206) throw new Error(`${table}: ${r.status} ${(await r.text()).slice(0, 150)}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set())];
  const cell = v => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
}

exports.handler = async function () {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const folder = `${ROOT}/${day}`;
  const summary = [`Field Source Tracker backup - ${day}`, `Started ${new Date().toISOString()}`, ''];
  try {
    if (!SB_KEY) throw new Error('Missing SUPABASE_SERVICE_KEY');
    const token = await dropboxToken();

    for (const t of TABLES) {
      try {
        const rows = await readTable(t);
        if (rows === null) { summary.push(`${t}: not found, skipped`); continue; }
        await upload(token, `${folder}/${t}.csv`, '\uFEFF' + toCsv(rows)); // BOM so Excel reads it as UTF-8
        summary.push(`${t}: ${rows.length} rows`);
      } catch (e) {
        summary.push(`${t}: FAILED - ${e.message}`);
      }
    }

    // Remove nightly folders older than KEEP_DAYS
    try {
      const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
      const list = await dbx(token, 'files/list_folder', { path: ROOT });
      const old = (list.entries || []).filter(e => e['.tag'] === 'folder' && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && e.name < cutoff);
      for (const f of old) { await dbx(token, 'files/delete_v2', { path: f.path_lower }); summary.push(`Removed old backup ${f.name}`); }
    } catch (e) { summary.push(`Cleanup of old backups failed - ${e.message}`); }

    summary.push('', `Finished ${new Date().toISOString()}`);
    await upload(token, `${folder}/_backup-summary.txt`, summary.join('\n'));
    console.log(summary.join('\n'));
    return { statusCode: 200, body: summary.join('\n') };
  } catch (e) {
    console.error('Backup failed:', e.message, '\n', summary.join('\n'));
    return { statusCode: 500, body: e.message };
  }
};
