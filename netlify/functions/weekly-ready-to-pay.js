// netlify/functions/weekly-ready-to-pay.js
// Emails Jason the "Ready to pay" list: every QuickBooks bill Ryan (or Jake) approved for payment that's still unpaid.
// Runs every Sunday night at 8 PM Eastern (netlify.toml), and on demand from the tracker's "Email Jason now" button.
// Sent from Ryan's connected Gmail (Jake's if Ryan's isn't connected). Recipient and CC are set in the tracker.

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const SENDERS = ['ryan@fieldsourceohio.com', 'jake@fieldsourceohio.com'];
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
async function sb(method, path, body, prefer = 'return=representation') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: prefer }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch (e) { return t; }
}
async function setting(key) { const r = await sb('GET', `tracker_settings?key=eq.${key}&select=value`); return r && r[0] ? r[0].value : ''; }
async function gmailToken() {
  for (const email of SENDERS) {
    const rows = await sb('GET', `gmail_tokens?user_email=eq.${encodeURIComponent(email)}&select=refresh_token,google_email`);
    if (!rows || !rows.length) continue;
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: rows[0].refresh_token, grant_type: 'refresh_token' }).toString() });
    const t = await r.json().catch(() => ({}));
    if (t.access_token) return { token: t.access_token, from: rows[0].google_email };
  }
  return null;
}
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

