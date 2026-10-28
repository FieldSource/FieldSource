const https = require('https');

const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const REDIRECT_URI = 'https://fieldsourcetracker.netlify.app/.netlify/functions/dropbox-connect';

const SUPABASE_URL = 'pldlvtlbgxizbppaliag.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsZGx2dGxiZ3hpemJwcGFsaWFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1NzI5NDEsImV4cCI6MjA5MzE0ODk0MX0.uihnFIhsnPWiCg-O9Et7vJOHw_G8OacdDkQ7JNtw8Bg';

async function sbSet(key, value) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ key, value, updated_at: new Date().toISOString() });
    const options = {
      hostname: SUPABASE_URL,
      path: '/rest/v1/app_settings',
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Prefer': 'resolution=merge-duplicates',
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

exports.handler = async function(event) {
  const { code, error } = event.queryStringParameters || {};
  const APP_KEY = process.env.DROPBOX_APP_KEY;
  const APP_SECRET = process.env.DROPBOX_APP_SECRET;

  // Step 1: No code yet — redirect to Dropbox OAuth
  if (!code && !error) {
    const params = new URLSearchParams({
      client_id: APP_KEY,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      token_access_type: 'offline', // this gets us a refresh token
    });
    return {
      statusCode: 302,
      headers: { Location: `${DROPBOX_AUTH_URL}?${params.toString()}` },
      body: '',
    };
  }

  // Error from Dropbox
  if (error) {
    return { statusCode: 400, body: `Dropbox auth error: ${error}` };
  }

  // Step 2: Exchange code for tokens
  try {
    const credentials = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }).toString();

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.dropboxapi.com',
        path: '/oauth2/token',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        }
      };
      const req = https.request(options, res => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const tokens = JSON.parse(result.body);
    if (!tokens.refresh_token) {
      return { statusCode: 500, body: `No refresh token received: ${result.body}` };
    }

    // Store both tokens in Supabase
    await sbSet('DROPBOX_REFRESH_TOKEN', tokens.refresh_token);
    await sbSet('DROPBOX_ACCESS_TOKEN', tokens.access_token);

    return {
      statusCode: 302,
      headers: { Location: 'https://fieldsourcetracker.netlify.app/?dropbox=connected' },
      body: '',
    };
  } catch(e) {
    return { statusCode: 500, body: `Error: ${e.message}` };
  }
};
