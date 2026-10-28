const https = require('https');

const SUPABASE_URL = 'pldlvtlbgxizbppaliag.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsZGx2dGxiZ3hpemJwcGFsaWFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1NzI5NDEsImV4cCI6MjA5MzE0ODk0MX0.uihnFIhsnPWiCg-O9Et7vJOHw_G8OacdDkQ7JNtw8Bg';

async function sbRequest(method, path, body=null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: SUPABASE_URL,
      path: `/rest/v1/${path}`,
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if(data) req.write(data);
    req.end();
  });
}

exports.handler = async function(event) {
  if(event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const { estimateId, reason, details, nextStep, assignedTo, declinedBy } = JSON.parse(event.body);

  try {
    await sbRequest('PATCH', `qb_estimates?id=eq.${estimateId}`, {
      status: 'declined_in_tracker',
      declined_reason: reason,
      declined_details: details || '',
      updated_at: new Date().toISOString(),
    });

    await sbRequest('POST', 'qb_estimate_log', {
      estimate_id: estimateId,
      action: 'declined_in_tracker',
      approved_by: declinedBy || '',
      details: `Reason: ${reason}. Next step: ${nextStep}. Assigned to: ${assignedTo}. Details: ${details}`,
      acted_at: new Date().toISOString(),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ declined: true, estimateId }),
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
