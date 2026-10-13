// Google results for the owner's playbook searches, through Apify's "Google Search Results Scraper"
// (apify/google-search-scraper). Google closed its own Custom Search JSON API to new customers in 2026 (shutdown
// 2027-01-01), so the date-filtered searches the playbook runs by hand go through Apify instead, paid from the
// same FREE-plan credit ($5/month) the 7 am routine uses: $0.0045 per result page + $0.00005 per run.
//
// Verified live 2026-10-13: Spanish queries return results ONLY with the English interface (languageCode 'en' —
// the actor's parser yields nothing for hl=es); quickDateRange 'dN' == Google's "past N days" (tbs=qdr:dN);
// site: operators work; organicResults carry {title, url, description, date?}; a 2-query run takes 2–3 minutes.
//
// Groups, in priority order (the budget guard truncates from the bottom):
//   feed-co         LinkedIn FEED POSTS announcing Colombian planning vacancies (headhunters post these, not job ads)
//   feed-latam      feed posts for remote / LATAM planning roles
//   jobs-worldwide  LinkedIn job pages that say they hire from anywhere (build.mjs confirms the phrase in the body)
//   jobs-latam      LinkedIn job pages mentioning Latin America + remote
//   boards-co       computrabajo / elempleo / Workday career sites with Colombian planning roles
// Budget guard: GET /v2/users/me/limits → spend (max − used − RESERVE) evenly over the days left in the cycle;
// RESERVE (default $0.30) stays for the routine's own Apify runs. Never throws; exits 0; stats explain everything.
//
// No-op without APIFY_TOKEN (README → "Google search via Apify").
// Test without a token: RADAR_GOOGLE_FIXTURE=radar/fixtures/google-serp.sample.json RADAR_GOOGLE_NO_FETCH=1 node radar/collect-google.mjs
// Output (stdout): {stats, jobs:[{source:'google:<group>', url, title, company, location, posted}], feed_posts:[{url, author, posted, text, query}]}

import { readFileSync } from 'node:fs';

const TOKEN = process.env.APIFY_TOKEN;
const FIXTURE = process.env.RADAR_GOOGLE_FIXTURE;
const NO_FETCH = process.env.RADAR_GOOGLE_NO_FETCH === '1';
const DAYS = Number(process.env.RADAR_DAYS || 3);
const MAX_QUERIES = Number(process.env.RADAR_GOOGLE_MAX_QUERIES || 14);
const RESERVE = Number(process.env.RADAR_APIFY_RESERVE_USD || 0.30);
const MAX_POST_FETCH = Number(process.env.RADAR_GOOGLE_MAX_POSTS || 40);
const PAGE_USD = 0.0045;                     // actor price per Google result page (pay-per-event, 2026-10)
const ACTOR = 'apify~google-search-scraper';
const API = 'https://api.apify.com/v2';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const out = { stats: { backend: 'apify', queries_planned: 0, queries: 0, pages_charged: 0, usd_total: 0, results: 0, errors: [], by_group: {}, runs: [] }, jobs: [], feed_posts: [] };
const emit = () => process.stdout.write(JSON.stringify(out));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(`google: ${s}\n`);
const dec = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const today = new Date().toISOString().slice(0, 10);
const ageDays = (d) => Math.floor((Date.parse(today) - Date.parse(d)) / 86400000);

