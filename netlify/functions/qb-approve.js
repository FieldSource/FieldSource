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
      res.on('data', chunk => data => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if(data) req.write(data);
    req.end();
  });
}

exports.handler = async function(event) {
  if(event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const { estimateId, qbEstimateId, customerName, total, notes, approvedBy } = JSON.parse(event.body);

  try {
    // Update estimate status
    await sbRequest('PATCH', `qb_estimates?id=eq.${estimateId}`, {
      status: 'accepted_in_tracker',
      updated_at: new Date().toISOString(),
    });

    // Create job in tracker
    const jobRow = {
      client: customerName,
      po_amount: total,
      po_created_date: new Date().toISOString().split('T')[0],
      status: 'approved',
      field: customerName,
      service: 'Construction',
      startDate: new Date().toISOString().split('T')[0],
      duration: 1,
      crew: [],
      equip: [],
      notes: notes || '',
      createdBy: approvedBy || '',
    };
    const newJob = await sbRequest('POST', 'jobs', jobRow);

    // Log it
    await sbRequest('POST', 'qb_estimate_log', {
      estimate_id: estimateId,
      action: 'approved_in_tracker',
      approved_by: approvedBy || '',
      details: notes || '',
      acted_at: new Date().toISOString(),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ approved: true, estimateId, jobCreated: true }),
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
