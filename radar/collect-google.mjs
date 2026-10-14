// LinkedIn FEED POSTS found through Google — headhunters and companies announce senior vacancies as posts, which no
// job board or ATS carries. Google's own Custom Search JSON API is closed to new customers (shutdown 2027-01-01), so
// the searches run through Apify's "Google Search Results Scraper" (apify/google-search-scraper), paid from the same
// FREE-plan credit ($5/month) the 7 am routine uses: $0.0045 per result page + $0.00005 per run.
//
// What ~30 live searches on 2026-10-13/14 showed, and why the list below is short:
//   - Google's date-filtered index of LinkedIn posts is THIN. Only short, broad searches return anything inside a
//     4-day window; a third condition or a long OR-list returns nothing. Queries are ordered by measured yield.
//   - Spanish searches return results ONLY with the English interface (languageCode 'en'; the actor's parser yields
//     nothing for hl=es). quickDateRange 'dN' == Google's "past N days".
//   - LinkedIn JOB pages, Workday pages and Colombian boards returned nothing inside the window (freshest hits were
//     11+ days old): LinkedIn's own search (collect-linkedin.mjs) and the career-ops Workday sweep are fresher, and
//     elempleo's robots.txt forbids automated reading. So this collector looks for posts only.
// Posts are dated from the activity id ((id >> 22) = ms since the Unix epoch, exact to the second), read logged-out,
// kept only when they mention a planning/supply topic AND hiring words, and carried as `feed_posts` for the routine
// to judge. Expect a few candidate posts a night, many of which the routine will discard.
//
// Budget guard: GET /v2/users/me/limits → spend (max − used − RESERVE) evenly over the days left in the cycle;
// RESERVE (default $0.30) stays for the routine's own Apify runs. Same UTC day → reuse that day's results from
// state/google-cache.json instead of searching again (a retried or forced run never pays twice; RADAR_GOOGLE_FRESH=1
// overrides). The token goes in an Authorization header, never in a URL. Never throws; always exits 0.
//
// Test without a token: RADAR_TODAY=2026-10-14 RADAR_GOOGLE_FIXTURE=radar/fixtures/google-serp.sample.json RADAR_GOOGLE_NO_FETCH=1 node radar/collect-google.mjs
// Output (stdout): {stats, jobs: [], feed_posts:[{url, author, posted, text, query, fetch_error}]}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.APIFY_TOKEN;
const FIXTURE = process.env.RADAR_GOOGLE_FIXTURE;
const NO_FETCH = process.env.RADAR_GOOGLE_NO_FETCH === '1';
const FRESH = process.env.RADAR_GOOGLE_FRESH === '1';
const CACHE = process.env.RADAR_GOOGLE_CACHE || path.join(ROOT, 'state/google-cache.json');
const DAYS = Number(process.env.RADAR_DAYS || 3);
const MAX_QUERIES = Number(process.env.RADAR_GOOGLE_MAX_QUERIES || 12);
const RESERVE = Number(process.env.RADAR_APIFY_RESERVE_USD || 0.30);
const MAX_POST_FETCH = Number(process.env.RADAR_GOOGLE_MAX_POSTS || 40);
const CHUNK = 5;                              // queries per Apify run (keeps each run well inside its timeout)
const PAGE_USD = 0.0045;                      // actor price per Google result page, FREE tier (pay-per-event, 2026-10)
const ACTOR = 'apify~google-search-scraper';
const API = 'https://api.apify.com/v2';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const today = /^\d{4}-\d{2}-\d{2}$/.test(process.env.RADAR_TODAY || '') ? process.env.RADAR_TODAY : new Date().toISOString().slice(0, 10);

