// ACI Bond Yield + Debt + Budget Proxy — v3.2
// Sources:
//   Eurostat irt_lt_mcby_m — 10Y sovereign yields
//   Valtiokonttori central-government-debt API (CC BY 4.0)
//   Valtiokonttori valtiontalous API — budget accounting (CC BY 4.0)
//   ECB Data Portal (SDMX 2.1)
//   Bank of Finland / FIN-FSA Open Data — Timeseries API (CC BY 4.0)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const EUROSTAT_BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/irt_lt_mcby_m';
const VK_DEBT_BASE  = 'https://api.tutkihallintoa.fi/central-government-debt/v1';
const UA_CSV = 'curl/8.5.0';
const VK_BUDGET_BASE = 'https://api.tutkihallintoa.fi/valtiontalous/v1';

const GEO = { FI10Y:'FI', DE10Y:'DE', SE10Y:'SE', DK10Y:'DK' };
const SPREAD_MAP = { 'SPREAD':['FI','DE','FI-DE'], 'FI-DE':['FI','DE','FI-DE'],
                     'FI-SE':['FI','SE','FI-SE'], 'FI-DK':['FI','DK','FI-DK'] };

// Cache TTL per upstream family — matches each source's own update cadence,
// not one blanket number. Fingrid EPP moves every 15 min; Eurostat/ECB/BoF
// are daily-to-monthly series; Valtiokonttori and Eduskunta change rarely
// within a session. Returns null (no caching) for unmatched/error routes.
function ttlFor(u) {
  const series = u.searchParams.get('series') || 'FI10Y';
  if (series === 'FINGRID-EPP') return 300; // 5 min
  if (u.searchParams.get('ecb') || u.searchParams.get('struct') ||
      ECB_ALIAS[series] || series === 'ECB-INFLATION' || series === 'ECB-RATES') return 43200; // 12h
  if (u.searchParams.get('bofdatasets') || u.searchParams.get('bofstruct') ||
      u.searchParams.get('bofseries') || u.searchParams.get('bof')) return 43200; // 12h
  if (series === 'EDK-VNS82025') return 21600; // 6h — process tracking, like Hankeikkuna
  if (u.searchParams.get('vkapi') || u.searchParams.get('vkdebt') || u.searchParams.get('vk') ||
      VK_DEBT_ENDPOINTS[series] || series === 'VT-INTEREST') return 86400; // 24h
  if (GEO[series] || SPREAD_MAP[series] || series === 'ALL') return 43200; // 12h — Eurostat
  return null;
}

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

function parseCsvLine(line, d) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i+1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === d && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(v => v.trim());
}

