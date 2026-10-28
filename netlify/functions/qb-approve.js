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
        'Prefer': 'resolution=merge-duplicates,return=representation',
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
  if(event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const {
    estimate_number, job_name, client, site, po_number,
    accepted_date, contract_total, job_type, status,
    pm, pm_email, foreman, billing_contact, billing_email,
    qb_link, billing_tab, notes,
    work_items = [], visits = []
  } = payload;

  if(!estimate_number || !job_name || !client) {
    return { statusCode: 400, body: JSON.stringify({ error: 'estimate_number, job_name, and client are required' }) };
  }

  const errors = [];

  try {
    // 1. Check if job already exists
    const existing = await sbRequest('GET', `tracker_jobs?estimate_number=eq.${estimate_number}&select=estimate_number`);
    if(existing && existing.length > 0) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: `Job ${estimate_number} already exists in tracker`, estimate_number }),
      };
    }

    // 2. Create the job
    await sbRequest('POST', 'tracker_jobs', {
      estimate_number: String(estimate_number),
      job_name,
      client,
      site: site || '',
      po_number: po_number || '',
      accepted_date: accepted_date || null,
      contract_total: Number(contract_total) || 0,
      job_type: job_type || 'Project',
      status: status || 'Scheduled',
      pm: pm || '',
      pm_email: pm_email || '',
      foreman: foreman || '',
      billing_contact: billing_contact || '',
      billing_email: billing_email || '',
      qb_link: qb_link || '',
      billing_tab: billing_tab || '',
      notes: notes || '',
    });

    // 3. Create work items
    for(const wi of work_items) {
      try {
        await sbRequest('POST', 'tracker_work_items', {
          work_item_id: wi.work_item_id,
          estimate_number: String(estimate_number),
          line: wi.line,
          qb_item: wi.qb_item || '',
          description: wi.description || '',
          contract_qty: Number(wi.contract_qty) || 1,
          unit: wi.unit || 'LS',
          rate: Number(wi.rate) || 0,
          contract_value: Number(wi.contract_value) || 0,
          completion_method: wi.completion_method || 'lump_sum',
          milestone: wi.milestone || '',
        });
      } catch(e) { errors.push({ work_item: wi.work_item_id, error: e.message }); }
    }

    // 4. Create visits
    for(const v of visits) {
      try {
        await sbRequest('POST', 'tracker_visits', {
          visit_id: v.visit_id,
          estimate_number: String(estimate_number),
          planned_date: v.planned_date || null,
          target_window: v.target_window || '',
          status: v.status || 'Planned',
          crew: v.crew || '',
          planned: v.planned || [],
          actuals: {},
        });
      } catch(e) { errors.push({ visit: v.visit_id, error: e.message }); }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        estimate_number,
        job_name,
        work_items_created: work_items.length,
        visits_created: visits.length,
        errors: errors.length ? errors : undefined,
      }),
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
