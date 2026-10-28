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
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve(d); }
      });
    });
    req.on('error', reject);
    if(data) req.write(data);
    req.end();
  });
}

async function getAccessToken() {
  const CLIENT_ID = process.env.QB_CLIENT_ID;
  const CLIENT_SECRET = process.env.QB_CLIENT_SECRET;

  // Get refresh token from Supabase
  const settings = await sbRequest('GET', 'app_settings?key=eq.QB_REFRESH_TOKEN&select=value');
  const refreshToken = settings?.[0]?.value || process.env.QB_REFRESH_TOKEN;
  if(!refreshToken) throw new Error('No QB refresh token found');

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'oauth.platform.intuit.com',
      path: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        const tokens = JSON.parse(d);
        if(tokens.access_token) {
          // Update refresh token if new one provided
          if(tokens.refresh_token && tokens.refresh_token !== refreshToken) {
            sbRequest('POST', 'app_settings', { key: 'QB_REFRESH_TOKEN', value: tokens.refresh_token, updated_at: new Date().toISOString() });
          }
          resolve(tokens.access_token);
        } else {
          reject(new Error('Failed to get access token: ' + JSON.stringify(tokens)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function qbRequest(accessToken, path) {
  const REALM_ID = process.env.QB_REALM_ID;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'quickbooks.api.intuit.com',
      path: `/v3/company/${REALM_ID}/${path}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve(d); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

exports.handler = async function(event) {
  if(event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const accessToken = await getAccessToken();
    const REALM_ID = process.env.QB_REALM_ID;

    // Query QB for estimates
    const query = encodeURIComponent("SELECT * FROM Estimate MAXRESULTS 100");
    const qbData = await qbRequest(accessToken, `query?query=${query}&minorversion=65`);

    const qbEstimates = qbData?.QueryResponse?.Estimate || [];
    let synced = 0, errors = [];

    for(const est of qbEstimates) {
      try {
        const customerName = est.CustomerRef?.name || 'Unknown';
        const total = parseFloat(est.TotalAmt || 0);
        const qbStatus = est.TxnStatus || 'Draft';

        const row = {
          qb_estimate_id: String(est.Id),
          realm_id: REALM_ID,
          customer_id: est.CustomerRef?.value || '',
          customer_name: customerName,
          estimate_number: est.DocNumber || '',
          estimate_date: est.TxnDate || null,
          due_date: est.DueDate || null,
          total,
          qb_status: qbStatus,
          synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        // Upsert estimate
        await sbRequest('POST', 'qb_estimates', row);

        // Get estimate ID from Supabase
        const existing = await sbRequest('GET', `qb_estimates?qb_estimate_id=eq.${est.Id}&select=id,status`);
        const dbId = existing?.[0]?.id;

        if(dbId) {
          // Upsert line items
          const lines = est.Line || [];
          for(let i=0; i<lines.length; i++) {
            const line = lines[i];
            if(line.DetailType === 'SalesItemLineDetail' || line.DetailType === 'DescriptionOnly') {
              await sbRequest('POST', 'qb_estimate_lines', {
                estimate_id: dbId,
                qb_line_id: String(line.Id || i),
                line_number: i + 1,
                description: line.Description || line.SalesItemLineDetail?.ItemRef?.name || '',
                quantity: parseFloat(line.SalesItemLineDetail?.Qty || 1),
                unit_price: parseFloat(line.SalesItemLineDetail?.UnitPrice || 0),
                amount: parseFloat(line.Amount || 0),
                item_type: line.DetailType,
              });
            }
          }
        }
        synced++;
      } catch(e) {
        errors.push({ id: est.Id, error: e.message });
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ synced, total: qbEstimates.length, errors, synced_at: new Date().toISOString() }),
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