async function fetchVKBudget(params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${VK_BUDGET_BASE}/budjettitaloudentapahtumat?${qs}`;
  const r = await fetch(url, { headers: { Accept: 'text/csv', 'User-Agent': UA_CSV } });
  if (!r.ok) return [];
  const csv = await r.text();
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  // Upstream delimiter is comma, not semicolon (was a silent bug: every row
  // parsed into a single key). Detect it instead of hardcoding.
  const d = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';
  const headers = parseCsvLine(lines[0], d).map(h => h.replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = parseCsvLine(line, d).map(v => v.replace(/^"|"$/g, ''));
    return Object.fromEntries(headers.map((h, i) => [h, vals[i]]));
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
const FINGRID_BASE = 'https://data.fingrid.fi/api/datasets';

// ─────────────────────────────────────────────────────────────
// ECB SDMX 2.1  —  data-api.ecb.europa.eu
// Passthrough: ?ecb=<full.series.key>   (no code change per series)
// Aliases:     ?series=ECB-DFR  etc.
// ─────────────────────────────────────────────────────────────
const ECB_BASE = 'https://data-api.ecb.europa.eu/service/data';

const ECB_ALIAS = {
  // Policy rates (daily, step series — value changes only on decision dates)
  'ECB-DFR':       'FM.D.U2.EUR.4F.KR.DFR.LEV',        // deposit facility
  'ECB-MRO':       'FM.D.U2.EUR.4F.KR.MRR_FR.LEV',     // main refinancing, fixed rate
  'ECB-MLF':       'FM.D.U2.EUR.4F.KR.MLFR.LEV',       // marginal lending
  'ECB-ESTR':      'EST.B.EU000A2X2A25.WT',            // €STR volume-weighted trimmed mean

  // Money market (monthly averages)
  'ECB-EURIBOR1M': 'FM.M.U2.EUR.RT.MM.EURIBOR1MD_.HSTA',
  'ECB-EURIBOR3M': 'FM.M.U2.EUR.RT.MM.EURIBOR3MD_.HSTA',
  'ECB-EURIBOR6M': 'FM.M.U2.EUR.RT.MM.EURIBOR6MD_.HSTA',
  'ECB-EURIBOR12M':'FM.M.U2.EUR.RT.MM.EURIBOR1YD_.HSTA',

  // HICP — dataflow ICP was retired 4.2.2026, replaced by HICP.
  // Provider code: 4D0 = Eurostat, 4F0 = ECB (trimmed means etc).
  'ECB-HICP':      'HICP.M.U2.N.000000.4D0.ANR',       // headline, annual rate
  'ECB-CORE':      'HICP.M.U2.N.XEF000.4D0.ANR',       // ex energy & food
  'ECB-ENERGY':    'HICP.M.U2.N.NRGY00.4D0.ANR',
  'ECB-SERVICES':  'HICP.M.U2.N.SERV00.4D0.ANR',
  'ECB-FOOD':      'HICP.M.U2.N.FOOD00.4D0.ANR',
  'ECB-TRIM50':    'HICP.M.U2.N.TRIM50.4F0.ANR',       // trimmed mean, ECB-computed
};

// Parse SDMX-JSON (format=jsondata). Handles multi-series keys ("A+B").
function parseSdmxJson(j) {
  const ds = j.dataSets?.[0];
  if (!ds) return [];
  const sDims = j.structure?.dimensions?.series || [];
  const oDims = j.structure?.dimensions?.observation || [];
  const periods = (oDims[0]?.values || []).map(v => v.id);

  const out = [];
  for (const [skey, sval] of Object.entries(ds.series || {})) {
    const idx = skey.split(':').map(Number);
    const label = {};
    sDims.forEach((d, i) => { label[d.id] = d.values[idx[i]]?.id; });
    const data = [];
    for (const [pos, obs] of Object.entries(sval.observations || {})) {
      const v = Array.isArray(obs) ? obs[0] : obs;
      if (v != null) data.push({ date: periods[Number(pos)], value: v });
    }
    data.sort((a, b) => a.date < b.date ? -1 : 1);
    out.push({ key: sDims.map((d, i) => d.values[idx[i]]?.id).join('.'), dims: label, count: data.length, data });
  }
  return out;
}

async function fetchECB(seriesKey, { start, end, last } = {}) {
  const flow = seriesKey.split('.')[0];
  const rest = seriesKey.slice(flow.length + 1);
  const qs = new URLSearchParams({ format: 'jsondata', detail: 'dataonly' });
  if (last) qs.set('lastNObservations', String(last));
  else {
    if (start) qs.set('startPeriod', start);
    if (end)   qs.set('endPeriod', end);
  }
  const url = `${ECB_BASE}/${flow}/${rest}?${qs}`;
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'curl/8.5.0' }
  });
  if (r.status === 404) throw new Error(`ECB 404 — series key not found: ${seriesKey}. Check dataflow (ICP was replaced by HICP on 2026-02-04) and provider code (4D0 Eurostat / 4F0 ECB).`);
  if (!r.ok) throw new Error(`ECB ${flow}: ${r.status}`);
  const j = await r.json();
  const series = parseSdmxJson(j);
  return {
    requested: seriesKey, upstream: url,
    source: 'ECB Data Portal (SDMX 2.1)',
    fetched: new Date().toISOString(),
    series
  };
}

// Discovery: list available dimension codes for a dataflow.
async function fetchECBStructure(flow) {
  const url = `https://data-api.ecb.europa.eu/service/dataflow/ECB/${flow}?references=all&format=sdmx-json`;
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'curl/8.5.0' } });
  if (!r.ok) throw new Error(`ECB structure ${flow}: ${r.status}`);
  const j = await r.json();
  const dsd = j.data?.dataStructures?.[0];
  const cls = Object.fromEntries((j.data?.codelists || []).map(c => [c.id, c.codes?.map(x => x.id) || []]));
  return {
    flow, fetched: new Date().toISOString(),
    dimensions: (dsd?.dataStructureComponents?.dimensionList?.dimensions || [])
      .map(d => ({
        id: d.id, position: d.position,
        codelist: d.localRepresentation?.enumeration?.split('=').pop(),
        codes: (cls[d.localRepresentation?.enumeration?.split('=').pop()?.split(')').pop()] || []).slice(0, 400)
      }))
  };
}