let out = {
  stats: { backend: 'apify', queries_planned: 0, queries_skipped: 0, queries: 0, pages_charged: 0, usd_total: 0, results: 0, other_urls: 0, duplicates: 0, posts_found: 0, posts_old: 0, posts_offtopic: 0, post_fetches: 0, errors: [], by_query: {}, runs: [] },
  jobs: [], feed_posts: [],
};
const emit = () => process.stdout.write(JSON.stringify(out));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(`google: ${s}\n`);
const dec = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const ageDays = (d) => Math.floor((Date.parse(today) - Date.parse(d)) / 86400000);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// ── Searches, best measured yield first (the budget guard drops from the bottom). Keep each one SHORT. ──
const Q = [
  { id: 'co-vacante-planeacion', country: 'co', q: 'site:linkedin.com/posts vacante (gerente OR director OR jefe) planeación' },
  { id: 'co-buscamos-planeacion', country: 'co', q: 'site:linkedin.com/posts (vacante OR buscamos OR "estamos buscando") planeación Colombia' },
  { id: 'en-demand-planning', country: 'us', q: 'site:linkedin.com/posts "demand planning" hiring' },
  { id: 'co-vacante-supply-chain', country: 'co', q: 'site:linkedin.com/posts vacante "supply chain" Colombia' },
  { id: 'en-supply-planning', country: 'us', q: 'site:linkedin.com/posts "supply planning" hiring' },
  { id: 'co-vacante-abastecimiento', country: 'co', q: 'site:linkedin.com/posts vacante abastecimiento (gerente OR director OR jefe)' },
  { id: 'en-sop', country: 'us', q: 'site:linkedin.com/posts "S&OP" hiring' },
];
// The actor echoes each query as searchQuery.term (and as ?q= in searchQuery.url); match tolerantly.
const normQ = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const byTerm = new Map(Q.map((x) => [normQ(x.q), x]));
const queryMeta = (sq) => {
  let m = byTerm.get(normQ(sq?.term));
  if (!m && sq?.url) { try { m = byTerm.get(normQ(new URL(sq.url).searchParams.get('q'))); } catch { /* ignore */ } }
  return m;
};

