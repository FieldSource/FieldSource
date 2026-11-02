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
  return res;
};
