// netlify/functions/extract-invoice.js
// Reads an uploaded invoice PDF with Claude and returns vendor, project, amount, etc.
//
// Security: only logged-in tracker users (stops strangers from running up the
// Anthropic bill). The tracker sends "Authorization: Bearer <login token>".

const https = require('https');

const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function requireUser(event) {
  const auth = (event.headers || {}).authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || !SB_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}

exports.handler = async function(event) {
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }
  if(!(await requireUser(event))){
    return { statusCode: 401, body: JSON.stringify({ error: 'Please log in to the tracker again.' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let fileData, fileType, clientList;
  try {
    const body = JSON.parse(event.body);
    fileData = body.fileData;
    fileType = body.fileType;
    clientList = body.clientList;
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'pdfs-2024-09-25',
  };
  if(workspaceId) headers['anthropic-workspace-id'] = workspaceId;

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } },
        { type: 'text', text: `Extract invoice data. Field Source is the CUSTOMER not the vendor. Return ONLY this JSON with no other text:
{"vendor":"","project":"","amount":0,"invoice_number":"","invoice_date":"YYYY-MM-DD","confidence":"high","notes":""}

amount is the invoice total due. Keep notes to one short sentence, or leave it empty. Match project to one of: ${clientList}` }
      ]
    }]
  });

  headers['Content-Length'] = Buffer.byteLength(requestBody);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Anthropic status:', res.statusCode);
        if(res.statusCode !== 200){
          console.error('Anthropic error:', data.slice(0, 300));
          resolve({ statusCode: 200, body: JSON.stringify({ confidence: 'low', notes: 'Could not read invoice', full_text: '' }) });
          return;
        }
        try {
          const result = JSON.parse(data);
          const textBlock = (result?.content || []).find(b => b.type === 'text');
          const rawText = textBlock?.text || '';
          const clean = rawText.replace(/```json|```/g,'').trim();
          const match = clean.match(/\{[\s\S]*\}/);
          let extracted = null;
          try { if (match) extracted = JSON.parse(match[0]); } catch (e) { /* fall through to salvage */ }
          if (!extracted) {
            // The answer was cut off or malformed: salvage the fields we can read
            const grab = k => { const m = clean.match(new RegExp('"' + k + '"\\s*:\\s*("((?:[^"\\\\]|\\\\.)*)"|-?[\\d.]+)')); return m ? (m[2] !== undefined ? m[2] : Number(m[1])) : undefined; };
            const got = { vendor: grab('vendor'), project: grab('project'), amount: grab('amount'), invoice_number: grab('invoice_number'), invoice_date: grab('invoice_date') };
            const any = Object.values(got).some(v => v !== undefined && v !== '');
            console.error('Unreadable answer (stop: ' + (result && result.stop_reason) + '):', clean.slice(0, 300));
            extracted = any ? { ...Object.fromEntries(Object.entries(got).filter(([, v]) => v !== undefined)), confidence: 'low', notes: 'Partly read: check the amount and date against the invoice' }
                            : { confidence: 'low', notes: 'Could not parse invoice' };
          }
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...extracted, full_text: rawText }),
          });
        } catch(e) {
          console.error('Parse error:', e.message);
          resolve({ statusCode: 200, body: JSON.stringify({ confidence: 'low', notes: 'Could not parse invoice', full_text: '' }) });
        }
      });
    });
    req.on('error', (e) => {
      console.error('Request error:', e.message);
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });
    req.write(requestBody);
    req.end();
  });
};
