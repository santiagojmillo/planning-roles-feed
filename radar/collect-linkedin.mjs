// LinkedIn public jobs listing (guest endpoint, no login, no key).
// Lanes map LinkedIn location strings → keyword lists; every (location, keyword) pair is one query
// over postings from the last 3 days (f_TPR=r259200), paginated up to MAX_START.
// Remote-ness is decided downstream from the posting body, so the per-country LATAM lanes do not
// require "remote" in their keywords.
//
// Env:  RADAR_LI_LANES=mexico,latam-remote   run only these lanes (comma list; default: all)
//       RADAR_LI_TPR=r259200                  time window (LinkedIn f_TPR value)
//       RADAR_LI_MAX_CONSECUTIVE_FAILS=8      skip the rest after N consecutive queries with no page (0 = never)
//       RADAR_LI_MAX_MINUTES=150              skip the rest once the run exceeds this budget (0 = never);
//                                             the full matrix is 70 queries (Boolean lanes); ~43 s/query under
//                                             a 20% 429 rate, i.e. ~40 min
// Output (stdout): {stats, jobs:[{source:'linkedin:<lane>', url, title, company, location, posted}]}
//   stats.queries[]        {lane, loc, kw, status, pages, cards[, error]} — one per (location, keyword) query
//   stats.failed_queries[] {lane, loc, kw, status} — the ones whose last page request did not succeed
//   status is 200, another HTTP code, 'error' (network/timeout), 'authwall' (200 but a login/challenge page)
//   or 'skipped' (breaker / time budget). Totals: total_queries, pages, cards, unique, blocked, by_lane.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,es;q=0.8,pt;q=0.7' };
const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const WINDOW = process.env.RADAR_LI_TPR || 'r259200'; // 3 days
const MAX_START = 50; // up to 5 pages of 10 cards per query

const PAGE_DELAY_MS = 1500; // >= 1.5 s between page requests of one query
const QUERY_DELAY_MS = 1000; // >= 1.0 s between queries
const RETRY_BACKOFF_MS = [5000, 15000, 40000]; // up to 3 retries on 429/999/5xx/network error
const RATE_LIMIT_PAUSE_MS = 20000; // extra pause after any 429/999
const FETCH_TIMEOUT_MS = 30000;
const MAX_CONSECUTIVE_FAILS = Number(process.env.RADAR_LI_MAX_CONSECUTIVE_FAILS ?? 8);
const MAX_MINUTES = Number(process.env.RADAR_LI_MAX_MINUTES ?? 150);

// ── Lanes ──
// Boolean searches from the owner's playbook (2026-10-06). Verified on the public endpoint 2026-10-13: the C1
// string returned 10/10 manager-level cards where the plain keyword "demand planning" returned 4/10, so one
// Boolean query replaces a dozen plain ones (58 queries total instead of 127). AND / OR / NOT must be upper-case.
const C1 = '("demand planning" OR "supply planning" OR "S&OP" OR "IBP" OR "integrated business planning" OR "SIOP" OR "S&OE" OR "inventory planning" OR replenishment) AND (manager OR lead OR head OR director) NOT (media OR advertising OR intern)';
const C2 = '("planeación de la demanda" OR "planeacion de la demanda" OR "planificación de la demanda" OR abastecimiento OR "S&OP" OR inventarios OR reabastecimiento) AND (gerente OR jefe OR líder OR director) NOT (practicante OR aprendiz OR auxiliar OR medios OR publicidad)';
const C_REMOTE = '("demand planning" OR "supply planning" OR "S&OP" OR "IBP" OR "inventory planning" OR "supply chain planning") AND (manager OR head OR director OR lead) AND (remote OR remoto OR "work from home") NOT intern';
const PT = '("demand planning" OR "supply planning" OR "S&OP" OR planejamento) AND (Portuguese OR português OR Brazil OR Brasil OR LATAM) AND (manager OR head OR director OR regional OR gerente)';
const DTC = '(replenishment OR "inventory planning" OR "open to buy" OR "supply chain manager" OR "head of supply chain") AND (Shopify OR ecommerce OR e-commerce OR DTC OR Amazon OR "consumer brand") AND (manager OR head OR director)';
const RARE = '(CPIM OR APICS OR DDMRP OR "contract manufacturers" OR "excess and obsolete") AND (planning OR "supply chain") AND (manager OR head OR director OR lead)';
// Roles that say they hire from anywhere — the body must confirm it (build.mjs drops 'worldwide' items whose text lacks the
// phrase, unless the title passes the normal filter and the role sits in a Colombia/LATAM/Spain lane on its own merits).
const WORLDWIDE = [
  '"open to applicants worldwide" ("supply chain" OR planning OR operations OR inventory)',
  '("work from anywhere" OR "remote worldwide" OR "globally distributed" OR "anywhere in the world") AND ("supply chain" OR planning OR inventory)',
  '("LATAM" OR "Latin America" OR Colombia) AND ("demand planning" OR "supply planning" OR "S&OP" OR "inventory planning" OR "supply chain manager") AND (remote OR contractor)',
];

