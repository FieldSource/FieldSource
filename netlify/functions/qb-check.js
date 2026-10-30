// netlify/functions/qb-check.js
// Open /.netlify/functions/qb-check in a browser to confirm the QuickBooks connection.
// Uses the saved refresh token, saves the new one QuickBooks returns (they rotate),
// and shows the connected company's name and ID. Read-only: changes nothing in QuickBooks.

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

const html = (ok, title, rows) => ({
  statusCode: ok ? 200 : 500,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;line-height:1.5">
<h2 style="color:${ok ? '#15803d' : '#b91c1c'}">${title}</h2>
<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#555">${k}</td><td style="padding:4px 0"><b>${String(v).replace(/</g, '&lt;')}</b></td></tr>`).join('')}</table></body>`,
});

async function getSetting(key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${key}&select=value`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await r.json();
  return rows && rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`Could not save ${key}: ${r.status} ${await r.text()}`);
}

exports.handler = async () => {
  try {
    if (!SB_KEY) return html(false, 'Missing SUPABASE_SERVICE_KEY', []);
    const refresh = await getSetting('QB_REFRESH_TOKEN');
    const realm = await getSetting('QB_REALM_ID');
    if (!refresh || !realm) return html(false, 'QuickBooks is not connected', [['Refresh token', refresh ? 'found' : 'missing'], ['Company ID', realm || 'missing']]);

    const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
    const tr = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
    });
    const tok = await tr.json();
    if (!tok.access_token) return html(false, 'QuickBooks refused the saved token', [['Intuit said', `${tr.status} ${tok.error || ''} ${tok.error_description || ''}`], ['Fix', 'Have Ryan open the qb-connect link again']]);
    if (tok.refresh_token && tok.refresh_token !== refresh) await setSetting('QB_REFRESH_TOKEN', tok.refresh_token);

    const cr = await fetch(`https://quickbooks.api.intuit.com/v3/company/${realm}/companyinfo/${realm}?minorversion=73`, {
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
    });
    const info = await cr.json();
    const c = info.CompanyInfo;
    if (!c) return html(false, 'Connected, but the company lookup failed', [['QuickBooks said', `${cr.status} ${JSON.stringify(info).slice(0, 300)}`]]);

    const envRealm = process.env.QB_REALM_ID;
    return html(true, 'QuickBooks is connected', [
      ['Company', c.CompanyName],
      ['Legal name', c.LegalName || ''],
      ['Company ID', realm],
      ['Netlify QB_REALM_ID', envRealm ? (envRealm === realm ? `${envRealm} (matches)` : `${envRealm} (does NOT match, change it to ${realm})`) : 'not set'],
      ['Environment', 'Production'],
    ]);
  } catch (e) {
    return html(false, 'Check failed', [['Error', e.message]]);
  }
};