async function buildAndSend(trigger) {
  // Defaults: Jason (accounting@) with Jake and Ali copied; can be changed on the Approve to Pay tab
  const to = (await setting('pay_email_to')).trim() || 'accounting@fieldsourceohio.com';
  const cc = (await setting('pay_email_cc')).trim() || 'jake@fieldsourceohio.com, gibson@fieldsourceohio.com';
  if (!to) return { sent: false, reason: 'No recipient set. Add Jason\'s email on the Approve to Pay tab.' };
  const approvals = (await sb('GET', 'bill_pay_approvals?select=*')) || [];
  if (!approvals.length) return { sent: false, reason: 'Nothing approved for payment yet.' };
  const bills = (await sb('GET', `qb_bills?qb_bill_id=in.(${approvals.map(a => a.qb_bill_id).join(',')})&select=*`)) || [];
  const open = bills.filter(b => Number(b.balance) > 0.005).map(b => ({ ...b, ap: approvals.find(a => a.qb_bill_id === b.qb_bill_id) }))
    .sort((a, b) => (a.vendor_name || '').localeCompare(b.vendor_name || '') || (a.due_date || '').localeCompare(b.due_date || ''));
  if (!open.length) return { sent: false, reason: 'Every approved bill is already paid.' };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const total = open.reduce((t, b) => t + Number(b.balance), 0), fresh = open.filter(b => !b.ap.emailed_at);
  const vendors = [...new Set(open.map(b => b.vendor_name))];
  const td = 'padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;vertical-align:top';
  const rows = vendors.map(v => { const vb = open.filter(b => b.vendor_name === v), vt = vb.reduce((t, b) => t + Number(b.balance), 0);
    return `<tr><td colspan="6" style="padding:10px 8px 4px;font-weight:700;font-size:13px;color:#1e5631">${esc(v)} <span style="font-weight:400;color:#666">· ${money(vt)}</span></td></tr>` +
      vb.map(b => { const late = b.due_date && b.due_date < today;
        return `<tr><td style="${td}">#${esc(b.doc_number)}${!b.ap.emailed_at ? ' <span style="background:#dcfce7;color:#166534;border-radius:8px;padding:0 6px;font-size:11px">new</span>' : ''}</td>
          <td style="${td}">${esc((b.projects || []).join(', '))}</td><td style="${td}">${fmt(b.txn_date)}</td>
          <td style="${td};${late ? 'color:#b91c1c;font-weight:600' : ''}">${fmt(b.due_date)}${late ? ' (past due)' : ''}</td>
          <td style="${td};text-align:right;font-weight:600">${money(b.balance)}</td>
          <td style="${td};color:#666;font-size:12px">${esc(b.ap.approved_name || b.ap.approved_by)} · ${fmt(String(b.ap.approved_at).slice(0, 10))}${b.ap.note ? '<br>' + esc(b.ap.note) : ''}</td></tr>`; }).join(''); }).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:820px">
    <p>Hi Jason,</p><p>Here's the <b>Ready to pay</b> list for this week: ${open.length} bill${open.length === 1 ? '' : 's'} approved for payment, <b>${money(total)}</b> total${fresh.length ? ` (${fresh.length} new since the last email)` : ''}.</p>
    <table style="border-collapse:collapse;width:100%"><thead><tr style="background:#1e5631;color:#fff;text-align:left">
      <th style="padding:7px 8px;font-size:12px">Bill #</th><th style="padding:7px 8px;font-size:12px">Project</th><th style="padding:7px 8px;font-size:12px">Bill date</th><th style="padding:7px 8px;font-size:12px">Due</th><th style="padding:7px 8px;font-size:12px;text-align:right">Amount due</th><th style="padding:7px 8px;font-size:12px">Approved</th></tr></thead>
      <tbody>${rows}<tr><td colspan="4" style="padding:10px 8px;font-weight:700">Total</td><td style="padding:10px 8px;text-align:right;font-weight:700">${money(total)}</td><td></td></tr></tbody></table>
    <p style="font-size:12px;color:#666">Each bill also says "Approved for payment by …" in its QuickBooks memo. Paid bills drop off this list automatically once the payment is recorded in QuickBooks. A spreadsheet copy is attached.</p>
    <p>Thanks,<br>Field Source Tracker</p></div>`;
  const csvQ = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [['Vendor', 'Bill #', 'Project', 'Bill date', 'Due date', 'Amount due', 'Approved by', 'Approved on', 'Note'].map(csvQ).join(','),
    ...open.map(b => [b.vendor_name, b.doc_number, (b.projects || []).join('; '), b.txn_date, b.due_date, Number(b.balance).toFixed(2), b.ap.approved_name || b.ap.approved_by, String(b.ap.approved_at).slice(0, 10), b.ap.note].map(csvQ).join(','))].join('\r\n');
  const g = await gmailToken();
  if (!g) return { sent: false, reason: 'Neither Ryan nor Jake has connected Gmail in the tracker yet.' };
  const boundary = 'rtp_' + Date.now().toString(36), alt = 'alt_' + Date.now().toString(36);
  const subject = `Ready to pay: ${open.length} bill${open.length === 1 ? '' : 's'}, ${money(total)} (${fmt(today)})`;
  const msg = [`From: ${g.from}`, `To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${subject}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', '', `Ready to pay: ${open.length} bills, ${money(total)}. See the attached spreadsheet.`, '',
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(html).toString('base64').replace(/(.{76})/g, '$1\r\n'), '', `--${alt}--`, '',
    `--${boundary}`, `Content-Type: text/csv; name="Ready to pay ${today}.csv"`, `Content-Disposition: attachment; filename="Ready to pay ${today}.csv"`, 'Content-Transfer-Encoding: base64', '',
    Buffer.from('\uFEFF' + csv).toString('base64').replace(/(.{76})/g, '$1\r\n'), '', `--${boundary}--`].join('\r\n');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${g.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: Buffer.from(msg).toString('base64url') }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gmail didn't send it: ${(d.error && d.error.message) || r.status}`);
  const nowIso = new Date().toISOString();
  if (fresh.length) await sb('PATCH', `bill_pay_approvals?qb_bill_id=in.(${fresh.map(b => b.qb_bill_id).join(',')})`, { emailed_at: nowIso }, 'return=minimal');
  await sb('POST', 'tracker_settings?on_conflict=key', { key: 'pay_email_last', value: JSON.stringify({ at: nowIso, to, count: open.length, total, trigger, from: g.from }), updated_at: nowIso }, 'resolution=merge-duplicates,return=minimal');
  return { sent: true, to, from: g.from, count: open.length, total, new: fresh.length };
}

exports.handler = async function (event) {
  if (!SB_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY' });
  try {
    const scheduled = !event.httpMethod || /next_run/.test(event.body || '');
    if (!scheduled) {
      const token = ((event.headers.authorization || event.headers.Authorization || '').match(/^Bearer\s+(.+)$/) || [])[1];
      const u = token ? await (await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } })).json().catch(() => null) : null;
      if (!u || !['ryan@fieldsourceohio.com', 'jake@fieldsourceohio.com', 'gibson@fieldsourceohio.com'].includes(String(u.email).toLowerCase())) return json(403, { error: 'Only Ryan, Jake and Ali can send the Ready to pay email.' });
    }
    return json(200, await buildAndSend(scheduled ? 'weekly' : 'manual'));
  } catch (e) { return json(500, { error: e.message }); }
};
