// netlify/functions/vendor-ai.js
// Claude helps with vendor compliance:
//   POST { action:'recommend', vendor, text, project }  -> which documents this vendor needs (W-9, COI, Ohio BWC) and why
//   POST { action:'read_doc', file_path, kind }          -> reads an uploaded COI / BWC certificate / W-9: dates, insured, additional insured
// A W-9's tax ID number is never returned or stored; only the entity type (for the 1099 question).
const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const MODEL = process.env.QUOTE_MODEL || 'claude-sonnet-4-6';
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

async function claude(content, maxTokens = 900) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
               ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}) },   // same as extract-invoice / quote-draft
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }] }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude error ${r.status}: ${(d.error && d.error.message) || ''}`);
  const text = ((d.content || []).find(x => x.type === 'text') || {}).text || '';
  const m = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not return a readable answer.');
  return JSON.parse(m[0]);
}

const RECOMMEND = `You help Field Source LLC, an Ohio sports field construction, renovation and maintenance company, decide which documents to collect from a vendor before paying them.
Rules of thumb:
- W-9: collect from every vendor Field Source pays, before the first payment (tax ID, and whether a 1099 is needed). Exceptions: government agencies, utilities, and big retail or online stores bought from with a company card (Home Depot, Lowe's, Amazon), where W-9 is not needed.
- COI (certificate of insurance, naming Field Source as additional insured): needed when the vendor performs work on a job site or client property (subcontractors, installers, haulers who dump or spread on site, equipment rentals delivered with an operator or set up on site, surveyors in the field). Not needed for suppliers that only sell or deliver materials, software, office supplies, or professional services done off site (accounting, legal), unless the work happens on site.
- Ohio BWC certificate (state workers' comp): needed when the vendor's employees perform labor for Field Source in Ohio (subcontractors, installers, labor crews). Not for material suppliers, rentals without operators, or out-of-state product shipments.
Use the vendor's name and the invoice text. When unsure, say so and lean toward collecting the document.
Return ONLY JSON: {"category":"Material supplier|Subcontractor|Equipment rental|Professional services|Hauling/trucking|Retail/online|Utility/government|Other",
"needs":{"w9":true,"coi":false,"bwc":false},"reasons":{"w9":"","coi":"","bwc":""},"summary":"one plain sentence","confidence":"high|medium|low"}`;

const READ_DOC = `This is a vendor document sent to Field Source LLC (an Ohio company). Identify it and read it. Return ONLY JSON:
{"doc_type":"coi|bwc|w9|other","insured_name":"","effective_date":"YYYY-MM-DD","expires_on":"YYYY-MM-DD",
"policies":[{"type":"General liability|Auto|Umbrella|Workers comp|Other","policy_no":"","expires":"YYYY-MM-DD","each_occurrence":0}],
"additional_insured_field_source":null,"certificate_holder":"","w9_entity_type":"","w9_signed_date":"YYYY-MM-DD","notes":""}
Rules: copy dates exactly; never guess. For a COI, expires_on is the EARLIEST expiration among its policies, and additional_insured_field_source is true only if Field Source is named as additional insured (or the ADDL INSD box is marked and Field Source is the certificate holder), else false, or null if unclear.
For an Ohio BWC certificate, use its coverage period. For a W-9: give the federal tax classification checked (Individual/sole proprietor, C corporation, S corporation, Partnership, Trust/estate, LLC with its tax letter) and the signature date; NEVER return the SSN or EIN; expires_on is "".
List anything unclear in notes.`;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!SB_KEY || !process.env.ANTHROPIC_API_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_KEY or ANTHROPIC_API_KEY' });
  const tok = ((event.headers.authorization || event.headers.Authorization || '').match(/^Bearer\s+(.+)$/) || [])[1];
  const u = tok ? await (await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${tok}` } })).json().catch(() => null) : null;
  if (!u || !u.email) return json(401, { error: 'Please sign in again.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }
  try {
    if (b.action === 'recommend') {
      const vendor = String(b.vendor || '').slice(0, 200); if (!vendor) throw new Error('No vendor name.');
      const text = String(b.text || '').replace(/\s+/g, ' ').slice(0, 4000);
      const out = await claude([{ type: 'text', text: `${RECOMMEND}\n\nVENDOR: ${vendor}\nJOB: ${String(b.project || '').slice(0, 120)}\nINVOICE TEXT (may be empty):\n${text}` }], 700);
      return json(200, { ok: true, recommendation: out });
    }
    if (b.action === 'read_doc') {
      const path = String(b.file_path || '').replace(/^\/+/, '');
      if (!/^vendors\//.test(path)) throw new Error('That file is not a vendor document.');
      const f = await fetch(`${SUPABASE_URL}/storage/v1/object/project-files/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } });
      if (!f.ok) throw new Error(`Could not open the file (${f.status}).`);
      const buf = Buffer.from(await f.arrayBuffer());
      if (buf.length > 9 * 1024 * 1024) throw new Error('The file is too large to read (over 9 MB).');
      const n = path.toLowerCase();
      const media = n.endsWith('.pdf') ? 'application/pdf' : /\.jpe?g$/.test(n) ? 'image/jpeg' : n.endsWith('.png') ? 'image/png' : null;
      if (!media) throw new Error('Upload a PDF, JPG or PNG so it can be read.');
      const block = media === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: media, data: buf.toString('base64') } }
                                                : { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } };
      const out = await claude([block, { type: 'text', text: READ_DOC + (b.kind ? `\nStaff labeled it: ${b.kind}.` : '') }], 900);
      delete out.tin; delete out.ein; delete out.ssn;
      return json(200, { ok: true, doc: out });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) { console.error('vendor-ai', b && b.action, e.message); return json(500, { error: e.message }); }
};
