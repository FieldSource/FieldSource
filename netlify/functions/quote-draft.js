// netlify/functions/quote-draft.js
// Quote builder, step 1: turns a plain-English request into a draft quote, pricing each line
// from the QuickBooks product/service list. Also revises an existing draft from an instruction
// ("make the topdressing 60 tons", "add a note about field access").
//
// Rules carried over from Ryan's field-source-client-quote skill:
//  - A price the staff member gives is used exactly. Never invent or adjust a price.
//  - Otherwise the line uses the matching QuickBooks item's price, and says so.
//  - No price found -> left blank and flagged for staff to fill in.
//  - Plain wording, 2-5 scope bullets per line, no payment terms or expiration unless given,
//    discounts as their own negative line, any notes Claude adds are listed for staff to strike.
// Nothing here writes to QuickBooks. Only logged-in tracker users can call it.

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const QB_API = 'https://quickbooks.api.intuit.com';
const MODEL = process.env.QUOTE_MODEL || 'claude-sonnet-4-6';

const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function requireUser(event) {
  const token = ((event.headers || {}).authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}
async function getSetting(key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${key}&select=value`, { headers: sbH });
  const rows = await r.json().catch(() => []);
  return rows && rows[0] ? rows[0].value : null;
}
async function setSetting(key, value) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: 'POST',
    headers: { ...sbH, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}
async function qbAccess() {
  const refresh = await getSetting('QB_REFRESH_TOKEN');
  if (!refresh) throw new Error('QuickBooks is not connected.');
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
  });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error('QuickBooks refused the saved token. A QuickBooks admin needs to reconnect.');
  if (t.refresh_token && t.refresh_token !== refresh) await setSetting('QB_REFRESH_TOKEN', t.refresh_token);
  return t.access_token;
}

// QuickBooks product/service list, cached for 30 minutes in app_settings.
async function qbItems() {
  const cached = await getSetting('QB_ITEMS_CACHE');
  if (cached) {
    try { const c = JSON.parse(cached); if (Date.now() - c.at < 30 * 60 * 1000) return c.items; } catch (e) {}
  }
  const realm = (await getSetting('QB_REALM_ID')) || process.env.QB_REALM_ID;
  const token = await qbAccess();
  const items = [];
  for (let start = 1; start < 3000; start += 1000) {
    const q = encodeURIComponent(`SELECT * FROM Item WHERE Active = true STARTPOSITION ${start} MAXRESULTS 1000`);
    const r = await fetch(`${QB_API}/v3/company/${realm}/query?query=${q}&minorversion=73`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const d = await r.json().catch(() => ({}));
    if (d.Fault) throw new Error('QuickBooks item lookup failed: ' + JSON.stringify(d.Fault).slice(0, 200));
    const page = (d.QueryResponse && d.QueryResponse.Item) || [];
    page.filter(i => i.Type !== 'Category').forEach(i => items.push({
      id: String(i.Id), name: i.FullyQualifiedName || i.Name,
      price: i.UnitPrice != null ? Number(i.UnitPrice) : null,
      desc: String(i.Description || '').replace(/\s+/g, ' ').slice(0, 140),
    }));
    if (page.length < 1000) break;
  }
  await setSetting('QB_ITEMS_CACHE', JSON.stringify({ at: Date.now(), items }));
  return items;
}

const SYSTEM = `You draft customer-facing quotes for Field Source, an Ohio sports field construction, renovation, maintenance and consulting company.

Return ONLY a JSON object, no other text, in exactly this shape:
{"client":"","contact_name":"","contact_title":"","title":"","subtitle":"","service_period":"","intro":"","goal":"",
 "items":[{"title":"","qb_item_id":"","qb_item_name":"","qty":1,"unit_price":null,"price_source":"","bullets":[""]}],
 "notes":[""],"flags":[""]}

PRICING RULES (most important):
- If the staff member states a price for a line, use it exactly and set price_source to "staff".
- Otherwise find the best matching QuickBooks item in the ITEM LIST and use its price exactly; set price_source to "QuickBooks: <item name>".
- If no item matches or the item has no price, set unit_price to null, price_source to "none", and add a flag asking staff for the price.
- Never invent, round, discount, mark up or adjust a price. Never compute a price from other prices.
- Always fill qb_item_id and qb_item_name with the best matching QuickBooks item (by id from the list), even when the staff member gave the price. If nothing fits, leave both empty and flag it.
- qty comes from the request (tons, acres, applications, visits, hours). If a quantity isn't given and can't be read from the request, use 1 and flag it.
- A discount is its own line: the staff member's title, qty 1, negative unit_price, no bullets.

WRITING RULES:
- Plain, direct wording. No marketing language, filler or slogans.
- title: short title for the work. subtitle: "<Client>  |  <field or site>".
- Each line: a short title and 2 to 5 scope bullets saying what Field Source will do, with dates if given.
- intro: one sentence saying what the quote covers. goal: only if the staff member stated one, else "".
- notes: exclusions and assumptions only if the staff member gave them or they follow directly from the scope. Add a flag naming every note you added yourself so staff can strike it.
- Do not add payment terms or an expiration date unless given.
- client: use the organization's proper name; prefer a name from the KNOWN CLIENTS list when it clearly matches.

When given a CURRENT DRAFT and a CHANGE REQUEST, apply only the requested change and return the full revised draft. Keep every price as it is unless the change request explicitly changes it. Clear flags that the change resolves.`;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!SB_KEY || !process.env.ANTHROPIC_API_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY or ANTHROPIC_API_KEY in Netlify' });
  try {
    if (!(await requireUser(event))) return json(401, { error: 'Please log in to the tracker again.' });
    const { request, draft, change, clients } = JSON.parse(event.body || '{}');
    if (!request && !change) return json(400, { error: 'Describe the quote first.' });

    const items = await qbItems();
    const itemList = items.map(i => `${i.id} | ${i.name} | ${i.price == null ? 'no price' : '$' + i.price} | ${i.desc}`).join('\n');
    const user = [
      `ITEM LIST (id | name | price | description):\n${itemList}`,
      `KNOWN CLIENTS: ${(clients || []).slice(0, 200).join(', ')}`,
      `TODAY: ${new Date().toISOString().slice(0, 10)}`,
      draft ? `CURRENT DRAFT:\n${JSON.stringify(draft)}` : '',
      change ? `CHANGE REQUEST:\n${change}` : `STAFF REQUEST:\n${request}`,
    ].filter(Boolean).join('\n\n');

    const headers = { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
    if (process.env.ANTHROPIC_WORKSPACE_ID) headers['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json(502, { error: `Claude error ${r.status}: ${(data.error && data.error.message) || ''}` });
    const text = ((data.content || []).find(b => b.type === 'text') || {}).text || '';
    const m = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!m) return json(502, { error: 'Claude did not return a draft. Try rewording the request.' });
    const out = JSON.parse(m[0]);

    // Guardrail: a QuickBooks-sourced price must equal that item's actual price.
    const byId = new Map(items.map(i => [i.id, i]));
    (out.items || []).forEach(it => {
      const qi = byId.get(String(it.qb_item_id || ''));
      if (it.qb_item_id && !qi) { it.qb_item_id = ''; it.qb_item_name = ''; (out.flags = out.flags || []).push(`"${it.title}": the QuickBooks item it picked doesn't exist. Pick one.`); }
      if (qi) it.qb_item_name = qi.name;
      if (String(it.price_source || '').startsWith('QuickBooks') && qi && qi.price != null && Number(it.unit_price) !== qi.price) {
        it.unit_price = qi.price;
        (out.flags = out.flags || []).push(`"${it.title}": price reset to the QuickBooks price for ${qi.name} ($${qi.price}).`);
      }
    });
    return json(200, { draft: out, items });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
