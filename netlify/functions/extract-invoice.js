const https = require('https');

exports.handler = async function(event) {
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
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

  if(fileData && fileData.length > 13000000){
    return { statusCode: 413, body: JSON.stringify({ error: 'File too large for extraction' }) };
  }

  const isPDF = fileType === 'application/pdf';
  const contentBlock = isPDF
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
    : { type: 'image', source: { type: 'base64', media_type: fileType, data: fileData } };

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        contentBlock,
        {
          type: 'text',
          text: `Extract invoice details. Return ONLY this JSON object with no other text:
{"vendor":"company name","project":"match to one of: ${clientList}","amount":0,"invoice_number":"","invoice_date":"YYYY-MM-DD","confidence":"high/medium/low","notes":"brief description"}`
        }
      ]
    }]
  });

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(requestBody),
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'pdfs-2024-09-25',
  };
  if(workspaceId) headers['anthropic-workspace-id'] = workspaceId;

  try {
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(requestBody);
      req.end();
    });

    const parsed = JSON.parse(result);
    if(parsed.error) {
      return { statusCode: 500, body: JSON.stringify({ error: parsed.error.message || 'API error' }) };
    }

    const text = (parsed.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    JSON.parse(text);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: text,
    };
  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
