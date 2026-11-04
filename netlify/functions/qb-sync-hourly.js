// netlify/functions/qb-sync-hourly.js
// Scheduled every hour (see netlify.toml). Runs the same QuickBooks sync as qb-sync.js.
// Kept separate because Netlify blocks opening a scheduled function from a browser,
// and qb-sync needs to stay openable for manual runs (e.g. ?reset=1 catch-ups).

const { handler: sync } = require('./qb-sync.js');

exports.handler = async function () {
  let res;
  // Up to 3 passes (~8s each) so a busy hour still finishes; stops as soon as it's caught up.
  for (let i = 0; i < 3; i++) {
    res = await sync({ httpMethod: 'POST', queryStringParameters: {} });
    let body = {};
    try { body = JSON.parse(res.body); } catch (e) {}
    console.log('qb-sync pass', i + 1, res.statusCode, res.body.slice(0, 300));
    if (res.statusCode !== 200 || !body.hasMore) break;
  }
  // Then invoices (balances, payments, links to estimates)
  try{
    const inv = require('./qb-invoice-sync.js');
    for (let i = 0; i < 3; i++) { const r = await inv.run(false); console.log('qb-invoice-sync pass', i + 1, JSON.stringify(r)); if (!r.hasMore) break; }
  }catch(e){ console.error('qb-invoice-sync failed:', e.message); }
  // Then vendor bills (what we owe; paid status for "Approve to pay")
  try{
    const bills = require('./qb-bill-sync.js');
    for (let i = 0; i < 3; i++) { const r = await bills.run(false); console.log('qb-bill-sync pass', i + 1, JSON.stringify(r)); if (!r.hasMore) break; }
  }catch(e){ console.error('qb-bill-sync failed:', e.message); }
  return res;
};