// Operations leadership at companies hiring remotely in LATAM (owner, 2026-10-17: Space Inch "Director of Operations –
// LATAM", an American company's LinkedIn posting, reached a video interview but no planning query could find it).
// The 'United States' location needs a LATAM word in the query, or US on-site ops roles flood the results.
const OPS_LATAM = '("director of operations" OR "head of operations" OR "operations director" OR "VP of operations" OR "business operations" OR "senior operations manager") AND (LATAM OR "Latin America" OR Colombia OR "South America")';
const OPS_REMOTE = '("director of operations" OR "head of operations" OR "operations director" OR "head of business operations" OR "business operations director") AND (remote OR remoto)';
const OPS_ES = '("director de operaciones" OR "gerente de operaciones" OR "director of operations" OR "head of operations") NOT (planta OR producción OR bodega OR CEDI OR tienda OR restaurante OR practicante)';

// Planner-level roles (owner, 2026-10-20, after missing D&G "DG Americas Commercial Planner Travel Retail", Colombia): every
// query above requires manager/lead/head/director, so planner titles never came back. These ask for the planning titles
// alone — demand / supply / supply chain / commercial planner or planning, in English and Spanish, plain and with LATAM.
const PL_EN = '("demand planner" OR "supply planner" OR "supply chain planner" OR "commercial planner" OR "demand planning" OR "supply planning" OR "supply chain planning") NOT (intern OR media OR advertising OR event)';
const PL_ES = '("planeador de demanda" OR "planeador de abastecimiento" OR "planificador de demanda" OR "planeación de la demanda" OR "planificación de la demanda" OR "planeación de abastecimiento" OR "planeación de la cadena de suministro" OR "planeación de la cadena de abastecimiento") NOT (practicante OR aprendiz OR auxiliar)';
const PL_LATAM_EN = '("demand planner" OR "supply planner" OR "supply chain planner" OR "commercial planner" OR "demand planning" OR "supply planning" OR "supply chain planning") AND (LATAM OR "Latin America" OR Americas)';
const PL_LATAM_ES = '(planeador OR planificador OR "planeación de la demanda" OR "planificación de la demanda" OR "planeación de abastecimiento" OR "planeación de la cadena de suministro") AND (LATAM OR Latinoamérica OR "América Latina")';

const LANES = {
  colombia: { locs: ['Medellín, Antioquia, Colombia', 'Bogotá, D.C., Capital District, Colombia', 'Colombia'], kws: [C2, C1, 'planeación', 'S&OP', 'abastecimiento'] },
  'us-remote': { locs: ['United States'], kws: [C_REMOTE, 'remote demand planning', 'remote S&OP', 'remote supply planning manager', 'remote inventory planning manager', 'remote head of planning', RARE] },
  madrid: { locs: ['Madrid, Community of Madrid, Spain'], kws: [C1, 'demand planning', 'S&OP', 'IBP'] },
  spain: { locs: ['Spain'], kws: [C_REMOTE, 'LATAM supply chain', 'LATAM demand planning', 'Latin America supply chain', 'remote S&OP'] },
  'latam-remote': { locs: ['Latin America'], kws: [C_REMOTE, C1, C2, 'remote demand planning', PT] },
  mexico: { locs: ['Mexico'], kws: [C1, C2] },
  argentina: { locs: ['Argentina'], kws: [C1, C2] },
  chile: { locs: ['Chile'], kws: [C1, C2] },
  peru: { locs: ['Peru'], kws: [C1, C2] },
  brazil: { locs: ['Brazil'], kws: [C1, PT, 'planejamento de demanda'] },
  worldwide: { locs: ['United States', 'Latin America', 'Colombia'], kws: WORLDWIDE, maxStart: 10 },
  dtc: { locs: ['United States', 'Latin America'], kws: [DTC], maxStart: 30 },
  'ops-latam': { locs: ['United States', 'Latin America'], kws: [OPS_LATAM], maxStart: 30 },
  'ops-remote': { locs: ['Latin America', 'Colombia'], kws: [OPS_REMOTE, OPS_ES], maxStart: 30 },
  'planner-co': { locs: ['Colombia'], kws: [PL_EN, PL_ES] },
  'planner-latam': { locs: ['Latin America', 'United States'], kws: [PL_LATAM_EN, PL_LATAM_ES], maxStart: 30 },
};

