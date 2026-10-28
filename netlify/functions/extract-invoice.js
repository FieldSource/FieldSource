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

  // First call: extract structured fields
  const structuredBody = JSON.stringify({
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

  // Second call: extract full text content for search
  const textBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        contentBlock,
        {
          type: 'text',
          text: 'Extract ALL text content from this invoice exactly as it appears. Include all line items, descriptions, addresses, dates, amounts, and any other text. Return plain text only, no formatting.'
        }
      ]
    }]
  });

  function callAnthropicAPI(requestBody) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(requestBody),
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error('Invalid JSON response: ' + data.slice(0, 200))); }
        });
      });
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });
  }

  try {
    // Run both extractions in parallel
    const [structuredResult, textResult] = await Promise.all([
      callAnthropicAPI(structuredBody),
      callAnthropicAPI(textBody),
    ]);

    // Parse structured fields
    let extracted = {};
    const structuredText = structuredResult?.content?.[0]?.text || '';
    try {
      const clean = structuredText.replace(/```json|```/g, '').trim();
      extracted = JSON.parse(clean);
    } catch(e) {
      extracted = { confidence: 'low', notes: 'Could not parse invoice' };
    }

    // Get full text
    const fullText = textResult?.content?.[0]?.text || '';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...extracted, full_text: fullText }),
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