// ── Queries: Spanish terms with the English interface; site: operators inside the query (one run = one country) ──
const Q = [];
const add = (group, country, ...qs) => { for (const q of qs) Q.push({ group, country, q }); };
add('feed-co', 'co',
  'site:linkedin.com/posts ("planeación de la demanda" OR "planeacion de la demanda" OR "demand planning") (vacante OR buscamos OR "estamos buscando" OR oportunidad OR hiring) Colombia',
  'site:linkedin.com/posts ("Director de Planeación" OR "Gerente de Planeación" OR "Jefe de Planeación" OR "Head of Planning") (Medellín OR Antioquia OR Bogotá OR Colombia)',
  'site:linkedin.com/posts ("S&OP" OR "IBP" OR "planeación de abastecimiento" OR "supply planning" OR "planeación de suministro") (gerente OR director OR jefe OR líder OR manager) Colombia',
  'site:linkedin.com/posts ("Director de Cadena de Abastecimiento" OR "Gerente de Cadena de Abastecimiento" OR "Director de Supply Chain" OR "Gerente de Supply Chain" OR "Gerente de Cadena de Suministro") (vacante OR buscamos OR "estamos buscando" OR oportunidad) Colombia',
  'site:linkedin.com/posts (#EmpleoMedellin OR #VacantesMedellin OR #EmpleoColombia OR #VacantesColombia OR #EmpleoBogota) (planeación OR "supply chain" OR abastecimiento OR "S&OP" OR demanda) (gerente OR director OR jefe OR líder)',
  'site:linkedin.com/posts (headhunting OR headhunter OR "búsqueda ejecutiva" OR "consultora de talento") (planeación OR "supply chain" OR abastecimiento) (gerente OR director) Colombia',
);
add('feed-latam', 'us',
  'site:linkedin.com/posts ("demand planning" OR "supply planning" OR "S&OP" OR IBP OR "integrated business planning") (manager OR director OR head OR lead) (remote OR remoto) ("Latin America" OR LATAM OR Colombia OR "open to applicants worldwide" OR "work from anywhere")',
);
add('jobs-worldwide', 'us',
  'site:linkedin.com/jobs/view ("open to applicants worldwide" OR "work from anywhere" OR "anywhere in the world" OR "remote worldwide") ("supply chain" OR planning OR inventory OR "S&OP" OR replenishment)',
);
add('jobs-latam', 'us',
  'site:linkedin.com/jobs/view ("Latin America" OR LATAM OR Colombia) remote ("demand planning" OR "supply planning" OR "S&OP" OR "inventory planning" OR "supply chain") (manager OR director OR head)',
);
add('boards-co', 'co',
  'site:co.computrabajo.com (jefe OR gerente OR director) (planeación OR "supply chain" OR abastecimiento OR demanda OR "S&OP")',
  'site:elempleo.com (jefe OR gerente OR director) (planeación OR "supply chain" OR abastecimiento OR "S&OP" OR demanda)',
  'site:myworkdayjobs.com ("demand planning" OR "supply planning" OR "S&OP" OR "materials planning" OR planeación OR abastecimiento) (Bogotá OR Medellín OR Colombia)',
);
// The actor echoes each query back as searchQuery.term (and inside searchQuery.url as ?q=); match it tolerantly —
// quotes, parentheses, '#' and '&' may come back normalised.
const normQ = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const byTerm = new Map(Q.map((x) => [normQ(x.q), x]));
const queryMeta = (sq) => {
  let m = byTerm.get(normQ(sq?.term));
  if (!m && sq?.url) { try { m = byTerm.get(normQ(new URL(sq.url).searchParams.get('q'))); } catch { /* ignore */ } }
  return m;
};