// ─────────────────────────────────────────────────────────────
// Bank of Finland / FIN-FSA Open Data — Timeseries API v4
// Passthrough: ?bof=<DATASET>.<seriesName>&bofStart=YYYY-MM-DD&bofEnd=YYYY-MM-DD
// Discovery:   ?bofdatasets=1  |  ?bofstruct=<DATASET>
//              ?bofseries=<DATASET>&pageSize=&page=   — lists valid seriesName values
// No API key required. Docs: https://www.suomenpankki.fi/en/statistics/open-data/
//
// v4 base has NO /api segment (v3/api 404s outright — v3 is gone, not just
// deprecated), and every path segment is lowercase: datasets, structures,
// observations, series. Confirmed against the live API 2026-09-02.
// ─────────────────────────────────────────────────────────────
const BOF_BASE = 'https://api.boffsaopendata.fi/v4';

async function fetchBoF(datasetSeriesKey, { start, end } = {}) {
  const dot = datasetSeriesKey.indexOf('.');
  if (dot === -1) throw new Error(`BoF key must be "<DATASET>.<seriesName>", e.g. MFI_PUBL.M.A.0...  got: ${datasetSeriesKey}`);
  const dataset = datasetSeriesKey.slice(0, dot);
  const seriesName = datasetSeriesKey.slice(dot + 1);
  const qs = new URLSearchParams({ seriesName });
  if (start) qs.set('startPeriod', start);
  if (end)   qs.set('endPeriod', end);
  const url = `${BOF_BASE}/observations/${dataset}?${qs}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`BoF ${dataset}: ${r.status}`);
  const j = await r.json();
  return {
    requested: datasetSeriesKey, upstream: url,
    source: 'Bank of Finland / FIN-FSA Open Data (Timeseries API)',
    fetched: new Date().toISOString(),
    data: j
  };
}

async function fetchBoFDatasets() {
  const url = `${BOF_BASE}/datasets`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`BoF datasets: ${r.status}`);
  return { source: 'Bank of Finland / FIN-FSA Open Data (Timeseries API)', fetched: new Date().toISOString(), datasets: await r.json() };
}

async function fetchBoFStructure(dataset) {
  const url = `${BOF_BASE}/structures/${dataset}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`BoF structure ${dataset}: ${r.status}`);
  return { dataset, fetched: new Date().toISOString(), structure: await r.json() };
}

// Series listing — a distinct resource from Observations. This is how you
// discover valid seriesName values for a dataset before calling ?bof=; the
// old v3 code had no equivalent at all.
async function fetchBoFSeries(dataset, { pageSize, page } = {}) {
  const qs = new URLSearchParams();
  if (pageSize) qs.set('pageSize', pageSize);
  if (page)     qs.set('page', page);
  const q = qs.toString();
  const url = `${BOF_BASE}/series/${dataset}${q ? '?' + q : ''}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`BoF series ${dataset}: ${r.status}`);
  return { dataset, upstream: url, fetched: new Date().toISOString(), series: await r.json() };
}

// EPP = dataset 242 (Ennakoitu poikkeuspoisto)
async function fetchFingridEPP() {
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const url = `${FINGRID_BASE}/242/data?startTime=${start}&endTime=${end}&format=json&pageSize=5&sortBy=startTime&sortOrder=desc`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Fingrid EPP: ${r.status}`);
  const j = await r.json();
  const rows = j.data || j.rows || [];
  const latest = rows[0];
  return {
    series: 'FINGRID-EPP',
    source: 'Fingrid Open Data — dataset 242 (Ennakoitu poikkeuspoisto)',
    fetched: now.toISOString(),
    value: latest?.value ?? 0,
    startTime: latest?.startTime,
    endTime: latest?.endTime,
    data: rows.slice(0, 5)
  };
}

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

