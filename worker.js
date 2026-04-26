// ACI ECB/FRED Proxy — v1.1
// Hakee Suomen ja Saksan 10Y valtionlainakorot FRED:stä (OECD-data)
// Laskee myös FI-DE spreadin WP-017 analyysia varten

const SERIES = {
  'FI10Y': 'IRLTLT01FIM156N',  // Finland 10Y (OECD via FRED)
  'DE10Y': 'IRLTLT01DEM156N',  // Germany 10Y (OECD via FRED)
};

const FRED_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const series = url.searchParams.get('series') || 'FI10Y';
    const start  = url.searchParams.get('start')  || '2024-01-01';
    const end    = url.searchParams.get('end')    || new Date().toISOString().slice(0,10);

    // Hae spread: molemmat sarjat
    if (series === 'SPREAD') {
      return await fetchSpread(start, end);
    }

    if (!SERIES[series]) {
      return Response.json(
        { error: `Unknown series: ${series}. Use FI10Y, DE10Y, or SPREAD` },
        { status: 400, headers: CORS }
      );
    }

    const fredId = SERIES[series];
    const fredUrl = `${FRED_BASE}?id=${fredId}&vintage_date=${end}`;

    try {
      const resp = await fetch(fredUrl);
      if (!resp.ok) throw new Error(`FRED error: ${resp.status}`);

      const csv = await resp.text();
      const lines = csv.trim().split('\n').slice(1); // ohita header
      const data = lines
        .map(l => { const [d,v] = l.split(','); return { date: d, value: parseFloat(v) }; })
        .filter(r => r.date >= start && r.date <= end && !isNaN(r.value));

      return Response.json({
        series, fredId, start, end,
        fetched: new Date().toISOString(),
        count: data.length,
        data
      }, { headers: { ...CORS, 'Content-Type': 'application/json' } });

    } catch(e) {
      return Response.json(
        { error: e.message, series },
        { status: 500, headers: CORS }
      );
    }
  }
};

async function fetchSpread(start, end) {
  try {
    const [rFI, rDE] = await Promise.all([
      fetch(`${FRED_BASE}?id=${SERIES.FI10Y}`).then(r => r.text()),
      fetch(`${FRED_BASE}?id=${SERIES.DE10Y}`).then(r => r.text()),
    ]);

    const parse = csv => Object.fromEntries(
      csv.trim().split('\n').slice(1)
        .map(l => l.split(','))
        .filter(([d,v]) => v && !isNaN(v))
        .map(([d,v]) => [d, parseFloat(v)])
    );

    const fi = parse(rFI);
    const de = parse(rDE);

    const data = Object.keys(fi)
      .filter(d => d >= start && d <= end && de[d] != null)
      .map(d => ({ date: d, fi: fi[d], de: de[d], spread: +(fi[d] - de[d]).toFixed(4) }))
      .sort((a,b) => a.date.localeCompare(b.date));

    return Response.json({
      series: 'FI-DE-SPREAD', start, end,
      fetched: new Date().toISOString(),
      count: data.length,
      data
    }, { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch(e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
