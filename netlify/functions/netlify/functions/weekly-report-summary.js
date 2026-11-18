// netlify/functions/weekly-report-summary.js
// Mondays: posts last week's daily-report summary (Mon–Sun, Eastern time) to Slack.
// Reads field_reports with the server's service key (the table is locked to signed-in users).
// Needs the Netlify environment variable SLACK_WEEKLY_WEBHOOK (a Slack incoming-webhook URL for the channel).
// Open /.netlify/functions/weekly-report-summary?preview=1 to see the message without posting it.
const SUPABASE_URL = 'https://pldlvtlbgxizbppaliag.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

function easternToday(){ return new Date(new Date().toLocaleString('en-US', { timeZone:'America/New_York' })); }
const iso = d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

async function buildSummary(){
  const today = easternToday();
  const dow = (today.getDay() + 6) % 7;                       // Monday = 0
  const thisMon = new Date(today); thisMon.setDate(today.getDate() - dow);
  const from = new Date(thisMon); from.setDate(thisMon.getDate() - 7);
  const to = new Date(thisMon); to.setDate(thisMon.getDate() - 1);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/field_reports?select=filed_by,report_date,client,has_issue&report_date=gte.${iso(from)}&report_date=lte.${iso(to)}&limit=5000`,
    { headers:{ apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}` } });
  if(!r.ok) throw new Error(`Could not read reports (${r.status}): ${(await r.text()).slice(0,200)}`);
  const rows = await r.json();
  const by = {}; rows.forEach(x=>{ const n = (x.filed_by||'Unknown').trim(); by[n] = (by[n]||0)+1; });
  const people = Object.entries(by).sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
  const sites = new Set(rows.map(x=>(x.client||'').trim()).filter(Boolean)).size, issues = rows.filter(x=>x.has_issue).length;
  const lines = [`*Weekly Report Summary — ${iso(from)} to ${iso(to)}*`];
  if(!rows.length) lines.push('No reports filed last week.');
  else { people.forEach(([n,c])=>lines.push(`• ${n}: ${c} report${c===1?'':'s'}`)); if(sites) lines.push(`${sites} site${sites===1?'':'s'}${issues?` · ⚠ ${issues} with an issue flagged`:''}`); }
  lines.push(`_Total: ${rows.length} report${rows.length===1?'':'s'}_`);
  return { text: lines.join('\n'), count: rows.length, from: iso(from), to: iso(to) };
}

exports.handler = async function(event){
  try{
    if(!SB_KEY) throw new Error('Missing SUPABASE_SERVICE_KEY');
    const s = await buildSummary();
    if(event && event.queryStringParameters && event.queryStringParameters.preview) return { statusCode:200, headers:{'Content-Type':'text/plain; charset=utf-8'}, body: s.text };
    const hook = process.env.SLACK_WEEKLY_WEBHOOK;
    if(!hook) throw new Error('Missing SLACK_WEEKLY_WEBHOOK');
    const res = await fetch(hook, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: s.text }) });
    if(!res.ok) throw new Error(`Slack said ${res.status}: ${(await res.text()).slice(0,200)}`);
    console.log('weekly summary posted', s.from, s.to, s.count);
    return { statusCode:200, body: JSON.stringify({ ok:true, ...s }) };
  }catch(e){ console.error('weekly-report-summary', e.message); return { statusCode:500, body: JSON.stringify({ error:e.message }) }; }
};