const requested = (process.env.RADAR_LI_LANES || '').split(',').map((s) => s.trim()).filter(Boolean);
const unknown = requested.filter((l) => !LANES[l]);
if (unknown.length) {
  process.stderr.write(`linkedin: unknown lane(s) ${unknown.join(', ')}; valid: ${Object.keys(LANES).join(', ')}\n`);
  process.exit(2);
}
const lanes = requested.length ? [...new Set(requested)] : Object.keys(LANES);
const queries = lanes.flatMap((lane) => LANES[lane].locs.flatMap((loc) => LANES[lane].kws.map((kw) => ({ lane, loc, kw }))));

// ── Helpers ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * 400); // only ever adds, so minimum spacing holds
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const isRateLimit = (status) => status === 429 || status === 999 || status === 'authwall';
const isRetryable = (status) => status === 'error' || isRateLimit(status) || (typeof status === 'number' && status >= 500);

function parseCards(html) {
  const cards = html.split(/<li[\s>]/).slice(1);
  const out = [];
  for (const c of cards) {
    const id = c.match(/urn:li:jobPosting:(\d+)/)?.[1];
    if (!id) continue;
    const title = c.match(/base-search-card__title[^>]*>([\s\S]*?)</)?.[1];
    const company = (c.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/)?.[1] || '').replace(/<[^>]+>/g, ' ');
    const location = c.match(/job-search-card__location[^>]*>([\s\S]*?)</)?.[1];
    const posted = c.match(/datetime="(\d{4}-\d{2}-\d{2})"/)?.[1];
    out.push({ id, title: decode(title || ''), company: decode(company || ''), location: decode(location || ''), posted: posted || '' });
  }
  return out;
}

// ── Stats ──
const stats = {
  lanes,
  window: WINDOW,
  total_queries: queries.length,
  pages: 0,
  cards: 0,
  unique: 0,
  blocked: 0, // queries whose last page request did not return 200 (includes skipped)
  rate_limited: 0, // 429/999/authwall responses seen, retries included
  retries: 0,
  elapsed_s: 0,
  by_lane: Object.fromEntries(lanes.map((l) => [l, { queries: 0, pages: 0, cards: 0, unique: 0, failed: 0 }])),
  failed_queries: [], // {lane, loc, kw, status}
  queries: [], // {lane, loc, kw, status, pages, cards[, error]}
};

