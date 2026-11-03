// netlify/functions/qb-invoice-actions.js
// Build invoices from an estimate and email them through QuickBooks, from the tracker.
//
//   POST { action:'prepare', estimate_number }        -> estimate lines (with QuickBooks ids), billed so far, customer email, next invoice #
//   POST { action:'create', estimate_number, lines, txn_date, due_date, doc_number, po, memo }
//                                                     -> creates the invoice in QuickBooks, linked to the estimate (NOT emailed)
//   POST { action:'email_info', qb_invoice_id }       -> who it would go to + QuickBooks' invoice email subject/message
//   POST { action:'send', qb_invoice_id, to, cc }     -> sets the email addresses on the invoice and emails it via QuickBooks
//   POST { action:'pdf', qb_invoice_id }              -> the invoice PDF (base64)
//
// Security: login token required. create and send: Jake, Ryan and Ali only.

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const QB_API = 'https://quickbooks.api.intuit.com';
const BILLERS = ['jake@fieldsourceohio.com', 'ryan@fieldsourceohio.com', 'gibson@fieldsourceohio.com'];
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

async function sb(method, path, body, prefer = 'return=representation') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: prefer }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch (e) { return t; }
}
async function requireUser(event) {
  const token = ((event.headers.authorization || event.headers.Authorization || '').match(/^Bearer\s+(.+)$/) || [])[1];
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null; const u = await r.json(); return u && u.email ? u : null;
}
async function getSetting(key) { const rows = await sb('GET', `app_settings?key=eq.${key}&select=value`); return rows && rows[0] ? rows[0].value : null; }
async function setSetting(key, value) { await sb('POST', 'app_settings?on_conflict=key', { key, value, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal'); }
async function qbAuth() {
  const refreshToken = await getSetting('QB_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('QuickBooks is not connected.');
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', { method: 'POST', headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString() });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error(`QuickBooks refused the saved token (${r.status} ${t.error || ''}).`);
  if (t.refresh_token && t.refresh_token !== refreshToken) await setSetting('QB_REFRESH_TOKEN', t.refresh_token);
  const realm = (await getSetting('QB_REALM_ID')) || process.env.QB_REALM_ID;
  const call = async (path, opts = {}) => {
    const res = await fetch(`${QB_API}/v3/company/${realm}/${path}${path.includes('?') ? '&' : '?'}minorversion=73`, { ...opts, headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (opts.raw) { if (!res.ok) throw new Error(`QuickBooks ${res.status}`); return res; }
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.Fault) { const f = d.Fault && d.Fault.Error && d.Fault.Error[0]; throw new Error(f ? `${f.Message}${f.Detail ? ': ' + f.Detail : ''}` : `QuickBooks ${res.status}`); }
    return d;
  };
  return { call, realm };
}
const money = n => Math.round((Number(n) || 0) * 100) / 100;
async function logActivity(action, user, details) { try { await sb('POST', 'invoice_activity', { action, user_email: user.email, details }, 'return=minimal'); } catch (e) { console.warn('log', e.message); } }
async function refreshInvoice(qb, id) {
  const d = await qb.call(`invoice/${id}`);
  try { await require('./qb-invoice-sync.js').saveBatch([d.Invoice]); } catch (e) { console.warn('save invoice', e.message); }
  return d.Invoice;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!SB_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY' });
  const user = await requireUser(event);
  if (!user) return json(401, { error: 'Please sign in again.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }
  const canBill = BILLERS.includes(String(user.email).toLowerCase());
  if (['create', 'send'].includes(b.action) && !canBill) return json(403, { error: 'Only Jake, Ryan and Ali can create or send invoices.' });

  try {
    const qb = await qbAuth();

    if (b.action === 'prepare') {
      const rows = await sb('GET', `qb_estimates?estimate_number=eq.${encodeURIComponent(b.estimate_number)}&select=qb_estimate_id&limit=1`);
      if (!rows || !rows.length) throw new Error(`Estimate #${b.estimate_number} hasn't synced from QuickBooks yet.`);
      const est = (await qb.call(`estimate/${rows[0].qb_estimate_id}`)).Estimate;
      const cust = (await qb.call(`customer/${est.CustomerRef.value}`)).Customer;
      const lines = (est.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail').map(l => ({
        line_id: String(l.Id), item_id: l.SalesItemLineDetail.ItemRef.value, item_name: l.SalesItemLineDetail.ItemRef.name || '',
        description: l.Description || '', qty: Number(l.SalesItemLineDetail.Qty || 0), rate: Number(l.SalesItemLineDetail.UnitPrice || 0), amount: Number(l.Amount || 0),
      }));
      const nums = await sb('GET', `qb_invoices?select=doc_number&order=txn_date.desc&limit=400`);
      const maxNum = (nums || []).map(r => parseInt(r.doc_number, 10)).filter(n => !isNaN(n)).reduce((m, n) => Math.max(m, n), 0);
      return json(200, { estimate: { qb_id: String(est.Id), number: est.DocNumber, customer_id: est.CustomerRef.value, customer: est.CustomerRef.name, total: Number(est.TotalAmt || 0) },
        lines, bill_email: (est.BillEmail && est.BillEmail.Address) || (cust.PrimaryEmailAddr && cust.PrimaryEmailAddr.Address) || '',
        terms: (cust.SalesTermRef && cust.SalesTermRef.name) || '', next_doc_number: maxNum ? String(maxNum + 1) : '', can_bill: canBill });
    }

    if (b.action === 'create') {
      const rows = await sb('GET', `qb_estimates?estimate_number=eq.${encodeURIComponent(b.estimate_number)}&select=qb_estimate_id&limit=1`);
      if (!rows || !rows.length) throw new Error('Estimate not found.');
      const est = (await qb.call(`estimate/${rows[0].qb_estimate_id}`)).Estimate;
      const byId = {}; (est.Line || []).forEach(l => { if (l.DetailType === 'SalesItemLineDetail') byId[String(l.Id)] = l; });
      const lines = (b.lines || []).filter(l => money(l.amount) !== 0).map(l => {
        const src = byId[String(l.line_id)]; if (!src) throw new Error('An estimate line changed in QuickBooks. Close and reopen the invoice builder.');
        const d = src.SalesItemLineDetail, detail = { ItemRef: d.ItemRef };
        if (d.TaxCodeRef) detail.TaxCodeRef = d.TaxCodeRef;
        if (l.qty != null && l.qty !== '' && Number(l.qty) && d.UnitPrice) { detail.Qty = Number(l.qty); detail.UnitPrice = Number(d.UnitPrice); }
        return { DetailType: 'SalesItemLineDetail', Amount: money(l.amount), Description: l.description != null ? String(l.description) : (src.Description || ''), SalesItemLineDetail: detail };
      });
      if (!lines.length) throw new Error('Nothing to bill: every line is $0.');
      const inv = { CustomerRef: est.CustomerRef, Line: lines, LinkedTxn: [{ TxnId: String(est.Id), TxnType: 'Estimate' }] };
      if (b.txn_date) inv.TxnDate = b.txn_date;
      if (b.due_date) inv.DueDate = b.due_date;
      if (b.doc_number) inv.DocNumber = String(b.doc_number).slice(0, 21);
      if (b.memo) inv.CustomerMemo = { value: String(b.memo).slice(0, 1000) };
      inv.PrivateNote = `Created in Field Source Tracker by ${user.email} from estimate #${est.DocNumber}${b.po ? ' · PO ' + b.po : ''}`;
      if (est.BillEmail) inv.BillEmail = est.BillEmail;
      if (est.BillAddr) inv.BillAddr = est.BillAddr;
      if (est.ShipAddr) inv.ShipAddr = est.ShipAddr;
      const created = (await qb.call('invoice', { method: 'POST', body: JSON.stringify(inv) })).Invoice;
      await refreshInvoice(qb, created.Id);
      await logActivity('created', user, { qb_invoice_id: String(created.Id), doc_number: created.DocNumber, estimate_number: est.DocNumber, total: created.TotalAmt });
      return json(200, { ok: true, qb_invoice_id: String(created.Id), doc_number: created.DocNumber, total: Number(created.TotalAmt || 0) });
    }

    if (b.action === 'email_info') {
      const inv = (await qb.call(`invoice/${b.qb_invoice_id}`)).Invoice;
      let to = (inv.BillEmail && inv.BillEmail.Address) || '';
      if (!to) { try { const c = (await qb.call(`customer/${inv.CustomerRef.value}`)).Customer; to = (c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address) || ''; } catch (e) {} }
      let subject = '', message = '';
      try {
        const p = (await qb.call('preferences')).Preferences;
        const m = p && p.EmailMessagesPrefs && p.EmailMessagesPrefs.InvoiceMessage;
        subject = (m && m.Subject) || ''; message = (m && m.Message) || '';
      } catch (e) {}
      return json(200, { doc_number: inv.DocNumber, customer: inv.CustomerRef.name, total: Number(inv.TotalAmt || 0), balance: Number(inv.Balance || 0),
        due_date: inv.DueDate || '', email_status: inv.EmailStatus || '', last_sent: (inv.DeliveryInfo && inv.DeliveryInfo.DeliveryTime) || '',
        to, cc: (inv.BillEmailCc && inv.BillEmailCc.Address) || '', bcc: (inv.BillEmailBcc && inv.BillEmailBcc.Address) || '',
        subject, message, memo: (inv.CustomerMemo && inv.CustomerMemo.value) || '', can_send: canBill });
    }

    if (b.action === 'send') {
      const to = String(b.to || '').trim(), cc = String(b.cc || '').trim();
      const ok = e => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e);
      const toList = to.split(/[,;]\s*/).filter(Boolean), ccList = cc.split(/[,;]\s*/).filter(Boolean);
      if (!toList.length || !toList.every(ok)) throw new Error('Check the To email address.');
      if (ccList.length && !ccList.every(ok)) throw new Error('Check the CC email address.');
      const cur = (await qb.call(`invoice/${b.qb_invoice_id}`)).Invoice;
      const upd = { Id: cur.Id, SyncToken: cur.SyncToken, sparse: true, BillEmail: { Address: toList.join(', ') } };
      if (ccList.length || (cur.BillEmailCc && cur.BillEmailCc.Address)) upd.BillEmailCc = { Address: ccList.join(', ') };
      if (typeof b.memo === 'string') upd.CustomerMemo = { value: b.memo.slice(0, 1000) };
      await qb.call('invoice', { method: 'POST', body: JSON.stringify(upd) });
      await qb.call(`invoice/${cur.Id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } });
      const inv = await refreshInvoice(qb, cur.Id);
      await logActivity(b.reminder ? 'reminder' : 'sent', user, { qb_invoice_id: String(cur.Id), doc_number: cur.DocNumber, to: toList.join(', '), cc: ccList.join(', ') });
      return json(200, { ok: true, email_status: inv.EmailStatus || 'EmailSent', sent_to: toList.join(', ') });
    }

    if (b.action === 'pdf') {
      const res = await qb.call(`invoice/${b.qb_invoice_id}/pdf`, { raw: true, headers: { Accept: 'application/pdf' } });
      return json(200, { pdf: Buffer.from(await res.arrayBuffer()).toString('base64') });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
