// ACI ECB Proxy — v1.0
// Proxaa ECB SDW REST API:n WP-016 datan hakuun
// Sallitut sarjat: FI 10Y korko, DE 10Y korko, FI-DE spread

const ALLOWED_SERIES = new Set([
  'IRS.M.FI.L.L40.CI.0.EUR.N.Z',   // Suomi 10Y kuukausittainen
  'IRS.M.DE.L.L40.CI.0.EUR.N.Z',   // Saksa 10Y kuukausittainen
  'IRS.M.FI.L.L40.CI.0.EUR.N.Z,IRS.M.DE.L.L40.CI.0.EUR.N.Z', // molemmat
]);

const ECB_BASE = 'https://sdw-wsrest.ecb.europa.eu/service/data';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const series = url.searchParams.get('series');
    const start  = url.searchParams.get('start')  || '2024-01';
    const end    = url.searchParams.get('end')    || new Date().toISOString().slice(0,7);

    if (!series) {
      return Response.json({ error: 'series parameter required' },
        { status: 400, headers: CORS });
    }

    if (!ALLOWED_SERIES.has(series)) {
      return Response.json({ error: `Series not allowed: ${series}` },
        { status: 403, headers: CORS });
    }

    const ecbUrl = `${ECB_BASE}/${series}?format=jsondata&startPeriod=${start}&endPeriod=${end}&detail=dataonly`;

    try {
      const resp = await fetch(ecbUrl, {
        headers: { 'Accept': 'application/json' }
      });

      if (!resp.ok) {
        return Response.json(
          { error: `ECB API error: ${resp.status}`, series },
          { status: resp.status, headers: CORS }
        );
      }

      const data = await resp.json();

      // Muodosta yksinkertainen taulukko datasta
      const datasets = data.dataSets?.[0]?.series;
      const timevals = data.structure?.dimensions?.observation?.[0]?.values;

      if (!datasets || !timevals) {
        return Response.json({ error: 'Unexpected ECB response format', raw: data },
          { status: 502, headers: CORS });
      }

      // Rakenna yksinkertainen [{date, value}] muoto
      const results = {};
      for (const [seriesKey, seriesData] of Object.entries(datasets)) {
        const obs = seriesData.observations || {};
        const points = Object.entries(obs).map(([idx, vals]) => ({
          date:  timevals[parseInt(idx)]?.id,
          value: vals[0]
        })).filter(p => p.date && p.value != null);
        results[seriesKey] = points;
      }

      return Response.json({
        series,
        start,
        end,
        fetched: new Date().toISOString(),
        data: results
      }, { headers: { ...CORS, 'Content-Type': 'application/json' } });

    } catch (e) {
      return Response.json(
        { error: e.message, series },
        { status: 500, headers: CORS }
      );
    }
  }
};