// A post is kept only if it is about planning/supply AND reads like a vacancy (title + Google snippet + post text).
const PLAN_RE = /(planeaci[oó]n|planificaci[oó]n|planeador|planificador|planning|planner|s&op|s&oe|\bibp\b|supply chain|cadena de (abastecimiento|suministro)|abastecimiento|inventari|forecast|pron[oó]stico|demanda|demand)/i;
const HIRE_RE = /(vacante|buscamos|estamos buscando|se busca|b[uú]squeda|contratando|convocatoria|oportunidad|post[uú]late|aplica|[uú]nete|hiring|we'?re hiring|is hiring|join (our|the) team|looking for|open (role|position)|apply)/i;

// ── Apify REST: token in the Authorization header. Only idempotent calls are retried (a timed-out POST /runs may
// already have started — and be billing — a run, so it is never re-sent; HTTP 429 means nothing was created). ──
async function api(p, { method = 'GET', body, query, retry = method === 'GET' } = {}) {
  const u = new URL(API + p);
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (body) headers['Content-Type'] = 'application/json';
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try { r = await fetch(u, { method, headers, body, signal: AbortSignal.timeout(30000) }); } catch (e) {
      const msg = e?.name === 'TimeoutError' ? 'timeout' : (e?.cause?.code || e?.message || String(e));
      if (!retry || attempt === 2) return { ok: false, status: 0, error: msg };
      await sleep(3000 * (attempt + 1)); continue;
    }
    if (r.status === 429 && attempt < 2) { await sleep(5000 * (attempt + 1)); continue; }
    if (r.status >= 500 && retry && attempt < 2) { await sleep(3000 * (attempt + 1)); continue; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}: ${String(json?.error?.message || text).slice(0, 160)}` };
    return { ok: true, status: r.status, json };
  }
  return { ok: false, status: 0, error: 'retries exhausted' };
}

async function budget() {
  const r = await api('/users/me/limits');
  if (!r.ok) return { error: r.error };
  const d = r.json?.data || {};
  const used = Number(d.current?.monthlyUsageUsd), max = Number(d.limits?.maxMonthlyUsageUsd);
  const end = Date.parse(d.monthlyUsageCycle?.endAt || '');
  if (!Number.isFinite(used) || !Number.isFinite(max) || Number.isNaN(end)) return { error: 'unexpected limits payload' };
  const daysLeft = Math.max(1, Math.ceil((end - Date.now()) / 86400000));
  const perNight = Math.max(0, (max - used - RESERVE) / daysLeft);
  // Published: the allowance only — no account balances (the repo and its Actions logs are public).
  return { days_left: daysLeft, reserve_usd: RESERVE, per_night_usd: +perNight.toFixed(4), pages_allowed: Math.floor(perNight / PAGE_USD) };
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
async function startRun(country, queries) {
  const input = { queries: queries.map((x) => x.q).join('\n'), countryCode: country, languageCode: 'en', quickDateRange: `d${DAYS + 1}`, maxPagesPerQuery: 1, saveHtml: false, saveHtmlToKeyValueStore: false, includeUnfilteredResults: false, mobileResults: false };
  const run = { country, queries: queries.length, status: null, pages: null, usd: null, secs: null, error: null };
  // maxTotalChargeUsd is a cap, not a charge; 0.5 is the smallest value the actor accepts.
  const r = await api(`/acts/${ACTOR}/runs`, { method: 'POST', body: JSON.stringify(input), query: { timeout: 900, memory: 512, maxTotalChargeUsd: 0.5 }, retry: false });
  if (!r.ok) { run.status = 'NOT-STARTED'; run.error = r.error; return run; }
  Object.defineProperty(run, '_id', { value: r.json?.data?.id, enumerable: false });           // never published
  Object.defineProperty(run, '_dataset', { value: r.json?.data?.defaultDatasetId, enumerable: false });
  return run;
}
async function waitRun(run) {
  if (!run._id) return run;
  const deadline = Date.now() + 15 * 60000; let pollErrors = 0;
  while (Date.now() < deadline) {
    await sleep(10000);
    const r = await api(`/actor-runs/${run._id}`);
    if (!r.ok) { pollErrors++; continue; }                // transient: keep polling, report the count only
    const d = r.json?.data || {};
    if (!TERMINAL.has(d.status)) continue;
    run.status = d.status; run.usd = Number(d.usageTotalUsd ?? 0); run.pages = Number(d.chargedEventCounts?.['search-page-scraped'] ?? 0);
    run.secs = Math.round((Date.parse(d.finishedAt) - Date.parse(d.startedAt)) / 1000);
    if (d.status !== 'SUCCEEDED') run.error = d.statusMessage || d.status;
    if (pollErrors) run.poll_errors = pollErrors;
    return run;
  }
  run.status = 'POLL-TIMEOUT'; run.error = 'still running after 15 min — aborted; partial results used';
  await api(`/actor-runs/${run._id}/abort`, { method: 'POST', retry: true });                 // stop the billing
  return run;
}
async function runItems(run) {
  if (!run._dataset) return [];
  const r = await api(`/datasets/${run._dataset}/items`, { query: { clean: 'true', fields: 'searchQuery,organicResults' } });
  if (!r.ok) { run.error = `${run.error ? `${run.error}; ` : ''}dataset: ${r.error}`; return []; }
  return Array.isArray(r.json) ? r.json : [];
}

// ── SERP items → post candidates (country subdomains folded into www; one entry per activity id) ──
const canonPost = (u) => u.replace(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\//i, 'https://www.linkedin.com/').replace(/[?#].*$/, '');
const activityId = (u) => u.match(/(?:activity|ugcPost)-(\d{19})/)?.[1] || null;
const postDate = (u) => { const id = activityId(u); if (!id) return null; const ms = Number(BigInt(id) >> 22n); return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null; };
const seenPost = new Set(); const posts = [];
function ingest(item) {
  const meta = queryMeta(item?.searchQuery) || { id: 'unknown', q: String(item?.searchQuery?.term || '') };
  const g = (out.stats.by_query[meta.id] ||= { results: 0, posts: 0 });
  for (const o of Array.isArray(item?.organicResults) ? item.organicResults : []) {
    if (!o || typeof o !== 'object') continue;
    const raw = String(o.url || '').trim(); if (!/^https?:\/\//.test(raw)) continue;
    out.stats.results++; g.results++;
    if (!/linkedin\.com\/posts\//i.test(raw)) { out.stats.other_urls++; continue; }
    const url = canonPost(raw); const key = activityId(url) || url.toLowerCase();
    if (seenPost.has(key)) { out.stats.duplicates++; continue; }
    seenPost.add(key); g.posts++;
    const serpDate = o.date && !Number.isNaN(Date.parse(o.date)) ? new Date(o.date).toISOString().slice(0, 10) : null;
    posts.push({ url, query: meta.q, title: dec(o.title), snippet: dec(o.description), serp_date: serpDate });
  }
}

async function fetchPost(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const h = await r.text();
    if (/authwall|\/checkpoint\/|\/login\b/.test(r.url) && !/attributed-text-segment-list__content/.test(h)) return { error: 'authwall' };
    const body = h.match(/attributed-text-segment-list__content[^>]*>([\s\S]*?)<\/p>/)?.[1] || h.match(/property="og:description" content="([^"]*)"/)?.[1] || '';
    const author = h.match(/"author"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/)?.[1] || h.match(/data-tracking-control-name="public_post_feed-actor-name"[^>]*>([\s\S]*?)</)?.[1] || '';
    const published = h.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] || null;
    return { text: dec(body.replace(/<[^>]+>/g, ' ')), author: dec(author.replace(/<[^>]+>/g, ' ')), published: published ? published.slice(0, 10) : null };
  } catch (e) { return { error: e?.message || String(e) }; }
}

// ── Main ──
if (FIXTURE) {
  out.stats.backend = `fixture:${FIXTURE}`;
  for (const it of JSON.parse(readFileSync(FIXTURE, 'utf-8'))) ingest(it);
  out.stats.queries = out.stats.queries_planned = Q.length;
} else {
  let cached = null;
  if (!FRESH) { try { const c = JSON.parse(readFileSync(CACHE, 'utf-8')); if (c?.date === today && c.output?.stats) cached = c.output; } catch { /* no cache yet */ } }
  if (cached) {
    out = cached; out.stats.reused_same_day = true;
    log(`already searched today (${today}) — reusing those results instead of paying again (RADAR_GOOGLE_FRESH=1 to override)`);
    emit(); process.exit(0);
  }
  if (!TOKEN) {
    out.stats.skipped = 'not set up: APIFY_TOKEN missing (README → "LinkedIn posts via Google")';
    log(out.stats.skipped); emit(); process.exit(0);
  }
  const b = await budget();
  let allowed = MAX_QUERIES;
  if (b.error) { allowed = Math.min(allowed, 4); out.stats.errors.push({ stage: 'limits', error: b.error }); log(`credit check failed (${b.error}) — capping at ${allowed} searches`); }
  else { out.stats.budget = { ...b, low_credit: b.pages_allowed < Q.length }; allowed = Math.min(allowed, b.pages_allowed); }
  const planned = Q.slice(0, Math.max(0, allowed));
  out.stats.queries_planned = planned.length; out.stats.queries_skipped = Q.length - planned.length;
  if (!planned.length) {
    out.stats.skipped = 'Apify credit too low tonight — the rest is kept for the 7 am routine; searches resume as the credit allows (it renews monthly)';
    log(out.stats.skipped);
  } else {
    log(`${planned.length}/${Q.length} searches tonight (allowance $${b.per_night_usd ?? '?'} → ${b.pages_allowed ?? '?'} pages)`);
    const batches = [];
    for (const country of [...new Set(planned.map((x) => x.country))]) {
      const qs = planned.filter((x) => x.country === country);
      for (let i = 0; i < qs.length; i += CHUNK) batches.push([country, qs.slice(i, i + CHUNK)]);
    }
    const runs = [];
    for (const [country, qs] of batches) runs.push(await startRun(country, qs));   // free plan: 5 concurrent runs
    await Promise.all(runs.map(waitRun));
    for (const run of runs) {
      if (run.status === 'NOT-STARTED') { out.stats.errors.push({ stage: 'start', country: run.country, error: run.error }); continue; }
      for (const it of await runItems(run)) ingest(it);
      out.stats.queries += run.queries; out.stats.pages_charged += run.pages || 0; out.stats.usd_total = +(out.stats.usd_total + (run.usd || 0)).toFixed(4);
      if (run.error) out.stats.errors.push({ stage: 'run', country: run.country, status: run.status, error: run.error });
    }
    out.stats.runs = runs;
  }
}

// ── Posts: date from the id (free) → drop old → read the post → keep on-topic vacancies ──
out.stats.posts_found = posts.length;
let fetches = 0;
for (const p of posts) {
  let posted = postDate(p.url) || p.serp_date;
  if (posted && ageDays(posted) > DAYS) { out.stats.posts_old++; continue; }
  let text = p.snippet; let author = p.title; let fetchError = null;
  if (NO_FETCH) fetchError = 'skipped: RADAR_GOOGLE_NO_FETCH';
  else if (fetches >= MAX_POST_FETCH) fetchError = 'skipped: post-fetch cap';
  else {
    fetches++;
    const r = await fetchPost(p.url);
    if (r.error) fetchError = r.error; else { text = r.text || text; author = r.author || author; posted = posted || r.published; }
    await sleep(1500);
  }
  if (posted && ageDays(posted) > DAYS) { out.stats.posts_old++; continue; }
  const all = `${p.title} ${p.snippet} ${text}`;
  if (!PLAN_RE.test(all) || !HIRE_RE.test(all)) { out.stats.posts_offtopic++; continue; }
  out.feed_posts.push({ url: p.url, query: p.query, posted: posted || null, author, text: cut(text, 400), fetch_error: fetchError });
}
out.stats.post_fetches = fetches;
out.stats.posts_kept = out.feed_posts.length;
if (!FIXTURE && TOKEN) {
  try { mkdirSync(path.dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify({ date: today, output: out })); } catch (e) { log(`cache not written: ${e.message}`); }
}
log(`${out.stats.queries} searches, ${out.stats.pages_charged} pages, $${out.stats.usd_total}: ${out.stats.results} results → ${posts.length} posts (${out.stats.posts_old} older than ${DAYS} days, ${out.stats.posts_offtopic} off-topic) → ${out.feed_posts.length} kept (${out.stats.errors.length} errors)`);
emit();
