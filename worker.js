// ACI Bond Yield Proxy — v2.0
// Lähde: Eurostat API (irt_lt_mcby_m)
// FI + DE 10Y valtionlainakorot + FI-DE spread
// WP-017: Parliamentary Decision Latency & Market Signal Correlation

const EUROSTAT_BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/irt_lt_mcby_m';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

async function fetchEurostat(geo, startPeriod, endPeriod) {
  const params = new URLSearchParams({
    geo,
    intrt: 'IRT_LT_MCY10',  // 10-year maturity, central government bonds
    format: 'JSON',
    lang: 'EN',
    sinceTimePeriod: startPeriod.replace('-', '-'),
    untilTimePeriod: endPeriod.replace('-', '-'),
  });

  const url = `${EUROSTAT_BASE}?${params}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`Eurostat ${geo}: ${r.status}`);

  const json = await r.json();

  // Eurostat JSON-stat format: dimension.time.category.index + values
  const timeIndex = json.dimension?.time?.category?.index || {};
  const values    = json.value || {};

  const data = {};
  for (const [period, idx] of Object.entries(timeIndex)) {
    const val = values[String(idx)];
    if (val != null) data[period] = val;
  }
  return data;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url    = new URL(request.url);
    const series = url.searchParams.get('series') || 'FI10Y';
    const start  = url.searchParams.get('start')  || '2023-01';
    const end    = url.searchParams.get('end')    || new Date().toISOString().slice(0, 7);

    try {
      if (series === 'FI10Y' || series === 'DE10Y') {
        const geo = series === 'FI10Y' ? 'FI' : 'DE';
        const map = await fetchEurostat(geo, start, end);
        const data = Object.keys(map).sort()
          .map(d => ({ date: d, value: map[d] }));
        return Response.json({
          series, geo, start, end,
          source: 'Eurostat irt_lt_mcby_m',
          fetched: new Date().toISOString(),
          count: data.length, data
        }, { headers: CORS });
      }

      if (series === 'SPREAD') {
        const [fi, de] = await Promise.all([
          fetchEurostat('FI', start, end),
          fetchEurostat('DE', start, end),
        ]);
        const data = Object.keys(fi)
          .filter(d => de[d] != null)
          .sort()
          .map(d => ({ date: d, fi: fi[d], de: de[d], spread: +(fi[d] - de[d]).toFixed(4) }));
        return Response.json({
          series: 'FI-DE-SPREAD', start, end,
          source: 'Eurostat irt_lt_mcby_m',
          fetched: new Date().toISOString(),
          count: data.length, data
        }, { headers: CORS });
      }

      return Response.json(
        { error: 'Unknown series. Use: FI10Y, DE10Y, SPREAD' },
        { status: 400, headers: CORS });

    } catch(e) {
      return Response.json({ error: e.message, series }, { status: 500, headers: CORS });
    }
  }
};
