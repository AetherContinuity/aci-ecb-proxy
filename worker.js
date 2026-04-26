// ACI Bond Yield + Debt Proxy — v3.0
// Sources:
//   Eurostat irt_lt_mcby_m — 10Y sovereign yields
//   Valtiokonttori API — Finnish central government debt data

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const EUROSTAT_BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/irt_lt_mcby_m';
const VK_BASE = 'https://api.tutkihallintoa.fi/central-government-debt/v1';

const GEO = { FI10Y:'FI', DE10Y:'DE', SE10Y:'SE', DK10Y:'DK' };

async function fetchGeo(geo, start, end) {
  const url = `${EUROSTAT_BASE}?format=JSON&lang=EN&geo=${geo}&sinceTimePeriod=${start}&untilTimePeriod=${end}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Eurostat ${geo}: ${r.status}`);
  const j = await r.json();
  const timeIdx = j.dimension?.time?.category?.index || {};
  const vals = j.value || {};
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

async function fetchVK(endpoint, lang='EN') {
  const url = `${VK_BASE}/${endpoint}?lang=${lang}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Valtiokonttori ${endpoint}: ${r.status}`);
  return r.json();
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const series = u.searchParams.get('series') || 'FI10Y';
    const start  = u.searchParams.get('start')  || '2020-01';
    const end    = u.searchParams.get('end')    || new Date().toISOString().slice(0,7);
    const lang   = u.searchParams.get('lang')   || 'EN';

    try {
      // Valtiokonttori debt data endpoints
      const vkEndpoints = {
        'VK-INTEREST': 'interest-expenses',
        'VK-SENSITIVITY': 'interest-rate-sensitivity',
        'VK-DEBT-SERIES': 'monthly-debt-time-series',
        'VK-DEBT-GDP': 'debt-and-gdp',
        'VK-STRUCTURE': 'structure-of-debt',
        'VK-REDEMPTIONS': 'redemptions-net-borrowing',
        'VK-REALIZED': 'realized-borrowing',
        'VK-EMTN': 'emtn-bond-issues',
        'VK-BORROWING-PLAN': 'borrowing-plan',
        'VK-LIQUID': 'liquid-cash-funds',
        'VK-EFFECTIVE-COST': 'effective-cost-of-debt',
        'VK-SERIAL': 'serial-bond-issues',
      };

      if (vkEndpoints[series]) {
        const data = await fetchVK(vkEndpoints[series], lang);
        return Response.json({
          series,
          endpoint: vkEndpoints[series],
          source: 'Valtiokonttori / State Treasury Finland',
          fetched: new Date().toISOString(),
          data
        }, { headers: CORS });
      }

      // Single country yields
      if (GEO[series]) {
        const map = await fetchGeo(GEO[series], start, end);
        const data = Object.keys(map).sort().map(d => ({ date:d, value:map[d] }));
        return Response.json({ series, geo:GEO[series], start, end,
          source:'Eurostat irt_lt_mcby_m',
          fetched:new Date().toISOString(),
          count:data.length, data }, { headers:CORS });
      }

      // Spreads
      const spreadMap = {
        'SPREAD': ['FI','DE','FI-DE-SPREAD'],
        'FI-DE':  ['FI','DE','FI-DE-SPREAD'],
        'FI-SE':  ['FI','SE','FI-SE-SPREAD'],
        'FI-DK':  ['FI','DK','FI-DK-SPREAD'],
        'DE-SE':  ['DE','SE','DE-SE-SPREAD'],
      };
      if (spreadMap[series]) {
        const [g1,g2,label] = spreadMap[series];
        return Response.json(await calcSpread(g1,g2,label,start,end), { headers:CORS });
      }

      // ALL spreads
      if (series === 'ALL') {
        const [fide,fise,fidk] = await Promise.all([
          calcSpread('FI','DE','FI-DE-SPREAD',start,end),
          calcSpread('FI','SE','FI-SE-SPREAD',start,end),
          calcSpread('FI','DK','FI-DK-SPREAD',start,end),
        ]);
        return Response.json({
          fetched: new Date().toISOString(), start, end,
          'FI-DE': fide.data, 'FI-SE': fise.data, 'FI-DK': fidk.data,
        }, { headers:CORS });
      }

      return Response.json({
        error: 'Available series:',
        yields: ['FI10Y','DE10Y','SE10Y','DK10Y'],
        spreads: ['FI-DE','FI-SE','FI-DK','ALL'],
        valtiokonttori: Object.keys(vkEndpoints)
      }, { status:400, headers:CORS });

    } catch(e) {
      return Response.json({ error: e.message, series }, { status:500, headers:CORS });
    }
  }
};