// ── Apify REST (token only in the query string; never logged) ──
async function api(p, { method = 'GET', body, query } = {}) {
  const u = new URL(API + p); u.searchParams.set('token', TOKEN);
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body, signal: AbortSignal.timeout(30000) });
      if ((r.status === 429 || r.status >= 500) && attempt < 2) { await sleep(3000 * (attempt + 1)); continue; }
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}: ${String(json?.error?.message || text).slice(0, 160)}` };
      return { ok: true, status: r.status, json };
    } catch (e) {
      if (attempt === 2) return { ok: false, status: 0, error: e?.name === 'TimeoutError' ? 'timeout' : (e?.cause?.code || e?.message || String(e)) };
      await sleep(3000);
    }
  }
  return { ok: false, status: 0, error: 'unknown' };
}

async function budget() {
  const r = await api('/users/me/limits');
  if (!r.ok) return { error: r.error };
  const d = r.json?.data || {};
  const used = Number(d.current?.monthlyUsageUsd ?? NaN), max = Number(d.limits?.maxMonthlyUsageUsd ?? NaN);
  const end = Date.parse(d.monthlyUsageCycle?.endAt || '');
  if (!Number.isFinite(used) || !Number.isFinite(max) || Number.isNaN(end)) return { error: 'unexpected limits payload' };
  const daysLeft = Math.max(1, Math.ceil((end - Date.now()) / 86400000));
  const remaining = max - used; const perNight = (remaining - RESERVE) / daysLeft;
  return { used: +used.toFixed(4), max, remaining: +remaining.toFixed(4), reserve: RESERVE, days_left: daysLeft, cycle_end: new Date(end).toISOString().slice(0, 10), per_night_usd: +perNight.toFixed(4), pages_allowed: Math.max(0, Math.floor(perNight / PAGE_USD)) };
}

async function startRun(country, queries) {
  const input = { queries: queries.map((x) => x.q).join('\n'), countryCode: country, languageCode: 'en', quickDateRange: `d${DAYS + 1}`, maxPagesPerQuery: 1, saveHtml: false, saveHtmlToKeyValueStore: false, includeUnfilteredResults: false, mobileResults: false };
  const run = { country, queries: queries.length, status: null, pages: null, usd: null, secs: null, error: null };
  // maxTotalChargeUsd is a cap, not a charge; 0.5 is the smallest value the actor accepts.
  const r = await api(`/acts/${ACTOR}/runs`, { method: 'POST', body: JSON.stringify(input), query: { timeout: 900, memory: 512, maxTotalChargeUsd: 0.5 } });
  if (!r.ok) { run.status = 'NOT-STARTED'; run.error = r.error; return run; }
  run.id = r.json?.data?.id; run.datasetId = r.json?.data?.defaultDatasetId;
  return run;
}
async function waitRun(run) {
  if (!run.id) return run;
  const deadline = Date.now() + 15 * 60000;
  while (Date.now() < deadline) {
    await sleep(10000);
    const r = await api(`/actor-runs/${run.id}`);
    if (!r.ok) { run.error = r.error; continue; }
    const d = r.json?.data || {};
    if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(d.status)) {
      run.status = d.status; run.usd = Number(d.usageTotalUsd ?? 0); run.pages = Number(d.chargedEventCounts?.['search-page-scraped'] ?? 0);
      run.secs = Math.round((Date.parse(d.finishedAt) - Date.parse(d.startedAt)) / 1000); run.message = d.statusMessage || null;
      return run;
    }
  }
  run.status = 'POLL-TIMEOUT'; run.error = 'still running after 15 min; partial dataset used'; return run;
}
async function runItems(run) {
  if (!run.datasetId) return [];
  const r = await api(`/datasets/${run.datasetId}/items`, { query: { clean: 'true', fields: 'searchQuery,organicResults,hasNextPage' } });
  if (!r.ok) { run.error = `dataset: ${r.error}`; return []; }
  return Array.isArray(r.json) ? r.json : [];
}

// ── SERP items → feed-post candidates / job candidates ──
const seenUrl = new Set(); const posts = [];
function ingest(item, run) {
  const meta = queryMeta(item?.searchQuery) || { group: 'unknown', q: item?.searchQuery?.term || '' };
  const g = (out.stats.by_group[meta.group] ||= { queries: 0, results: 0, posts: 0, jobs: 0 });
  g.queries++;
  for (const o of item?.organicResults || []) {
    const url = String(o.url || '').trim(); if (!/^https?:\/\//.test(url) || seenUrl.has(url)) continue; seenUrl.add(url);
    out.stats.results++; g.results++;
    const title = dec(o.title || '').replace(/\s*[|\-–]\s*LinkedIn$/i, '');
    const serpDate = o.date && !Number.isNaN(Date.parse(o.date)) ? new Date(o.date).toISOString().slice(0, 10) : '';
    if (/linkedin\.com\/posts\//.test(url)) { posts.push({ url, query: meta.q, snippet: dec(o.description || ''), title, serp_date: serpDate }); g.posts++; continue; }
    let job = null;
    if (/linkedin\.com\/jobs\/view\//.test(url)) {
      const m = title.match(/^(.*?) hiring (.*?)(?: in (.*))?$/); // "Company hiring Title in City"
      job = { source: `google:${/^jobs-/.test(meta.group) ? meta.group : 'jobs-latam'}`, title: m ? m[2] : title, company: m ? m[1] : '', location: m ? m[3] || '' : '' };
    } else if (/\.myworkdayjobs\.com\//.test(url)) {
      // Company = Workday tenant; location comes from the posting itself in build.mjs (fetchWorkday).
      job = { source: 'google:boards-co', title: title.split(/\s[|–-]\s/)[0], company: url.match(/^https?:\/\/([^.]+)\./)?.[1] || '', location: '' };
    } else if (/computrabajo\.com|elempleo\.com/.test(url)) {
      // Board page titles mix title/city/company in varying orders; keep the first segment and let the page's
      // JSON-LD (hiringOrganization, jobLocation) fill company/location in build.mjs.
      job = { source: 'google:boards-co', title: title.split(/\s[|–-]\s/)[0] || title, company: '', location: '' };
    }
    if (!job) { out.stats.other_urls = (out.stats.other_urls || 0) + 1; continue; }
    out.jobs.push({ ...job, url, posted: serpDate }); g.jobs++;
  }
  if (run) run.items = (run.items || 0) + 1;
}

// LinkedIn post URL → publication date from the activity / ugcPost id ((id >> 22) = ms since the Unix epoch; exact to the second).
const postDate = (url) => { const m = url.match(/(?:activity|ugcPost)-(\d{19})/); if (!m) return null; const ms = Number(BigInt(m[1]) >> 22n); return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null; };
async function fetchPost(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const h = await r.text();
    if (/authwall|\/checkpoint\/|\/login\b/.test(r.url) && !/attributed-text-segment-list__content/.test(h)) return { error: 'authwall' };
    const body = h.match(/attributed-text-segment-list__content[^>]*>([\s\S]*?)<\/p>/)?.[1] || h.match(/property="og:description" content="([^"]*)"/)?.[1] || '';
    const author = h.match(/"author"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/)?.[1] || h.match(/data-tracking-control-name="public_post_feed-actor-name"[^>]*>([\s\S]*?)</)?.[1] || '';
    const published = h.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] || null;
    return { text: dec(body.replace(/<[^>]+>/g, ' ')).slice(0, 1500), author: dec(author.replace(/<[^>]+>/g, ' ')), published: published ? published.slice(0, 10) : null };
  } catch (e) { return { error: e?.message || String(e) }; }
}

// ── Main ──
if (FIXTURE) {
  out.stats.backend = `fixture:${FIXTURE}`;
  for (const it of JSON.parse(readFileSync(FIXTURE, 'utf-8'))) ingest(it, null);
  out.stats.queries = out.stats.queries_planned = Q.length;
} else if (!TOKEN) {
  out.stats.skipped = 'APIFY_TOKEN not set — Google searches skipped (setup in README → "Google search via Apify")';
  log(out.stats.skipped); emit(); process.exit(0);
} else {
  const b = await budget(); out.stats.budget = b;
  let allowed = MAX_QUERIES;
  if (b.error) { allowed = Math.min(allowed, 6); out.stats.errors.push({ stage: 'limits', error: b.error }); log(`limits check failed (${b.error}) — capping at ${allowed} queries`); }
  else allowed = Math.min(allowed, b.pages_allowed);
  const planned = Q.slice(0, allowed);
  out.stats.queries_planned = planned.length; out.stats.queries_skipped = Q.length - planned.length;
  if (!planned.length) {
    out.stats.skipped = `Apify credit: $${b.remaining} left for ${b.days_left} day(s) of the cycle (reserve $${RESERVE} kept for the routine) — no Google searches tonight`;
    log(out.stats.skipped);
  } else {
    log(`${planned.length}/${Q.length} queries (budget: $${b.remaining ?? '?'} left, ${b.days_left ?? '?'} days, $${b.per_night_usd ?? '?'}/night → ${b.pages_allowed ?? '?'} pages)`);
    const groups = new Map();
    for (const x of planned) (groups.get(x.country) || groups.set(x.country, []).get(x.country)).push(x);
    const runs = [];
    for (const [country, qs] of groups) runs.push(await startRun(country, qs));   // ≤ 3 parallel runs (free plan allows 5)
    await Promise.all(runs.map(waitRun));
    for (const run of runs) {
      if (run.status === 'NOT-STARTED') { out.stats.errors.push({ stage: 'start', country: run.country, error: run.error }); continue; }
      const items = await runItems(run);
      for (const it of items) ingest(it, run);
      out.stats.queries += run.queries; out.stats.pages_charged += run.pages || 0; out.stats.usd_total = +(out.stats.usd_total + (run.usd || 0)).toFixed(4);
      if (run.status !== 'SUCCEEDED' || run.error) out.stats.errors.push({ stage: 'run', country: run.country, status: run.status, error: run.error || run.message });
      delete run.datasetId;
    }
    out.stats.runs = runs;
  }
}

// Feed posts: date from the id first (free), fetch only those inside the window.
let fetched = 0;
for (const p of posts) {
  const d = postDate(p.url) || p.serp_date || null;
  if (d && ageDays(d) > DAYS) { out.stats.posts_old = (out.stats.posts_old || 0) + 1; continue; }
  if (NO_FETCH) { out.feed_posts.push({ url: p.url, query: p.query, posted: d, author: p.title, text: p.snippet, fetch_error: 'skipped: RADAR_GOOGLE_NO_FETCH' }); continue; }
  if (fetched >= MAX_POST_FETCH) { out.stats.posts_skipped = (out.stats.posts_skipped || 0) + 1; continue; }
  fetched++;
  const r = await fetchPost(p.url);
  out.feed_posts.push({ url: p.url, query: p.query, posted: d || r.published || null, author: r.author || p.title, text: r.text || p.snippet, fetch_error: r.error || null });
  await sleep(1500);
}
out.stats.feed_candidates = posts.length; out.stats.feed_fetched = fetched;
log(`${out.stats.queries} queries, ${out.stats.pages_charged} pages, $${out.stats.usd_total}, ${out.stats.results} results → ${out.jobs.length} job links, ${out.feed_posts.length} feed posts in window (${out.stats.errors.length} errors)`);
emit();
