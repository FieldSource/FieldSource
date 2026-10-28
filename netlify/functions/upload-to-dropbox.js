const https = require('https');

const SUPABASE_URL = 'pldlvtlbgxizbppaliag.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsZGx2dGxiZ3hpemJwcGFsaWFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1NzI5NDEsImV4cCI6MjA5MzE0ODk0MX0.uihnFIhsnPWiCg-O9Et7vJOHw_G8OacdDkQ7JNtw8Bg';

async function sbGet(key) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPABASE_URL,
      path: `/rest/v1/app_settings?key=eq.${key}&select=value`,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try {
          const rows = JSON.parse(d);
          resolve(rows?.[0]?.value || null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

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

async function getAccessToken() {
  const APP_KEY = process.env.DROPBOX_APP_KEY;
  const APP_SECRET = process.env.DROPBOX_APP_SECRET;

  // Try refresh token from Supabase first, fall back to env var
  const refreshToken = await sbGet('DROPBOX_REFRESH_TOKEN');

  if (refreshToken) {
    // Use refresh token to get a fresh access token
    const credentials = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString();

    return new Promise((resolve, reject) => {
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
        res.on('end', () => {
          try {
            const tokens = JSON.parse(d);
            if (tokens.access_token) {
              // Cache the new access token
              sbSet('DROPBOX_ACCESS_TOKEN', tokens.access_token);
              resolve(tokens.access_token);
            } else {
              reject(new Error('Failed to refresh token: ' + d));
            }
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // Fall back to static token from env (legacy)
  const staticToken = await sbGet('DROPBOX_ACCESS_TOKEN') || process.env.DROPBOX_ACCESS_TOKEN;
  if (!staticToken) throw new Error('No Dropbox token available. Please connect Dropbox at /dropbox-connect');
  return staticToken;
}

async function uploadToDropbox(accessToken, fileData, fileName) {
  const dropboxPath = `/Field Source Ohio/Accounts Payable/${fileName}`;
  const fileBuffer = Buffer.from(fileData, 'base64');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'content.dropboxapi.com',
      path: '/2/files/upload',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileBuffer.length,
        'Dropbox-API-Arg': JSON.stringify({
          path: dropboxPath,
          mode: 'overwrite',
          autorename: false,
          mute: false,
        }),
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(d);
          if (result.error_summary) reject(new Error(result.error_summary));
          else resolve(result);
        } catch(e) { reject(new Error('Dropbox response: ' + d)); }
      });
    });
    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { fileData, fileName, projectName, vendorName } = JSON.parse(event.body);
    if (!fileData || !fileName) {
      return { statusCode: 400, body: JSON.stringify({ error: 'fileData and fileName are required' }) };
    }

    const accessToken = await getAccessToken();
    const result = await uploadToDropbox(accessToken, fileData, fileName);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, path: result.path_display }),
    };
  } catch(e) {
    console.error('Dropbox upload error:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
