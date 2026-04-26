// ACI ECB/FRED Proxy — v1.2
// Finland + Germany 10Y yields via FRED/OECD + FI-DE spread

const SERIES = {
  'FI10Y': 'IRLTLT01FIM156N',
  'DE10Y': 'IRLTLT01DEM156N',
};
const FRED_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

function parseFredCsv(csv) {
  // Returns {date: value} map — skips "." missing values
  const result = {};
  const lines = csv.trim().split('\n').slice(1);
  for (const line of lines) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    const raw  = line.slice(comma + 1).trim();
    const val  = parseFloat(raw);
    if (!isNaN(val)) result[date] = val;
  }
  return result;
}

async function fetchOne(fredId) {
  const r = await fetch(`${FRED_BASE}?id=${fredId}`);
  if (!r.ok) throw new Error(`FRED ${fredId}: ${r.status}`);
  return parseFredCsv(await r.text());
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url    = new URL(request.url);
    const series = url.searchParams.get('series') || 'FI10Y';
    const start  = url.searchParams.get('start')  || '2023-01-01';
    const end    = url.searchParams.get('end')    || '2026-12-31';

    try {
      if (series === 'SPREAD') {
        const [fi, de] = await Promise.all([fetchOne(SERIES.FI10Y), fetchOne(SERIES.DE10Y)]);
        const data = Object.keys(fi)
          .filter(d => de[d] != null && d >= start && d <= end)
          .sort()
          .map(d => ({ date: d, fi: fi[d], de: de[d], spread: +(fi[d] - de[d]).toFixed(4) }));
        return Response.json({ series: 'FI-DE-SPREAD', start, end,
          fetched: new Date().toISOString(), count: data.length, data },
          { headers: CORS });
      }

      if (!SERIES[series]) return Response.json(
        { error: `Unknown series. Use: FI10Y, DE10Y, SPREAD` },
        { status: 400, headers: CORS });

      const map  = await fetchOne(SERIES[series]);
      const data = Object.keys(map)
        .filter(d => d >= start && d <= end)
        .sort()
        .map(d => ({ date: d, value: map[d] }));
      return Response.json({ series, fredId: SERIES[series], start, end,
        fetched: new Date().toISOString(), count: data.length, data },
        { headers: CORS });

    } catch(e) {
      return Response.json({ error: e.message, series }, { status: 500, headers: CORS });
    }
  }
};
