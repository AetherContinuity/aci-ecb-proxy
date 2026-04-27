// ACI Bond Yield + Debt + Budget Proxy — v3.1
// Sources:
//   Eurostat irt_lt_mcby_m — 10Y sovereign yields
//   Valtiokonttori central-government-debt API (CC BY 4.0)
//   Valtiokonttori valtiontalous API — budget accounting (CC BY 4.0)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const EUROSTAT_BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/irt_lt_mcby_m';
const VK_DEBT_BASE  = 'https://api.tutkihallintoa.fi/central-government-debt/v1';
const VK_BUDGET_BASE = 'https://api.tutkihallintoa.fi/valtiontalous/v1';

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
    const v = vals[String(idx)]; if (v != null) out[period] = v;
  }
  return out;
}

async function calcSpread(g1, g2, label, start, end) {
  const [a, b] = await Promise.all([fetchGeo(g1,start,end), fetchGeo(g2,start,end)]);
  const data = Object.keys(a).filter(d => b[d]!=null).sort()
    .map(d => ({ date:d, [g1.toLowerCase()]:a[d], [g2.toLowerCase()]:b[d], spread:+(a[d]-b[d]).toFixed(4) }));
  return { series:label, start, end, source:'Eurostat irt_lt_mcby_m', fetched:new Date().toISOString(), count:data.length, data };
}

async function fetchVKDebt(endpoint, lang='EN') {
  const r = await fetch(`${VK_DEBT_BASE}/${endpoint}?lang=${lang}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`VK-Debt ${endpoint}: ${r.status}`);
  return r.json();
}

async function fetchVKBudget(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${VK_BUDGET_BASE}/budjettitaloudentapahtumat?${qs}`, { headers: { Accept: 'text/csv' } });
  if (!r.ok) return [];
  const csv = await r.text();
  // Parse CSV to JSON
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(';').map(h => h.trim().replace(/^"|"$/g,''));
  return lines.slice(1).map(line => {
    const vals = line.split(';').map(v => v.trim().replace(/^"|"$/g,''));
    return Object.fromEntries(headers.map((h,i) => [h, vals[i]]));
  }).filter(r => Object.values(r).some(v => v));
}

const VK_DEBT_ENDPOINTS = {
  'VK-INTEREST':       'interest-expenses',
  'VK-SENSITIVITY':    'interest-rate-sensitivity',
  'VK-DEBT-SERIES':    'monthly-debt-time-series',
  'VK-DEBT-GDP':       'debt-and-gdp',
  'VK-STRUCTURE':      'structure-of-debt',
  'VK-REDEMPTIONS':    'redemptions-net-borrowing',
  'VK-REALIZED':       'realized-borrowing',
  'VK-EMTN':           'emtn-bond-issues',
  'VK-BORROWING-PLAN': 'borrowing-plan',
  'VK-LIQUID':         'liquid-cash-funds',
  'VK-EFFECTIVE-COST': 'effective-cost-of-debt',
  'VK-SERIAL':         'serial-bond-issues',
};

const EDK_BASE = 'https://api.eduskunta.fi/api/v1';

