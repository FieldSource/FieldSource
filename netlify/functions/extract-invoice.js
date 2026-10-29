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

  const structuredBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        contentBlock,
        {
          type: 'text',
          text: `You are extracting data from an invoice. Read every part of the document carefully including headers, footers, line items, and any monospace or unusual fonts.

Extract the following and return ONLY a JSON object with no other text:
- vendor: the company sending the invoice (not Field Source — that is the customer)
- project: the job site or project name. Try to match one of these clients: ${clientList}. Look for fields like "Job Name", "PO#", "Job#", "Project", or location names.
- amount: the final total amount due (look for "Total:", "Amount Due", "Balance Due" — use the largest/final total)
- invoice_number: the invoice or contract number
- invoice_date: the invoice date in YYYY-MM-DD format
- confidence: "high", "medium", or "low"
- notes: one line describing what this invoice is for

Example output:
{"vendor":"Vandalia Rental","project":"Canal Winchester","amount":6467.14,"invoice_number":"1603506-0002","invoice_date":"2026-10-28","confidence":"high","notes":"Roller rental 4 weeks"}`
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
        {
          type: 'text',
          text: 'Extract ALL text content from this invoice exactly as it appears. Include all line items, descriptions, addresses, dates, amounts, and any other text. Return plain text only.'
        }
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
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error('Invalid response: ' + data.slice(0, 200))); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  try {
    const [structuredResult, textResult] = await Promise.all([
      callAPI(structuredBody),
      callAPI(textBody),
    ]);

    let extracted = {};
    const structuredText = structuredResult?.content?.[0]?.text || '';
    try {
      const clean = structuredText.replace(/```json|```/g, '').trim();
      // Find JSON object in the response
      const match = clean.match(/\{[\s\S]*\}/);
      extracted = match ? JSON.parse(match[0]) : {};
    } catch(e) {
      extracted = { confidence: 'low', notes: 'Could not parse invoice' };
    }

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
