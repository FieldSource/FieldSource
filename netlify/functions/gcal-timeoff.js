// netlify/functions/gcal-timeoff.js
// Keeps the shared "Time off" Google Calendar in step with the tracker's Time Off list.
//   POST { action:'sync', id }     -> approved: add/update an all-day event; pending/denied: remove it
//   POST { action:'delete', id }   -> remove the event (called just before a time-off entry is deleted)
//   POST { action:'backfill' }     -> sync every approved time off that hasn't ended yet (Jake/Ryan/Matt)
// Writes as a Google service account the calendar is shared with (no one's personal login).
// Netlify env: GOOGLE_SA_EMAIL, GOOGLE_SA_KEY (the private key from the service account's JSON key),
//              optional GCAL_TIMEOFF_ID (defaults to the Field Source time-off calendar).

const crypto = require('crypto');
const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const CAL_ID = process.env.GCAL_TIMEOFF_ID || 'c_44886072bc4a1c429a51eec90eeace9a842b06cd1548af13e386529cd9080c4a@group.calendar.google.com';
const ADMINS = ['jake@fieldsourceohio.com', 'ryan@fieldsourceohio.com', 'matt@fieldsourceohio.com'];
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

async function sb(method, path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch (e) { return t; }
}
async function googleToken() {
  const email = process.env.GOOGLE_SA_EMAIL, key = String(process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key.includes('PRIVATE KEY')) throw new Error('Google Calendar isn\'t set up yet (GOOGLE_SA_EMAIL / GOOGLE_SA_KEY missing in Netlify).');
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: email, scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }).toString() });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error(`Google refused the service account (${t.error || r.status}: ${t.error_description || ''}).`);
  return t.access_token;
}
async function cal(token, method, path, body) {
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL_ID)}/events${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (method === 'DELETE') { if (r.ok || r.status === 404 || r.status === 410) return null; }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const msg = (d.error && d.error.message) || r.status; throw new Error(r.status === 404 && method !== 'DELETE' ? `Calendar not found or not shared with the service account (${msg}).` : `Google Calendar: ${msg}`); }
  return d;
}
const nextDay = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

async function syncOne(token, row) {
  if (!row) return { skipped: true };
  if (row.status === 'Approved' && row.start_date && row.end_date) {
    const ev = { summary: `${row.person} Off`, description: 'Approved time off · Field Source Tracker',
      start: { date: row.start_date }, end: { date: nextDay(row.end_date) },           // Google's all-day end date is the day after
      transparency: 'transparent', extendedProperties: { private: { tracker_time_off_id: String(row.id) } } };
    if (row.gcal_event_id) {
      try { await cal(token, 'PUT', `/${encodeURIComponent(row.gcal_event_id)}`, ev); return { updated: true }; }
      catch (e) { if (!/not found|404|410/i.test(e.message)) throw e; }               // event deleted in Google: create it again
    }
    // Already on the calendar (added by hand)? Take that event over instead of making a duplicate.
    const name = String(row.person || '').trim().toLowerCase();
    const found = await cal(token, 'GET', `?singleEvents=true&timeMin=${row.start_date}T00:00:00Z&timeMax=${nextDay(row.end_date)}T23:59:59Z&maxResults=250`);
    const same = ((found && found.items) || []).find(e => e.start && e.start.date === row.start_date && e.end && e.end.date === nextDay(row.end_date)
      && String(e.summary || '').trim().toLowerCase().replace(/\s+/g, ' ') === `${name} off`);
    if (same) {
      await cal(token, 'PATCH', `/${encodeURIComponent(same.id)}`, { extendedProperties: { private: { tracker_time_off_id: String(row.id) } } });
      await sb('PATCH', `time_off?id=eq.${row.id}`, { gcal_event_id: same.id });
      return { adopted: true };
    }
    const created = await cal(token, 'POST', '', ev);
    await sb('PATCH', `time_off?id=eq.${row.id}`, { gcal_event_id: created.id });
    return { created: true };
  }
  if (row.gcal_event_id) { await cal(token, 'DELETE', `/${encodeURIComponent(row.gcal_event_id)}`); await sb('PATCH', `time_off?id=eq.${row.id}`, { gcal_event_id: null }); return { removed: true }; }
  return { skipped: true };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!SB_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY' });
  const tok = ((event.headers.authorization || event.headers.Authorization || '').match(/^Bearer\s+(.+)$/) || [])[1];
  const u = tok ? await (await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${tok}` } })).json().catch(() => null) : null;
  if (!u || !u.email) return json(401, { error: 'Please sign in again.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }
  try {
    const token = await googleToken();
    if (b.action === 'backfill') {
      if (!ADMINS.includes(String(u.email).toLowerCase())) return json(403, { error: 'Only Jake, Ryan and Matt can do this.' });
      const today = new Date().toISOString().slice(0, 10);
      const rows = (await sb('GET', `time_off?end_date=gte.${today}&select=*`)) || [];
      let created = 0, updated = 0, removed = 0, adopted = 0;
      for (const r of rows) { const x = await syncOne(token, r); created += x.created ? 1 : 0; updated += x.updated ? 1 : 0; removed += x.removed ? 1 : 0; adopted += x.adopted ? 1 : 0; }
      return json(200, { ok: true, checked: rows.length, created, updated, removed, adopted });
    }
    const rows = await sb('GET', `time_off?id=eq.${encodeURIComponent(b.id)}&select=*`);
    const row = rows && rows[0];
    if (b.action === 'delete') { if (row && row.gcal_event_id) await cal(token, 'DELETE', `/${encodeURIComponent(row.gcal_event_id)}`); return json(200, { ok: true }); }
    return json(200, { ok: true, ...(await syncOne(token, row)) });
  } catch (e) { return json(500, { error: e.message }); }
};
