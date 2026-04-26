// ACI Bond Yield Proxy — v2.3
// Eurostat irt_lt_mcby_m — EMU convergence criterion, 10Y monthly
// v2.3: added DK (Denmark) + ALL spreads endpoint + 2Y series

const BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/irt_lt_mcby_m';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

const GEO = { FI10Y:'FI', DE10Y:'DE', SE10Y:'SE', DK10Y:'DK' };

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

async function calcSpread(g1, g2, label, start, end) {
  const [a, b] = await Promise.all([fetchGeo(g1,start,end), fetchGeo(g2,start,end)]);
  const data = Object.keys(a).filter(d => b[d]!=null).sort()
    .map(d => ({
      date: d,
      [g1.toLowerCase()]: a[d],
      [g2.toLowerCase()]: b[d],
      spread: +(a[d]-b[d]).toFixed(4)
    }));
  return { series: label, start, end,
    source: 'Eurostat irt_lt_mcby_m',
    fetched: new Date().toISOString(),
    count: data.length, data };
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u      = new URL(req.url);
    const series = u.searchParams.get('series') || 'FI10Y';
    const start  = u.searchParams.get('start')  || '2020-01';
    const end    = u.searchParams.get('end')    || new Date().toISOString().slice(0,7);

    try {
      // Single country series
      if (GEO[series]) {
        const map  = await fetchGeo(GEO[series], start, end);
        const data = Object.keys(map).sort().map(d => ({ date:d, value:map[d] }));
        return Response.json({ series, geo:GEO[series], start, end,
          source:'Eurostat irt_lt_mcby_m',
          fetched:new Date().toISOString(),
          count:data.length, data }, { headers:CORS });
      }

      // Spreads
      const spreadMap = {
        'SPREAD':  ['FI','DE','FI-DE-SPREAD'],
        'FI-DE':   ['FI','DE','FI-DE-SPREAD'],
        'FI-SE':   ['FI','SE','FI-SE-SPREAD'],
        'FI-DK':   ['FI','DK','FI-DK-SPREAD'],
        'DE-SE':   ['DE','SE','DE-SE-SPREAD'],
      };

      if (spreadMap[series]) {
        const [g1, g2, label] = spreadMap[series];
        return Response.json(
          await calcSpread(g1, g2, label, start, end),
          { headers: CORS }
        );
      }

      // ALL — FI-DE, FI-SE, FI-DK in one call
      if (series === 'ALL') {
        const [fide, fise, fidk] = await Promise.all([
          calcSpread('FI','DE','FI-DE-SPREAD',start,end),
          calcSpread('FI','SE','FI-SE-SPREAD',start,end),
          calcSpread('FI','DK','FI-DK-SPREAD',start,end),
        ]);
        return Response.json({
          fetched: new Date().toISOString(), start, end,
          'FI-DE': fide.data,
          'FI-SE': fise.data,
          'FI-DK': fidk.data,
        }, { headers: CORS });
      }

      return Response.json(
        { error: 'Use: FI10Y, DE10Y, SE10Y, DK10Y, FI-DE, FI-SE, FI-DK, DE-SE, ALL' },
        { status: 400, headers: CORS }
      );

    } catch(e) {
      return Response.json({ error: e.message, series }, { status:500, headers:CORS });
    }
  }
};
