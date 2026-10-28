const https = require('https');

// QB OAuth endpoints
const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

exports.handler = async function(event) {
  const { action, code, state } = event.queryStringParameters || {};
  const CLIENT_ID = process.env.QB_CLIENT_ID;
  const CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
  const REDIRECT_URI = 'https://fieldsourcetracker.netlify.app/.netlify/functions/qb-connect';

  // Step 1: Redirect to QB OAuth
  if(action === 'auth' || !action) {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      state: 'tracker_oauth',
    });
    return {
      statusCode: 302,
      headers: { Location: `${QB_AUTH_URL}?${params.toString()}` },
      body: '',
    };
  }

  // Step 2: Handle callback with code
  if(code) {
    try {
      const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }).toString();

      const result = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'oauth.platform.intuit.com',
          path: '/oauth2/v1/tokens/bearer',
          method: 'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          }
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      const tokens = JSON.parse(result.body);
      if(!tokens.refresh_token) {
        return { statusCode: 500, body: JSON.stringify({ error: 'No refresh token received', detail: tokens }) };
      }

      // Store refresh token in Supabase settings table
      const SUPABASE_URL = 'pldlvtlbgxizbppaliag.supabase.co';
      const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsZGx2dGxiZ3hpemJwcGFsaWFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1NzI5NDEsImV4cCI6MjA5MzE0ODk0MX0.uihnFIhsnPWiCg-O9Et7vJOHw_G8OacdDkQ7JNtw8Bg';

      const settingBody = JSON.stringify({
        key: 'QB_REFRESH_TOKEN',
        value: tokens.refresh_token,
        updated_at: new Date().toISOString(),
      });

      await new Promise((resolve, reject) => {
        const options = {
          hostname: SUPABASE_URL,
          path: '/rest/v1/app_settings',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(settingBody),
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'resolution=merge-duplicates',
          }
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(settingBody);
        req.end();
      });

      // Redirect back to tracker with success
      return {
        statusCode: 302,
        headers: { Location: 'https://fieldsourcetracker.netlify.app/?qb=connected' },
        body: '',
      };
    } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 400, body: 'Invalid request' };
};
