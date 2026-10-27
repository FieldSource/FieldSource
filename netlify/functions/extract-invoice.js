const https = require('https');

exports.handler = async function(event) {
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  try {
    const { fileData, fileType, clientList } = JSON.parse(event.body);

    const isPDF = fileType === 'application/pdf';
    const contentBlock = isPDF
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
      : { type: 'image', source: { type: 'base64', media_type: fileType, data: fileData } };

    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          {
            type: 'text',
            text: `Extract invoice details from this document. Return ONLY valid JSON:
{
  "vendor": "full vendor/supplier company name exactly as shown",
  "project": "match the bill-to, job description, or service location to one of these clients: ${clientList}. Return the exact client name from the list, or your best guess if no match.",
  "amount": total invoice amount as a number or null,
  "invoice_number": "invoice number as string or null",
  "invoice_date": "date as YYYY-MM-DD or null",
  "confidence": "high if you matched a client exactly, medium if close match, low if guessing",
  "notes": "one line describing what this invoice is for"
}
Return only the JSON object, no other text.`
          }
        ]
      }]
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'pdfs-2024-09-25',
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    const parsed = JSON.parse(result);
    const text = parsed.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: clean,
    };
  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
