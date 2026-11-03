// netlify/functions/gmail-connect.js
// One-time "Connect Gmail" so the tracker can send invoice emails from your own address.
// Permission requested: gmail.send only (send as you; it cannot read your mail).
//
// Start:  /.netlify/functions/gmail-connect?t=<tracker login token>   (the tracker opens this for you)
// Google sends you back here with ?code=…&state=…; the refresh token is stored in gmail_tokens
// (service-role only; not readable from the browser).
//
// Needs Netlify env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ESTIMATE_SYNC_SECRET, SUPABASE_SERVICE_KEY.

const crypto = require('crypto');
const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const REDIRECT = 'https://fieldsourcetracker.netlify.app/.netlify/functions/gmail-connect';
const ALLOWED = ['jake@fieldsourceohio.com', 'ryan@fieldsourceohio.com', 'gibson@fieldsourceohio.com', 'matt@fieldsourceohio.com', 'haller@fieldsourceohio.com'];
const page = (title, msg, ok) => ({ statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;line-height:1.5">
  <h2 style="color:${ok ? '#166534' : '#991b1b'}">${title}</h2><p>${msg}</p>${ok ? '<p>You can close this tab and go back to the tracker.</p><script>setTimeout(()=>window.close(),2500)</script>' : ''}</body>` });
const sign = obj => { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', process.env.ESTIMATE_SYNC_SECRET || 'x').update(p).digest('base64url'); };
const verify = s => { const [p, sig] = String(s || '').split('.'); if (!p || !sig) return null;
  const good = crypto.createHmac('sha256', process.env.ESTIMATE_SYNC_SECRET || 'x').update(p).digest('base64url');
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o : null; };

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return page('Gmail isn\'t set up yet', 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET need to be added in Netlify (see the setup notes).');
  try {
    // Step 1: from the tracker, with the login token → send to Google
    if (q.t && !q.code) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${q.t}` } });
      const u = r.ok ? await r.json() : null;
      if (!u || !u.email) return page('Please sign in again', 'Your tracker login expired. Refresh the tracker and click Connect Gmail again.');
      if (!ALLOWED.includes(u.email.toLowerCase())) return page('Not available', 'Only Jake, Ryan, Matt, Dan Haller and Ali can send from Gmail through the tracker.');
      const state = sign({ email: u.email.toLowerCase(), exp: Date.now() + 15 * 60 * 1000 });
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', access_type: 'offline', prompt: 'consent',
        scope: 'https://www.googleapis.com/auth/gmail.send openid email', login_hint: u.email, state }).toString();
      return { statusCode: 302, headers: { Location: url }, body: '' };
    }
    // Step 2: back from Google
    if (q.error) return page('Not connected', `Google said: ${q.error}. Nothing was changed.`);
    if (!q.code) return page('Start from the tracker', 'Open an invoice\'s Send screen, choose Gmail, and click Connect Gmail.');
    const st = verify(q.state);
    if (!st) return page('That link expired', 'Go back to the tracker and click Connect Gmail again.');
    const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: q.code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code' }).toString() });
    const tok = await tr.json();
    if (!tok.refresh_token) return page('Not connected', `Google didn't return a long-term permission (${tok.error || 'no refresh token'}). Try Connect Gmail again.`);
    const idEmail = tok.id_token ? JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()).email : '';
    if (idEmail && idEmail.toLowerCase() !== st.email) return page('Wrong Google account', `You signed in to Google as ${idEmail}, but the tracker login is ${st.email}. Connect with ${st.email} so invoices come from the right address.`);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/gmail_tokens?on_conflict=user_email`, { method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_email: st.email, google_email: idEmail || st.email, refresh_token: tok.refresh_token, connected_at: new Date().toISOString() }) });
    if (!r.ok) return page('Not saved', `Couldn't save the connection (${r.status}). Has the gmail_tokens table been created?`);
    return page('Gmail connected ✓', `Invoices you send from the tracker with "Send via Gmail" will come from <b>${idEmail || st.email}</b>.`, true);
  } catch (e) { return page('Something went wrong', e.message); }
};