async function route(req) {
    const u = new URL(req.url);
    const series  = u.searchParams.get('series')  || 'FI10Y';
    const start   = u.searchParams.get('start')   || '2020-01';
    const end     = u.searchParams.get('end')     || new Date().toISOString().slice(0,7);
    const lang    = u.searchParams.get('lang')    || 'EN';

    try {
      // ── ECB SDMX ────────────────────────────────────────────
      // Raw passthrough: ?ecb=HICP.M.U2.N.000000.4D0.ANR&last=24
      const ecbKey = u.searchParams.get('ecb');
      const last   = u.searchParams.get('last');
      if (ecbKey) {
        return Response.json(await fetchECB(ecbKey, { start, end, last }), { headers: CORS });
      }
      // Structure discovery: ?struct=HICP
      const struct = u.searchParams.get('struct');
      if (struct) {
        return Response.json(await fetchECBStructure(struct), { headers: CORS });
      }
      // Named aliases
      if (ECB_ALIAS[series]) {
        const d = await fetchECB(ECB_ALIAS[series], { start, end, last });
        return Response.json({ series, ...d }, { headers: CORS });
      }
      // Inflation bundle: headline + core + energy + services in one call
      if (series === 'ECB-INFLATION') {
        const keys = ['ECB-HICP','ECB-CORE','ECB-ENERGY','ECB-SERVICES'];
        const res = await Promise.allSettled(keys.map(k => fetchECB(ECB_ALIAS[k], { start, end, last })));
        return Response.json({
          series: 'ECB-INFLATION', fetched: new Date().toISOString(), start, end,
          parts: Object.fromEntries(keys.map((k, i) => [k,
            res[i].status === 'fulfilled' ? res[i].value.series : { error: res[i].reason.message }]))
        }, { headers: CORS });
      }
      // Policy rate bundle
      if (series === 'ECB-RATES') {
        const keys = ['ECB-DFR','ECB-MRO','ECB-MLF'];
        const res = await Promise.allSettled(keys.map(k => fetchECB(ECB_ALIAS[k], { start, end, last })));
        return Response.json({
          series: 'ECB-RATES', fetched: new Date().toISOString(), start, end,
          parts: Object.fromEntries(keys.map((k, i) => [k,
            res[i].status === 'fulfilled' ? res[i].value.series : { error: res[i].reason.message }]))
        }, { headers: CORS });
      }

      // ── Bank of Finland / FIN-FSA ──────────────────────────
      const bofDatasets = u.searchParams.get('bofdatasets');
      if (bofDatasets) {
        return Response.json(await fetchBoFDatasets(), { headers: CORS });
      }
      const bofStruct = u.searchParams.get('bofstruct');
      if (bofStruct) {
        return Response.json(await fetchBoFStructure(bofStruct), { headers: CORS });
      }
      const bofSeries = u.searchParams.get('bofseries');
      if (bofSeries) {
        const pageSize = u.searchParams.get('pageSize');
        const page     = u.searchParams.get('page');
        return Response.json(await fetchBoFSeries(bofSeries, { pageSize, page }), { headers: CORS });
      }
      const bofKey = u.searchParams.get('bof');
      if (bofKey) {
        const bofStart = u.searchParams.get('bofStart');
        const bofEnd   = u.searchParams.get('bofEnd');
        return Response.json(await fetchBoF(bofKey, { start: bofStart, end: bofEnd }), { headers: CORS });
      }

      // Fingrid EPP
      if (series === 'FINGRID-EPP') {
        const data = await fetchFingridEPP();
        return Response.json(data, { headers: CORS });
      }

      // Eduskunta API — VNS 8/2025 käsittelyseuranta
      if (series === 'EDK-VNS82025') {
        const data = await fetchVNS82025();
        return Response.json(data, { headers: CORS });
      }

      // Valtiokonttori — YLEINEN passthrough kaikkiin kuuteen API-perheeseen.
      // ?vkapi=central-government-debt/v1/emtn-bond-issues&lang=FI
      // Perheet (avoindata.tutkihallintoa.fi > API):
      //   central-government-debt/v1   17 operaatiota, valtionvelka
      //   valtiontalous/v1             budjettitalous (CSV!)
      //   Financing and loans          lainat, korkotuet, VALTIONTAKAUKSET
      //   Tilikartta                   liikekirjanpidon tilikartta, 6 rajapintaa
      //   Kuntatalous                  kuntatalouden tiedot
      //   Valtion henkilöstö           henkilöstötiedot
      // Kolmen viimeisen polkutunnukset on luettava portaalista; nimeäminen
      // sekoittaa suomea ja englantia (central-government-debt vs valtiontalous),
      // joten niitä ei voi päätellä. Passthrough poistaa arvailun tarpeen.
      const vkapi = u.searchParams.get('vkapi');
      if (vkapi) {
        const pass = new URLSearchParams(
          [...u.searchParams].filter(([k]) => !['vkapi','series','start','end','last'].includes(k))
        ).toString();
        const url = `https://api.tutkihallintoa.fi/${vkapi}${pass ? '?' + pass : ''}`;
        const r = await fetch(url, { headers: { Accept: 'application/json, text/csv', 'User-Agent': UA_CSV } });
        const text = await r.text();
        if (!r.ok) throw new Error(`VK ${vkapi}: ${r.status} ${text.slice(0,200)}`);
        let data;
        try { data = JSON.parse(text); }
        catch {
          const lines = text.split(/\r?\n/).filter(l => l.trim());
          const d = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';
          const h = parseCsvLine(lines[0], d).map(x => x.replace(/^"|"$/g,''));
          data = lines.slice(1).map(l => {
            const v = parseCsvLine(l, d).map(x => x.replace(/^"|"$/g,''));
            return Object.fromEntries(h.map((k,i) => [k, v[i]]));
          });
        }
        return Response.json({
          api: vkapi, upstream: url,
          source: 'Valtiokonttori (CC BY 4.0)',
          upstream_version: `tutkihallintoa/${vkapi.split('/').slice(0,2).join('/')}`,
          data_class: 'authoritative',
          fetched: new Date().toISOString(),
          count: Array.isArray(data) ? data.length : undefined,
          data
        }, { headers: CORS });
      }

      // Valtiokonttori DEBT API — vapaa passthrough.
      // ?vkdebt=effective-cost-of-debt&lang=FI
      // Operaatiolista: avoindata.tutkihallintoa.fi > Central government debt v1.
      // Slugit ovat muuttuneet ainakin kerran (2026), joten niitä ei kovakoodata.
      if (u.searchParams.get('vkdebt')) {
        const ep = u.searchParams.get('vkdebt');
        const data = await fetchVKDebt(ep, lang);
        return Response.json({
          endpoint: ep,
          source: 'Valtiokonttori State Treasury Finland (CC BY 4.0)',
          upstream_version: 'tutkihallintoa/central-government-debt/v1',
          data_class: 'authoritative',
          fetched: new Date().toISOString(), data
        }, { headers: CORS });
      }

      // Valtiokonttori DEBT API
      if (VK_DEBT_ENDPOINTS[series]) {
        const data = await fetchVKDebt(VK_DEBT_ENDPOINTS[series], lang);
        return Response.json({ series, source:'Valtiokonttori State Treasury Finland',
          fetched:new Date().toISOString(), data }, { headers:CORS });
      }

      // Valtiokonttori BUDGET API — interest expenses pääluokka 36
      // Valtiokonttori budjettitapahtumat, vapaa passthrough.
      // ?vk=1&paaluokka=27&yearFrom=2024&yearTo=2026
      // ANSA: momentti ilman pisteita. 27.01.29 -> momentti=270129
      //       luku 27.01 -> luku=2701 ; paaluokka 27 -> paaluokka=27
      // Vahintaan yksi rajausparametri pakollinen. Ilman aikarajausta
      // upstream palauttaa kolme viimeisinta vuotta. Vastaus on CSV.
      // Kaikki muut parametrit valitetaan upstreamille sellaisenaan.
      if (u.searchParams.get('vk')) {
        const p = {};
        for (const [k, v] of u.searchParams) {
          if (!['vk', 'series', 'start', 'end', 'last'].includes(k)) p[k] = v;
        }
        const rows = await fetchVKBudget(p);
        const num = x => Number(String(x || '0').replace(/\s/g, '').replace(',', '.')) || 0;
        return Response.json({
          source: 'Valtiokonttori valtiontalous API (CC BY 4.0)',
          upstream_version: 'tutkihallintoa/valtiontalous/v1',
          data_class: 'authoritative (budget accounting)',
          fetched: new Date().toISOString(),
          params: p, count: rows.length,
          summa: {
            voimassaoleva_talousarvio: rows.reduce((a, r) => a + num(r['Voimassaoleva_talousarvio']), 0),
            nettokertyma:              rows.reduce((a, r) => a + num(r['Nettokertymä']), 0)
          },
          data: rows
        }, { headers: CORS });
      }

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
      if (SPREAD_MAP[series]) {
        const [g1,g2,l] = SPREAD_MAP[series];
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
        params:{
          common:'start=YYYY-MM  end=YYYY-MM  (Eurostat + ECB)',
          ecb:'last=N overrides start/end (lastNObservations)'
        },
        yields:['FI10Y','DE10Y','SE10Y','DK10Y'],
        spreads:['FI-DE','FI-SE','FI-DK','ALL'],
        ecb_aliases:Object.keys(ECB_ALIAS),
        ecb_bundles:['ECB-INFLATION','ECB-RATES'],
        ecb_passthrough:'?ecb=<full.sdmx.series.key>  e.g. ?ecb=HICP.M.U2.N.000000.4D0.ANR&last=24',
        ecb_discovery:'?struct=HICP  |  ?struct=FM  — lists dimension codes',
        bof_passthrough:'?bof=<DATASET>.<seriesName>&bofStart=YYYY-MM-DD&bofEnd=YYYY-MM-DD  e.g. ?bof=MFI_PUBL.M.A.0.A.A20.A.A.U6.2251.ZZ.Z01.H.A.0.A.0.A.0',
        bof_discovery:'?bofdatasets=1  — lists datasets  |  ?bofstruct=MFI_PUBL  — lists series/dimensions for a dataset  |  ?bofseries=MFI_PUBL&pageSize=50&page=0  — lists valid seriesName values for a dataset',
        vk_debt:Object.keys(VK_DEBT_ENDPOINTS),
        vk_budget:['VT-INTEREST (add ?yearFrom=2020&yearTo=2025)'],
        eduskunta:['EDK-VNS82025 — VNS 8/2025 käsittelyseuranta, TaVM-status']
      }, { status:400, headers:CORS });

    } catch(e) {
      return Response.json({ error:e.message, series }, { status:500, headers:CORS });
    }
}

// Ei Cache API:a (caches.default) — se ei toimi workers.dev-osoitteissa,
// koska välimuisti olisi vyöhyketasoinen ja jaettu kaikkien workers.dev-
// käyttäjien kesken. Sen sijaan Workers Cache: Cache-Control-otsikko
// riittää, kunhan wrangler.toml:ssa on [cache] enabled = true.
export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const res = await route(req);

    if (req.method === 'GET' && res.status === 200) {
      const ttl = ttlFor(new URL(req.url));
      if (ttl) res.headers.set('Cache-Control', `public, max-age=${ttl}`);
    }
    return res;
  }
};
