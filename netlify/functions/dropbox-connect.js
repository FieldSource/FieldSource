const https = require('https');

const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const REDIRECT_URI = 'https://fieldsourcetracker.netlify.app/.netlify/functions/dropbox-connect';
const SUPABASE_URL = 'pldlvtlbgxizbppaliag.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsZGx2dGxiZ3hpemJwcGFsaWFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1NzI5NDEsImV4cCI6MjA5MzE0ODk0MX0.uihnFIhsnPWiCg-O9Et7vJOHw_G8OacdDkQ7JNtw8Bg';

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sbSet(key, value) {
  const data = JSON.stringify({ key, value, updated_at: new Date().toISOString() });
  const res = await httpsPost(
    SUPABASE_URL,
    '/rest/v1/app_settings',
    {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'Prefer': 'resolution=merge-duplicates',
    },
    data
  );
  console.log('sbSet key:', key, 'status:', res.status, 'response:', res.body.slice(0,100));
  return res;
}

exports.handler = async function(event) {
  const params = event.queryStringParameters || {};
  const APP_KEY = process.env.DROPBOX_APP_KEY;
  const APP_SECRET = process.env.DROPBOX_APP_SECRET;

  console.log('Handler called. Params:', JSON.stringify(params));
  console.log('APP_KEY present:', !!APP_KEY, 'APP_SECRET present:', !!APP_SECRET);

  // No code — redirect to Dropbox
  if (!params.code && !params.error) {
    const authParams = new URLSearchParams({
      client_id: APP_KEY,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      token_access_type: 'offline',
    });
    console.log('Redirecting to Dropbox auth...');
    return {
      statusCode: 302,
      headers: { Location: `${DROPBOX_AUTH_URL}?${authParams.toString()}` },
      body: '',
    };
  }

  if (params.error) {
    console.error('Dropbox auth error:', params.error);
    return { statusCode: 400, body: `Dropbox auth error: ${params.error}` };
  }

  // Exchange code for tokens
  console.log('Got code, exchanging for tokens...');
  const credentials = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    code: params.code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  }).toString();

  try {
    const result = await httpsPost(
      'api.dropboxapi.com',
      '/oauth2/token',
      {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body
    );

    console.log('Dropbox token status:', result.status);
    console.log('Dropbox token body:', result.body.slice(0, 500));

    const tokens = JSON.parse(result.body);

    if (result.status !== 200 || !tokens.access_token) {
      return { 
        statusCode: 200, 
        headers: { 'Content-Type': 'text/html' },
        body: `<h2>Error getting token</h2><pre>${result.body}</pre>` 
      };
    }

    // Save access token
    await sbSet('DROPBOX_ACCESS_TOKEN', tokens.access_token);

    // Save refresh token if present
    if (tokens.refresh_token) {
      await sbSet('DROPBOX_REFRESH_TOKEN', tokens.refresh_token);
      console.log('Refresh token saved!');
    } else {
      console.log('No refresh token in response. Token type:', tokens.token_type);
    }

    return {
      statusCode: 302,
      headers: { Location: 'https://fieldsourcetracker.netlify.app/?dropbox=connected' },
      body: '',
    };
  } catch(e) {
    console.error('Exchange error:', e.message);
    return { statusCode: 500, body: `Error: ${e.message}` };
  }
};
