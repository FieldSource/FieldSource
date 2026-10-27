const https = require('https');

exports.handler = async function(event) {
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const token = process.env.DROPBOX_ACCESS_TOKEN;
  if(!token){
    return { statusCode: 500, body: JSON.stringify({ error: 'Dropbox not configured' }) };
  }

  let fileData, fileName, projectName, vendorName;
  try {
    const body = JSON.parse(event.body);
    fileData = body.fileData;
    fileName = body.fileName;
    projectName = body.projectName || 'General';
    vendorName = body.vendorName || 'Unknown Vendor';
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  // Build Dropbox path matching existing folder structure
  const safeProject = projectName.replace(/[<>:"/\\|?*]/g, '_');
  const safeVendor = vendorName.replace(/[<>:"/\\|?*]/g, '_');
  const dropboxPath = `/Field Source Ohio/Accounts Payable/${fileName}`;

  const fileBuffer = Buffer.from(fileData, 'base64');

  const args = JSON.stringify({
    path: dropboxPath,
    mode: 'add',
    autorename: true,
    mute: false,
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'content.dropboxapi.com',
        path: '/2/files/upload',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Dropbox-API-Arg': args,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileBuffer.length,
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(fileBuffer);
      req.end();
    });

    if(result.status !== 200){
      const err = JSON.parse(result.body);
      return { statusCode: 500, body: JSON.stringify({ error: err.error_summary || 'Dropbox upload failed' }) };
    }

    const response = JSON.parse(result.body);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: response.path_display }),
    };
  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
