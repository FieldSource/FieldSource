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

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'pdfs-2024-09-25',
  };
  if(workspaceId) headers['anthropic-workspace-id'] = workspaceId;

  const requestBody = JSON.stringify({
    model: 'claude-haiku-5-5',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } },
        { type: 'text', text: `Extract invoice data. Field Source is the CUSTOMER not the vendor. Return ONLY this JSON with no other text:
{"vendor":"","project":"","amount":0,"invoice_number":"","invoice_date":"","confidence":"","notes":""}

Try to match the project/job to one of these clients: ${clientList}` }
      ]
    }]
  });

  headers['Content-Length'] = Buffer.byteLength(requestBody);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Anthropic status:', res.statusCode, 'response:', data.slice(0, 300));
        if(res.statusCode !== 200){
          resolve({ statusCode: 200, body: JSON.stringify({ confidence: 'low', notes: 'Could not read invoice', full_text: '' }) });
          return;
        }
        try {
          const result = JSON.parse(data);
          const rawText = result?.content?.[0]?.text || '';
          console.log('Raw text:', rawText.slice(0, 200));
          const match = rawText.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
          const extracted = match ? JSON.parse(match[0]) : { confidence: 'low', notes: 'Could not parse invoice' };
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...extracted, full_text: rawText }),
          });
        } catch(e) {
          console.error('Parse error:', e.message);
          resolve({ statusCode: 200, body: JSON.stringify({ confidence: 'low', notes: 'Could not parse invoice', full_text: '' }) });
        }
      });
    });
    req.on('error', (e) => {
      console.error('Request error:', e.message);
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });
    req.write(requestBody);
    req.end();
  });
};
