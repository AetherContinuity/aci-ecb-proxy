// ACI Bond Yield Proxy — v2.1
// Eurostat irt_lt_mcby_m — EMU convergence criterion, 10Y monthly

const BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/irt_lt_mcby_m';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

async function fetchGeo(geo, start, end) {
  const url = `${BASE}?format=JSON&lang=EN&geo=${geo}&sinceTimePeriod=${start}&untilTimePeriod=${end}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Eurostat ${geo}: ${r.status} — ${body.slice(0,200)}`);
  }
  const j = await r.json();
  const timeIdx = j.dimension?.time?.category?.index || {};
  const vals    = j.value || {};
  const out = {};
  for (const [period, idx] of Object.entries(timeIdx)) {
    const v = vals[String(idx)];
    if (v != null) out[period] = v;
  }
  return out;
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u      = new URL(req.url);
    const series = u.searchParams.get('series') || 'FI10Y';
    const start  = u.searchParams.get('start')  || '2023-01';
    const end    = u.searchParams.get('end')    || new Date().toISOString().slice(0,7);

    try {
      if (series === 'FI10Y' || series === 'DE10Y') {
        const geo  = series === 'FI10Y' ? 'FI' : 'DE';
        const map  = await fetchGeo(geo, start, end);
        const data = Object.keys(map).sort().map(d => ({ date: d, value: map[d] }));
        return Response.json({ series, geo, start, end,
          source: 'Eurostat irt_lt_mcby_m', fetched: new Date().toISOString(),
          count: data.length, data }, { headers: CORS });
      }
      if (series === 'SPREAD') {
        const [fi, de] = await Promise.all([fetchGeo('FI',start,end), fetchGeo('DE',start,end)]);
        const data = Object.keys(fi).filter(d => de[d]!=null).sort()
          .map(d => ({ date:d, fi:fi[d], de:de[d], spread:+(fi[d]-de[d]).toFixed(4) }));
        return Response.json({ series:'FI-DE-SPREAD', start, end,
          source:'Eurostat irt_lt_mcby_m', fetched:new Date().toISOString(),
          count:data.length, data }, { headers: CORS });
      }
      return Response.json({ error:'Use: FI10Y, DE10Y, SPREAD' }, { status:400, headers:CORS });
    } catch(e) {
      return Response.json({ error: e.message, series }, { status:500, headers:CORS });
    }
  }
};
