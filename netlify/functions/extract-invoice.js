const https = require('https');

exports.handler = async function(event) {
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let fileData, fileType, clientList;
  try {
    const body = JSON.parse(event.body);
    fileData = body.fileData;
    fileType = body.fileType;
    clientList = body.clientList;
    console.log('Received file type:', fileType, 'data length:', fileData ? fileData.length : 0);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  function callAPI(requestBody) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(requestBody);
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'pdfs-2024-09-25',
          'Content-Length': Buffer.byteLength(bodyStr),
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log('Anthropic response status:', res.statusCode, 'body:', data.slice(0, 300));
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch(e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
  }

  try {
    // Extract structured fields
    const structuredReq = {
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: fileData,
            }
          },
          {
            type: 'text',
            text: `Extract invoice data. Field Source is the CUSTOMER, not the vendor. Return ONLY valid JSON:
{"vendor":"company sending this invoice","project":"job site — try to match: ${clientList}","amount":0,"invoice_number":"","invoice_date":"YYYY-MM-DD","confidence":"high","notes":"what this invoice is for"}`
          }
        ]
      }]
    };

    // Extract full text
    const textReq = {
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: fileData,
            }
          },
          { type: 'text', text: 'Extract all text from this invoice. Return plain text only.' }
        ]
      }]
    };

    const [structuredRes, textRes] = await Promise.all([
      callAPI(structuredReq),
      callAPI(textReq),
    ]);

    if(structuredRes.status !== 200){
      console.error('Anthropic error:', JSON.stringify(structuredRes.data));
      return { statusCode: 200, body: JSON.stringify({ confidence: 'low', notes: 'API error: ' + (structuredRes.data?.error?.message||structuredRes.status), full_text: '' }) };
    }

    let extracted = {};
    const rawText = structuredRes.data?.content?.[0]?.text || '';
    console.log('Raw structured response:', rawText.slice(0, 300));
    try {
      const match = rawText.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
      if(match) extracted = JSON.parse(match[0]);
    } catch(e) {
      console.error('JSON parse error:', e.message);
    }

    const fullText = textRes.data?.content?.[0]?.text || '';
    console.log('Extracted vendor:', extracted.vendor, 'amount:', extracted.amount);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...extracted, full_text: fullText }),
    };
  } catch(e) {
    console.error('Fatal error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
