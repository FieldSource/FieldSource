const https = require('https');

exports.handler = async function(event) {
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey){
    console.error('ANTHROPIC_API_KEY not set');
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
    console.error('Body parse error:', e.message);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!fileData || fileData.length === 0){
    console.error('No file data received');
    return { statusCode: 400, body: JSON.stringify({ error: 'No file data received' }) };
  }

  if(fileData.length > 13000000){
    console.error('File too large:', fileData.length);
    return { statusCode: 413, body: JSON.stringify({ error: 'File too large for extraction' }) };
  }

  const isPDF = fileType === 'application/pdf' || (fileType && fileType.includes('pdf'));
  const contentBlock = isPDF
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
    : { type: 'image', source: { type: 'base64', media_type: fileType, data: fileData } };

  console.log('Calling Anthropic API, isPDF:', isPDF);

  const structuredBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        contentBlock,
        {
          type: 'text',
          text: `Extract invoice data. The company receiving the invoice is Field Source — do NOT use them as the vendor. Return ONLY this JSON:
{"vendor":"company sending the invoice","project":"job site or project name — try to match one of: ${clientList}","amount":0,"invoice_number":"","invoice_date":"YYYY-MM-DD","confidence":"high/medium/low","notes":"brief description of what this invoice is for"}`
        }
      ]
    }]
  });

  const textBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        contentBlock,
        { type: 'text', text: 'Extract ALL text from this invoice. Return plain text only.' }
      ]
    }]
  });

  function callAPI(body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log('Anthropic response status:', res.statusCode, 'body length:', data.length);
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error('Invalid response: ' + data.slice(0, 500))); }
        });
      });
      req.on('error', (e) => { console.error('Request error:', e.message); reject(e); });
      req.write(body);
      req.end();
    });
  }

  try {
    const [structuredResult, textResult] = await Promise.all([
      callAPI(structuredBody),
      callAPI(textBody),
    ]);

    console.log('Structured result type:', structuredResult?.type);
    console.log('Structured content:', JSON.stringify(structuredResult?.content?.[0]?.text?.slice(0, 200)));

    let extracted = {};
    const structuredText = structuredResult?.content?.[0]?.text || '';
    try {
      const clean = structuredText.replace(/```json|```/g, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if(match) extracted = JSON.parse(match[0]);
      else { console.error('No JSON found in:', clean.slice(0, 200)); extracted = { confidence: 'low', notes: 'Could not parse invoice' }; }
    } catch(e) {
      console.error('JSON parse error:', e.message, 'text was:', structuredText.slice(0, 200));
      extracted = { confidence: 'low', notes: 'Could not parse invoice' };
    }

    const fullText = textResult?.content?.[0]?.text || '';
    console.log('Extraction complete, vendor:', extracted.vendor, 'amount:', extracted.amount);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...extracted, full_text: fullText }),
    };
  } catch(e) {
    console.error('Extraction failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