// Fetch one page. Resolves to {status, html[, error]} where status is 200, another HTTP code, 'authwall' or
// 'error' (network failure / timeout). 429/999/authwall/5xx/network errors are retried with 5 s → 15 s → 40 s
// backoff, and every 429/999/authwall adds an extra RATE_LIMIT_PAUSE_MS before anything else happens.
async function fetchPage(kw, loc, start) {
  const url = `${BASE}?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&f_TPR=${WINDOW}&start=${start}`;
  for (let attempt = 0; ; attempt++) {
    let status = 'error';
    let error;
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const html = await res.text();
        // A guest that looks like a bot gets redirected to the authwall / a challenge page: HTTP 200, no cards.
        // A genuine empty result is a ~26-byte body, so a big card-less body is a block, not "no results".
        const walled = (res.redirected && /authwall|checkpoint|login|challenge/i.test(res.url)) || (html.length > 5000 && !/urn:li:jobPosting:/.test(html));
        if (!walled) return { status: 200, html };
        status = 'authwall';
      } else {
        status = res.status;
        await res.text().catch(() => {}); // drain the body so the connection can be reused
      }
    } catch (e) {
      const cause = e?.cause;
      error = e?.name === 'TimeoutError' ? 'timeout' : (cause?.code || cause?.errors?.[0]?.code || cause?.message || e?.message || String(e));
    }
    if (isRateLimit(status)) { stats.rate_limited++; await sleep(RATE_LIMIT_PAUSE_MS); }
    if (!isRetryable(status) || attempt >= RETRY_BACKOFF_MS.length) return { status, html: '', error };
    stats.retries++;
    await sleep(RETRY_BACKOFF_MS[attempt]);
  }
}

// ── Main loop ──
const t0 = Date.now();
const seen = new Map();
let consecutiveFails = 0;
for (const q of queries) {
  const rec = { lane: q.lane, loc: q.loc, kw: q.kw, status: 200, pages: 0, cards: 0 };
  const overBudget = MAX_MINUTES > 0 && Date.now() - t0 > MAX_MINUTES * 60_000;
  const tripped = MAX_CONSECUTIVE_FAILS > 0 && consecutiveFails >= MAX_CONSECUTIVE_FAILS;
  if (overBudget || tripped) {
    rec.status = 'skipped';
    rec.error = overBudget ? `time budget of ${MAX_MINUTES} min exceeded` : `${consecutiveFails} consecutive queries with no page`;
  } else {
    const maxStart = LANES[q.lane].maxStart ?? MAX_START; // phrase lanes are padded with fuzzy matches: fewer pages
    for (let start = 0; start < maxStart;) {
      if (start > 0) await sleep(jitter(PAGE_DELAY_MS));
      const page = await fetchPage(q.kw, q.loc, start);
      rec.status = page.status;
      if (page.error) rec.error = page.error;
      if (page.status !== 200) break;
      rec.pages++;
      const cards = parseCards(page.html);
      rec.cards += cards.length;
      for (const c of cards) {
        if (!seen.has(c.id)) { seen.set(c.id, { ...c, lane: q.lane }); stats.by_lane[q.lane].unique++; }
      }
      if (cards.length < 10) break;
      start += cards.length;
    }
    consecutiveFails = rec.pages > 0 ? 0 : consecutiveFails + 1;
    await sleep(jitter(QUERY_DELAY_MS));
  }
  const bl = stats.by_lane[q.lane];
  bl.queries++; bl.pages += rec.pages; bl.cards += rec.cards;
  stats.pages += rec.pages; stats.cards += rec.cards;
  stats.queries.push(rec);
  if (rec.status !== 200) {
    stats.blocked++; bl.failed++;
    stats.failed_queries.push({ lane: rec.lane, loc: rec.loc, kw: rec.kw, status: rec.status });
  }
}
stats.unique = seen.size;
stats.elapsed_s = Math.round((Date.now() - t0) / 1000);

const jobs = [...seen.values()].map((c) => ({
  source: `linkedin:${c.lane}`,
  url: `https://www.linkedin.com/jobs/view/${c.id}`,
  title: c.title, company: c.company, location: c.location, posted: c.posted,
}));
process.stderr.write(`linkedin: lanes=${lanes.join(',')} ${stats.total_queries} queries, ${stats.pages} pages, ${stats.cards} cards, ${stats.unique} unique, ${stats.blocked} blocked/failed queries, ${stats.rate_limited} rate-limit responses, ${stats.retries} retries, ${stats.elapsed_s}s\n`);
for (const [l, b] of Object.entries(stats.by_lane)) process.stderr.write(`linkedin:   ${l}: ${b.queries} queries, ${b.pages} pages, ${b.cards} cards, ${b.unique} unique, ${b.failed} failed\n`);
for (const f of stats.failed_queries) process.stderr.write(`linkedin:   failed [${f.lane}] "${f.kw}" @ ${f.loc}: ${f.status}\n`);
process.stdout.write(JSON.stringify({ stats, jobs }));