async function fetchVNS82025() {
  const q = JSON.stringify({
    category: 'valtiopaivaasia',
    maxResults: 1,
    startFromIndex: 0,
    expression: { and: [{ property: 'eduskuntatunnus', match: 'VNS 8/2025' }] }
  });
  const url = `${EDK_BASE}/search?q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`EDK API: ${r.status}`);
  const j = await r.json();
  const asia = j.results?.[0]?.valtiopaivaasia;
  if (!asia) throw new Error('VNS 8/2025 not found');

  // Extract key fields
  const tila = asia.tila?.fi || 'tuntematon';
  const kasittelyt = asia.kasittelyt?.fi || [];
  const asiakirjat = asia.keskeisetAsiakirjat?.fi || [];

  // Find TaVM if published
  const tavm = asiakirjat.find(a => a.asiakirjatyyppikoodi === 'TaVM');
  const lausunnot = asiakirjat.filter(a => a.asiakirjatyyppikoodi?.endsWith('VL'));

  // Latest processing stage
  const viimeisin = asia.viimeisinKasittelyvaihe?.fi || 'ei tietoa';

  return {
    series: 'EDK-VNS82025',
    source: 'Parliament of Finland Open Data API',
    fetched: new Date().toISOString(),
    eduskuntatunnus: 'VNS 8/2025 vp',
    nimeke: asia.nimeke?.fi || '',
    tila,
    viimeisinKasittelyvaihe: viimeisin,
    tavm_julkaistu: !!tavm,
    tavm: tavm ? {
      edktunnus: tavm.edktunnus,
      laadintapvm: tavm.laadintapvm,
      nimeketeksti: tavm.nimeketeksti,
      htmlSaatavilla: tavm.htmlSaatavilla
    } : null,
    lausunnot: lausunnot.map(l => ({
      valiokunta: l.valiokuntanimi,
      edktunnus: l.edktunnus,
      laadintapvm: l.laadintapvm
    })),
    kasittelyvaiheetLkm: kasittelyt.length,
    viimeisinKasittely: kasittelyt[kasittelyt.length - 1] ? {
      tapahtumapvm: kasittelyt[kasittelyt.length - 1].tapahtumapvm,
      kasittelyvaihe: kasittelyt[kasittelyt.length - 1].kasittelyvaihe
    } : null
  };
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const series  = u.searchParams.get('series')  || 'FI10Y';
    const start   = u.searchParams.get('start')   || '2020-01';
    const end     = u.searchParams.get('end')     || new Date().toISOString().slice(0,7);
    const lang    = u.searchParams.get('lang')    || 'EN';

    try {
      // Eduskunta API — VNS 8/2025 käsittelyseuranta
      if (series === 'EDK-VNS82025') {
        const data = await fetchVNS82025();
        return Response.json(data, { headers: CORS });
      }

      // Valtiokonttori DEBT API
      if (VK_DEBT_ENDPOINTS[series]) {
        const data = await fetchVKDebt(VK_DEBT_ENDPOINTS[series], lang);
        return Response.json({ series, source:'Valtiokonttori State Treasury Finland',
          fetched:new Date().toISOString(), data }, { headers:CORS });
      }

      // Valtiokonttori BUDGET API — interest expenses pääluokka 36
      if (series === 'VT-INTEREST') {
        const yearFrom = u.searchParams.get('yearFrom') || '2020';
        const yearTo   = u.searchParams.get('yearTo')   || '2025';
        // Try paaluokka=36 first, fallback to luku=3602 (Valtionvelan korot)
        let data = await fetchVKBudget({ paaluokka:'36', yearFrom, yearTo });
        if (!data || data.length === 0) {
          data = await fetchVKBudget({ luku:'3602', yearFrom, yearTo });
        }
        return Response.json({ series, description:'State debt interest payments (paaluokka 36 / luku 3602)',
          source:'Valtiokonttori valtiontalous API', fetched:new Date().toISOString(),
          yearFrom, yearTo, count:data.length, data }, { headers:CORS });
      }

      // Eurostat yields
      if (GEO[series]) {
        const map = await fetchGeo(GEO[series], start, end);
        const data = Object.keys(map).sort().map(d => ({ date:d, value:map[d] }));
        return Response.json({ series, geo:GEO[series], start, end,
          source:'Eurostat irt_lt_mcby_m', fetched:new Date().toISOString(),
          count:data.length, data }, { headers:CORS });
      }

      // Spreads
      const sm = { 'SPREAD':['FI','DE','FI-DE'], 'FI-DE':['FI','DE','FI-DE'],
                   'FI-SE':['FI','SE','FI-SE'], 'FI-DK':['FI','DK','FI-DK'] };
      if (sm[series]) {
        const [g1,g2,l] = sm[series];
        return Response.json(await calcSpread(g1,g2,l+'-SPREAD',start,end), { headers:CORS });
      }

      if (series === 'ALL') {
        const [fide,fise,fidk] = await Promise.all([
          calcSpread('FI','DE','FI-DE-SPREAD',start,end),
          calcSpread('FI','SE','FI-SE-SPREAD',start,end),
          calcSpread('FI','DK','FI-DK-SPREAD',start,end),
        ]);
        return Response.json({ fetched:new Date().toISOString(), start, end,
          'FI-DE':fide.data, 'FI-SE':fise.data, 'FI-DK':fidk.data }, { headers:CORS });
      }

      return Response.json({ error:'Available series:',
        yields:['FI10Y','DE10Y','SE10Y','DK10Y'],
        spreads:['FI-DE','FI-SE','FI-DK','ALL'],
        vk_debt:Object.keys(VK_DEBT_ENDPOINTS),
        vk_budget:['VT-INTEREST (add ?yearFrom=2020&yearTo=2025)'],
        eduskunta:['EDK-VNS82025 — VNS 8/2025 käsittelyseuranta, TaVM-status']
      }, { status:400, headers:CORS });

    } catch(e) {
      return Response.json({ error:e.message, series }, { status:500, headers:CORS });
    }
  }
};
