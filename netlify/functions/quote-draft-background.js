// netlify/functions/quote-draft-background.js
// Runs a quote draft (or a quote import) in the background, so long drafts aren't cut off by the
// 10-second limit on normal functions. Netlify answers 202 right away; the result is written to the
// quote_jobs table, and the tracker checks it every couple of seconds.
const draft = require('./quote-draft.js');
const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function save(row) {
  await fetch(`${SUPABASE_URL}/rest/v1/quote_jobs?on_conflict=id`, { method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row) });
}

exports.handler = async function (event) {
  let id = '';
  try { id = String(JSON.parse(event.body || '{}').job_id || ''); } catch (e) {}
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { statusCode: 400 };
  try {
    await save({ id, status: 'working', created_at: new Date().toISOString() });
    const res = await draft.handler({ ...event, httpMethod: 'POST' });
    let payload; try { payload = JSON.parse(res.body); } catch (e) { payload = { error: 'The draft came back unreadable.' }; }
    await save({ id, status: res.statusCode === 200 ? 'done' : 'error', result: payload, error: payload.error || null });
  } catch (e) {
    await save({ id, status: 'error', error: e.message });
  }
  return { statusCode: 202 };
};
