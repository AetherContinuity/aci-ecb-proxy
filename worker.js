// ACI Bond Yield Proxy — v2.2
// Eurostat irt_lt_mcby_m — EMU convergence criterion, 10Y monthly
// v2.2: added SE (Sweden) + FI-SE spread

const BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/irt_lt_mcby_m';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

const GEO = { FI10Y:'FI', DE10Y:'DE', SE10Y:'SE' };

async function fetchGeo(geo, start, end) {
  const url = `${BASE}?format=JSON&lang=EN&geo=${geo}&sinceTimePeriod=${start}&untilTimePeriod=${end}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Eurostat ${geo}: ${r.status}`);
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

async function spread(g1, g2, label, start, end) {
  const [a, b] = await Promise.all([fetchGeo(g1,start,end), fetchGeo(g2,start,end)]);
  const data = Object.keys(a).filter(d => b[d]!=null).sort()
    .map(d => ({ date:d, [g1.toLowerCase()]:a[d], [g2.toLowerCase()]:b[d],
                 spread:+(a[d]-b[d]).toFixed(4) }));
  return { series:label, start, end, source:'Eurostat irt_lt_mcby_m',
           fetched:new Date().toISOString(), count:data.length, data };
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u      = new URL(req.url);
    const series = u.searchParams.get('series') || 'FI10Y';
    const start  = u.searchParams.get('start')  || '2023-01';
    const end    = u.searchParams.get('end')    || new Date().toISOString().slice(0,7);

    try {
      if (GEO[series]) {
        const map  = await fetchGeo(GEO[series], start, end);
        const data = Object.keys(map).sort().map(d => ({ date:d, value:map[d] }));
        return Response.json({ series, geo:GEO[series], start, end,
          source:'Eurostat irt_lt_mcby_m', fetched:new Date().toISOString(),
          count:data.length, data }, { headers:CORS });
      }
      if (series === 'SPREAD' || series === 'FI-DE')
        return Response.json(await spread('FI','DE','FI-DE-SPREAD',start,end), { headers:CORS });
      if (series === 'FI-SE')
        return Response.json(await spread('FI','SE','FI-SE-SPREAD',start,end), { headers:CORS });
      if (series === 'ALL') {
        const [fide, fise] = await Promise.all([
          spread('FI','DE','FI-DE-SPREAD',start,end),
          spread('FI','SE','FI-SE-SPREAD',start,end),
        ]);
        return Response.json({ fetched:new Date().toISOString(),
          'FI-DE': fide.data, 'FI-SE': fise.data }, { headers:CORS });
      }
      return Response.json({ error:'Use: FI10Y, DE10Y, SE10Y, FI-DE, FI-SE, ALL' },
        { status:400, headers:CORS });
    } catch(e) {
      return Response.json({ error:e.message, series }, { status:500, headers:CORS });
    }
  }
};
