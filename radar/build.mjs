// Merge all collector output into out/latest.json + out/latest.md.
// Pipeline: candidates → undated → age → title filter → aggregator drop → dedup within run →
// already_seen → DETAIL FETCH + classify (radar/classify.mjs) → lane / drop → write.
// Rules: first-published ≤ RADAR_DAYS (default 3) days ago, planning title, the owner's
// eligibility rules on location + posting body (classify.mjs → assignLane), not seen before.
//
// Usage: node radar/build.mjs <career-ops dir> [--dry-run]
//   --dry-run             write to out/dry-run/ instead of out/; never touch state/seen.json
//   RADAR_DAYS=3          age window (days)
//   RADAR_MAX_DETAIL=150  cap on detail fetches per run (Colombia / Spain / LATAM / US-country first)
//   RADAR_SKIP_DETAIL=1   no network: lane from location + title only (tests)
//   RADAR_IGNORE_SEEN=1   start from an empty seen-set (tests; combine with --dry-run)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, extractFields, assignLane, parseRelativeDate, excerpt, geo, locationQualifiesAlone } from './classify.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const CO = path.resolve(args.find((a) => !a.startsWith('--')) || 'career-ops');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAYS = Number(process.env.RADAR_DAYS || 3);
const MAX_DETAIL = process.env.RADAR_MAX_DETAIL === undefined || process.env.RADAR_MAX_DETAIL === '' ? 150 : Number(process.env.RADAR_MAX_DETAIL);
const SKIP_DETAIL = process.env.RADAR_SKIP_DETAIL === '1';
const OUT = path.join(ROOT, DRY ? 'out/dry-run' : 'out');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const yaml = createRequire(path.join(CO, 'package.json'))('js-yaml');

const now = new Date();
const today = now.toISOString().slice(0, 10);
const ageDays = (d) => Math.floor((Date.parse(today) - Date.parse(d)) / 86400000);
const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return dflt; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(`${s}\n`);

// ── Title matcher (career-ops keyword language: plain / word: / stem: / " + ") ──
const portals = yaml.load(readFileSync(path.join(ROOT, 'config/portals.yml'), 'utf-8'));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function kwTest(kw, title) {
  if (kw.includes(' + ')) return kw.split(' + ').every((k) => kwTest(k.trim(), title));
  let mode = 'plain'; let k = kw;
  if (k.startsWith('word:')) { mode = 'word'; k = k.slice(5); } else if (k.startsWith('stem:')) { mode = 'stem'; k = k.slice(5); }
  if (mode === 'plain' && /^[A-Za-z]{2,3}$/.test(k)) mode = 'word';
  const re = mode === 'word' ? new RegExp(`(^|[^\\p{L}\\p{N}])${esc(k)}($|[^\\p{L}\\p{N}])`, 'iu')
    : mode === 'stem' ? new RegExp(`(^|[^\\p{L}\\p{N}])${esc(k)}`, 'iu') : new RegExp(esc(k), 'i');
  return re.test(title);
}
// Two title nets, as in career-ops: the broad sweep + LinkedIn/boards use the stricter `title_filter_full`;
// postings that career-ops scan.mjs already accepted from a TRACKED board (source 'ats') are re-checked only
// against the main `title_filter`, otherwise vendor consulting titles (RELEX, Westernacher…) that pass scan.mjs
// would be thrown away here.
const tff = portals.title_filter_full || portals.title_filter;
const tfMain = portals.title_filter || tff;
const passes = (tf, t) => tf.positive.some((k) => kwTest(k, t)) && !tf.negative.some((k) => kwTest(k, t));
// The 'worldwide' LinkedIn lane searches for roles that SAY they hire from anywhere; any supply-chain/planning/
// operations title may carry that, so it only has to clear the negative list. The loose title is allowed only
// because the body must then confirm the phrase ('phrase-not-in-body' otherwise). One exception: a role whose
// title also passes the normal title filter and whose lane is a real one (Colombia, LATAM, Spain) keeps that lane
// — it would have qualified through any other source. Long-shot lanes always need the phrase.
const WORLDWIDE = new Set(['linkedin:worldwide']);
const PHRASE_LANES = new Set(['us-remote-unstated', 'remote-other-intl']);
const LOOSE_SC = /(supply|planning|planeaci|planific|inventor|s&op|\bibp\b|operations|operaciones|logistic|log[ií]stica|procurement|sourcing|abastec|fulfil)/i;
// Startup boards (collect-startups.mjs: YC, HN) use the main filter too: startup titles such as "Head of Operations" or
// "Supply Chain Manager" are the owner's DTC archetype but fail the stricter reverse-sweep net.
const MAIN_FILTER_SOURCES = new Set(['ats', 'yc', 'hn']);
const titleOk = (t, source) => (WORLDWIDE.has(source)
  ? LOOSE_SC.test(t) && !tff.negative.some((k) => kwTest(k, t))
  : passes(MAIN_FILTER_SOURCES.has(source) ? tfMain : tff, t));

// ── Aggregator drop list (config/portals.yml: aggregator_companies) ──
const AGGREGATORS = (Array.isArray(portals.aggregator_companies) ? portals.aggregator_companies : ['jobgether', 'ladders', 'jobicy', 'remotestack', 'remote rocketship'])
  .map((s) => String(s).toLowerCase().trim()).filter(Boolean);
const isAggregator = (j) => {
  const c = (j.company || '').toLowerCase(); const u = (j.url || '').toLowerCase();
  return AGGREGATORS.some((a) => c.includes(a) || (a.length >= 6 && u.includes(a.replace(/\s+/g, ''))));
};

// ── Gather candidates ──
const cands = [];
const sources = {};
// career-ops scanners → data/pipeline.md Pending (reset before each run)
const pipe = existsSync(path.join(CO, 'data/pipeline.md')) ? readFileSync(path.join(CO, 'data/pipeline.md'), 'utf-8') : '';
let inPend = false; let nPipe = 0;
for (const line of pipe.split('\n')) {
  if (line.startsWith('## ')) inPend = /pending|pendientes/i.test(line);
  if (!inPend || !line.startsWith('- [ ]')) continue;
  const cells = line.slice(6).split(' | ').map((s) => s.trim());
  const posted = (cells.find((c) => c.startsWith('posted:')) || '').replace('posted:', '').trim();
  const plain = cells.filter((c) => !/^(posted|trust|note|rank):/.test(c));
  cands.push({ source: 'ats', url: plain[0], company: plain[1] || '', title: plain[2] || '', location: plain[3] || '', comp: plain[4] || '', posted });
  nPipe++;
}
sources.ats = { candidates: nPipe };
for (const f of ['linkedin', 'boards', 'startups']) {
  const d = readJson(path.join(ROOT, `tmp/${f}.json`), null);
  if (!d) { sources[f] = { error: 'no output' }; continue; }
  sources[f] = d.stats;
  cands.push(...d.jobs);
}
// LinkedIn feed posts found through Google via Apify (radar/collect-google.mjs). Optional (APIFY_TOKEN).
const google = readJson(path.join(ROOT, 'tmp/google.json'), null);
if (google) { sources.google = google.stats; cands.push(...(google.jobs || [])); }
const feedPostsRaw = google?.feed_posts || [];

// ── Pass 1: undated → age → title → aggregator → dedup within run → already_seen ──
const statePath = path.join(ROOT, 'state/seen.json');
const seen = process.env.RADAR_IGNORE_SEEN === '1' ? {} : readJson(statePath, {});
const normUrl = (u) => (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/$/, '');
const normRole = (j) => (j.company ? `${j.company.toLowerCase().replace(/[^a-z0-9]/g, '')}|${(j.title || '').toLowerCase().replace(/[^a-z0-9]/g, '')}` : null);
const counts = { candidates: cands.length, undated: 0, too_old: 0, title: 0, dup_in_run: 0, already_seen: 0, detail_fetched: 0, detail_skipped: 0, detail_failed: 0, not_eligible: {}, new: 0 };
const dropped = {};
const noteDrop = (reason, j, extra = {}) => {
  counts.not_eligible[reason] = (counts.not_eligible[reason] || 0) + 1;
  (dropped[reason] ||= []);
  if (dropped[reason].length < 25) dropped[reason].push({ title: j.title, company: j.company, location: j.location, url: j.url, ...extra });
};
const survivors = []; const runKeys = new Set();
for (const j of cands) {
  j.title = j.title || ''; j.company = j.company || ''; j.location = j.location || '';
  if (j.posted && !Number.isNaN(Date.parse(j.posted))) {
    j.age_days = ageDays(j.posted);
    if (j.age_days > DAYS) { counts.too_old++; continue; }
  } else { j.posted = ''; j.age_days = null; } // undated: a detail page may still date it; dropped later if not
  if (!titleOk(j.title, j.source)) { counts.title++; continue; }
  if (isAggregator(j)) { noteDrop('aggregator', j); continue; }
  const ku = normUrl(j.url); const kr = normRole(j);
  if (runKeys.has(ku) || (kr && runKeys.has(kr))) { counts.dup_in_run++; continue; }
  runKeys.add(ku); if (kr) runKeys.add(kr);
  if (seen[ku] || (kr && seen[kr])) { counts.already_seen++; continue; }
  survivors.push(j);
}

// ── Detail fetch (one request at a time; ≥1.2 s between LinkedIn requests; 429/999/5xx retried after 5 s, 15 s) ──
const fetchStats = { requests: 0, retries: 0, by_host: {}, circuit_open: [] };
const lastReq = new Map(); const consecutiveFail = new Map(); const CIRCUIT = 6;
const bucketOf = (url) => { try { const h = new URL(url).host; return /linkedin\.com$/.test(h) ? 'linkedin' : h; } catch { return 'invalid'; } };
async function httpGet(url, opts = {}) {
  const host = bucketOf(url);
  if (host === 'invalid') return { ok: false, status: 0, error: 'invalid url' };
  if ((consecutiveFail.get(host) || 0) >= CIRCUIT) return { ok: false, status: 0, error: `skipped: ${host} unreachable (circuit open)` };
  const gap = host === 'linkedin' ? 1200 : 300; const backoff = [5000, 15000];
  let last = 'unknown error';
  for (let attempt = 0; attempt <= 2; attempt++) {
    const wait = (lastReq.get(host) || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq.set(host, Date.now());
    fetchStats.requests++; if (attempt) fetchStats.retries++;
    fetchStats.by_host[host] = (fetchStats.by_host[host] || 0) + 1;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: opts.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9,es;q=0.8' },
        redirect: 'follow', signal: AbortSignal.timeout(opts.timeout || 20000),
      });
      if (res.status === 429 || res.status === 999 || res.status >= 500) {
        last = `HTTP ${res.status}`;
        if (attempt < 2) { await sleep(backoff[attempt]); continue; }
        break;
      }
      const text = await res.text();
      consecutiveFail.set(host, 0);
      return { ok: res.ok, status: res.status, text, url: res.url, error: res.ok ? null : `HTTP ${res.status}` };
    } catch (e) {
      last = e?.name === 'TimeoutError' ? 'timeout' : (e?.cause?.code || e?.message || String(e));
      if (attempt < 2) { await sleep(backoff[attempt]); continue; }
    }
  }
  const n = (consecutiveFail.get(host) || 0) + 1; consecutiveFail.set(host, n);
  if (n === CIRCUIT) { fetchStats.circuit_open.push(host); log(`detail: ${CIRCUIT} consecutive failures for ${host} — skipping the rest of that host`); }
  return { ok: false, status: 0, error: last };
}

// Inner HTML of the first element whose class or id contains `name` (balanced on the element's own tag).
function extractContainer(html, name) {
  const re = new RegExp(`<(div|section|article|span)\\b[^>]*\\b(?:class|id)="(?:[^"]*\\s)?${esc(name)}(?:\\s[^"]*)?"[^>]*>`, 'i');
  const m = re.exec(html); if (!m) return null;
  const tag = m[1].toLowerCase();
  const start = m.index + m[0].length; let depth = 1;
  const tok = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi'); tok.lastIndex = start;
  let t;
  while ((t = tok.exec(html))) { depth += t[1] ? -1 : 1; if (depth === 0) return html.slice(start, t.index); }
  return html.slice(start);
}
const nowISO = now.toISOString();
const mapEmployment = (s) => String(s || '').replace(/PART_?TIME/i, 'Part-time').replace(/FULL_?TIME/i, 'Full-time').replace(/\bINTERN\b/i, 'Internship').replace(/CONTRACTOR/i, 'Contract');
// Structured salary (Lever salaryRange, JSON-LD baseSalary) → one line the salary regex in classify.mjs reads back verbatim.
const fmtN = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : String(n));
const perUnit = (u) => { const s = String(u || '').toLowerCase(); return /year|annum|annual/.test(s) ? 'per year' : /month|mensual/.test(s) ? 'per month' : /hour|hora/.test(s) ? 'per hour' : /week/.test(s) ? 'per week' : /day/.test(s) ? 'per day' : ''; };
const salaryLine = (cur, min, max, unit) => `Salary: ${cur || ''} ${fmtN(min)}${max && Number(max) !== Number(min) ? ` - ${fmtN(max)}` : ''} ${perUnit(unit)}`.replace(/\s+/g, ' ').trim();

async function fetchLinkedIn(id) {
  const r = await httpGet(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
  if (!r.ok) return { error: r.error };
  const html = r.text;
  const body = extractContainer(html, 'show-more-less-html__markup') || extractContainer(html, 'description__text');
  if (!body || cleanText(body).length < 40) return { error: 'no description markup' };
  const criteria = [...html.matchAll(/description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g)].map((x) => `${cleanText(x[1])}: ${cleanText(x[2])}`);
  const postedTxt = cleanText(html.match(/posted-time-ago__text[^>]*>([\s\S]*?)<\//)?.[1] || '');
  const location = cleanText(html.match(/topcard__flavor--bullet[^>]*>([\s\S]*?)<\//)?.[1] || '');
  const company = cleanText(html.match(/topcard__org-name-link[^>]*>([\s\S]*?)<\//)?.[1] || html.match(/class="topcard__flavor"[^>]*>([\s\S]*?)<\//)?.[1] || '');
  return { meta: criteria.join('\n'), text: cleanText(body), posted: parseRelativeDate(postedTxt, nowISO), location, company };
}
async function fetchGreenhouse(token, id) {
  const r = await httpGet(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}`, { accept: 'application/json' });
  if (!r.ok) return { error: r.error };
  const d = JSON.parse(r.text); const lines = [];
  if (d.location?.name) lines.push(`Location: ${d.location.name}`);
  for (const md of d.metadata || []) if (md?.name && md?.value && /salary|compensation|pay|remote|workplace|location|employment/i.test(md.name)) lines.push(`${md.name}: ${typeof md.value === 'object' ? JSON.stringify(md.value) : md.value}`);
  return { meta: lines.join('\n'), text: cleanText(d.content || ''), posted: (d.first_published || d.updated_at || '').slice(0, 10) || null, location: d.location?.name || '', company: d.company_name || '' };
}
async function fetchLever(eu, token, uuid) {
  const r = await httpGet(`https://api${eu}.lever.co/v0/postings/${token}/${uuid}`, { accept: 'application/json' });
  if (!r.ok) return { error: r.error };
  const d = JSON.parse(r.text); const lines = [];
  const loc = d.categories?.location || (d.categories?.allLocations || []).join('; ') || '';
  if (loc) lines.push(`Location: ${loc}`);
  if (d.workplaceType && d.workplaceType !== 'unspecified') lines.push(`Workplace: ${d.workplaceType}`);
  if (d.categories?.commitment) lines.push(`Commitment: ${mapEmployment(d.categories.commitment)}`);
  if (d.salaryRange?.min) lines.push(salaryLine(d.salaryRange.currency || 'USD', d.salaryRange.min, d.salaryRange.max, d.salaryRange.interval));
  const body = [d.descriptionPlain || cleanText(d.description || ''), ...(d.lists || []).flatMap((l) => [l.text || '', cleanText(l.content || '')]), d.additionalPlain || cleanText(d.additional || '')];
  return { meta: lines.join('\n'), text: body.filter(Boolean).join('\n'), posted: d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : null, location: loc };
}
const ashbyBoards = new Map();
async function fetchAshby(slug, uuid) {
  let board = ashbyBoards.get(slug);
  if (!board) {
    const r = await httpGet(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`, { accept: 'application/json' });
    if (!r.ok) return { error: r.error };
    board = JSON.parse(r.text); ashbyBoards.set(slug, board);
  }
  const p = (board.jobs || []).find((x) => x.id === uuid || (x.jobUrl || '').includes(uuid) || (x.applyUrl || '').includes(uuid));
  if (!p) return { error: 'posting not on board (closed?)' };
  const lines = [];
  const loc = [p.location, ...(p.secondaryLocations || []).map((s) => s?.location)].filter(Boolean).join('; ');
  if (loc) lines.push(`Location: ${loc}`);
  if (p.isRemote === true) lines.push('Workplace: Remote'); else if (p.workplaceType) lines.push(`Workplace: ${p.workplaceType}`);
  if (p.employmentType) lines.push(`Employment type: ${mapEmployment(p.employmentType)}`);
  const comp = p.compensation?.compensationTierSummary || p.compensation?.scrapeableCompensationSalarySummary;
  if (comp) lines.push(`Compensation: ${comp}`);
  return { meta: lines.join('\n'), text: p.descriptionPlain || cleanText(p.descriptionHtml || ''), posted: p.publishedAt ? String(p.publishedAt).slice(0, 10) : null, location: loc };
}
async function fetchWorkday(tenant, wd, site, rest, url) {
  const r = await httpGet(`https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${rest}`, { accept: 'application/json' });
  if (!r.ok || !/^\s*\{/.test(r.text)) return fetchGeneric(url);
  const p = JSON.parse(r.text).jobPostingInfo || {}; const lines = [];
  const loc = [p.location, ...(p.additionalLocations || [])].filter(Boolean).join('; ');
  if (loc) lines.push(`Location: ${loc}`);
  if (p.remoteType) lines.push(`Workplace: ${p.remoteType}`);
  if (p.timeType) lines.push(`Time type: ${p.timeType}`);
  return { meta: lines.join('\n'), text: cleanText(p.jobDescription || ''), posted: p.startDate || parseRelativeDate(p.postedOn || '', nowISO), location: p.location || '' };
}
const CONTAINERS = ['show-more-less-html__markup', 'job-body', 'job-description', 'jobDescription', 'job_description', 'posting-description', 'job-details', 'jobdesc', 'vacancy-description', 'description__text', 'job-content'];
async function fetchGeneric(url) {
  const r = await httpGet(url);
  if (!r.ok) return { error: r.error };
  const html = r.text; const lines = []; let ldText = ''; let posted = null; let location = ''; let company = '';
  for (const block of html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []) {
    try {
      const parsed = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/gi, '').trim());
      for (const node of [].concat(parsed?.['@graph'] || parsed)) {
        if (!node || !/JobPosting/.test(String(node['@type']))) continue;
        if (node.hiringOrganization?.name) company = cleanText(String(node.hiringOrganization.name));
        if (node.jobLocationType) lines.push(`Workplace: ${/TELECOMMUTE/i.test(node.jobLocationType) ? 'Remote' : node.jobLocationType}`);
        const alr = [].concat(node.applicantLocationRequirements || []).map((x) => x?.name).filter(Boolean);
        if (alr.length) lines.push(`Applicant location requirements: ${alr.join(', ')}`);
        const locs = [].concat(node.jobLocation || []).map((l) => [l?.address?.addressLocality, l?.address?.addressRegion, l?.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean);
        if (locs.length) { location = locs.join('; '); lines.push(`Location: ${location}`); }
        if (node.employmentType) lines.push(`Employment type: ${[].concat(node.employmentType).map(mapEmployment).join(', ')}`);
        const v = node.baseSalary?.value;
        if (v && (v.minValue || v.value)) lines.push(salaryLine(node.baseSalary.currency, v.minValue || v.value, v.maxValue, v.unitText));
        if (node.datePosted) posted = String(node.datePosted).slice(0, 10);
        if (node.description) ldText = cleanText(node.description);
      }
    } catch { /* not a JobPosting block */ }
  }
  let body = ldText;
  if (body.length < 200) {
    let container = null;
    for (const c of CONTAINERS) if ((container = extractContainer(html, c))) break;
    const scope = container || html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] || html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] || html.match(/<body\b[\s\S]*<\/body>/i)?.[0] || html;
    const stripped = cleanText(scope.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' '));
    if (stripped.length > body.length) body = stripped;
  }
  if (!body) return { error: 'empty body' };
  return { meta: lines.join('\n'), text: body, posted, location, company };
}
async function fetchDetail(j) {
  const url = j.url || ''; let m;
  try {
    if ((m = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/)) || (m = url.match(/currentJobId=(\d+)/))) return await fetchLinkedIn(m[1]);
    if ((m = url.match(/^https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/))) return await fetchGreenhouse(m[1], m[2]);
    if ((m = url.match(/^https?:\/\/jobs(\.eu)?\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/))) return await fetchLever(m[1] || '', m[2], m[3]);
    if ((m = url.match(/^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/))) return await fetchAshby(m[1], m[2]);
    if ((m = url.match(/^https?:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/job\/([^?#]+)/))) return await fetchWorkday(m[1], m[2], m[3], m[4], url);
    if (!/^https?:\/\//.test(url)) return { error: 'invalid url' };
    return await fetchGeneric(url);
  } catch (e) { return { error: e?.message || String(e) }; }
}

// Fetch order: postings whose eligibility depends on the body first (Colombia / Spain non-metro, LATAM, US country-level),
// then Medellín / Bogotá / Madrid metro (kept anyway; body only enriches), then US cities, then everything else.
const priority = (j) => {
  if (WORLDWIDE.has(j.source)) return 4; // phrase-search padding: fetch last, never starve the real lanes
  const g = geo(j.location);
  if (g.country === 'CO') return g.metro || g.countryLevel ? 1 : 0;
  if (g.country === 'ES') return g.metro ? 1 : 0;
  if (g.country === 'LATAM') return 0;
  if (g.country === 'US') return g.countryLevel ? 0 : 2;
  return 3;
};
survivors.sort((a, b) => priority(a) - priority(b) || (a.age_days ?? 99) - (b.age_days ?? 99));
let fetched = 0;
for (const j of survivors) {
  j.detail_fetched = false; j.detail_error = null; j._text = ''; j._desc = '';
  if (SKIP_DETAIL) { j.detail_error = 'skipped: RADAR_SKIP_DETAIL'; continue; }
  if (fetched >= MAX_DETAIL) { j.detail_error = 'skipped: RADAR_MAX_DETAIL'; counts.detail_skipped++; continue; }
  fetched++;
  const d = await fetchDetail(j);
  if (d.error) {
    counts.detail_failed++; j.detail_error = d.error;
    log(`detail ${fetched}/${Math.min(survivors.length, MAX_DETAIL)} FAIL ${d.error} — ${j.url}`);
    continue;
  }
  counts.detail_fetched++; j.detail_fetched = true;
  j._desc = d.text || '';                                           // description only → body_excerpt
  j._text = [d.meta, d.text].filter(Boolean).join('\n');           // + structured hints (location, workplace, salary…) → classifier
  if (!j.posted && d.posted && !Number.isNaN(Date.parse(d.posted))) { j.posted = d.posted; j.age_days = ageDays(d.posted); }
  if (!j.company && d.company) j.company = d.company;
  if (!j.location && d.location) j.location = d.location;
  log(`detail ${fetched}/${Math.min(survivors.length, MAX_DETAIL)} ok ${String(j._text.length).padStart(5)} chars — ${j.title} @ ${j.location}`);
}

// ── Classify → lane / drop ──
const LANE_ORDER = ['colombia-medellin', 'colombia-bogota', 'colombia-remote', 'latam-remote', 'spain-madrid', 'spain-remote', 'remote-intl', 'us-remote-unstated', 'remote-other-intl'];
const fresh = [];
const markSeen = (j) => { seen[normUrl(j.url)] = today; const kr = normRole(j); if (kr) seen[kr] = today; };
for (const j of survivors) {
  if (j.age_days === null) { counts.undated++; continue; }       // still undated after the detail stage
  if (j.age_days > DAYS) { counts.too_old++; continue; }          // dated by the detail page, but outside the window
  const fields = extractFields({ title: j.title, location: j.location, text: j._text });
  if (!fields.salary && j.comp) fields.salary = j.comp;
  let verdict;
  if (j.detail_fetched || SKIP_DETAIL || locationQualifiesAlone(j.location)) verdict = assignLane({ location: j.location, title: j.title, ...fields });
  else {
    // No body available (LinkedIn 429/999, cap reached). A transient block must not erase a whole lane, so a
    // country-level tag keeps its conventional meaning and is flagged `no-detail` for the routine to re-check:
    // "United States" → us-remote-unstated, "Mexico"/"Latin America" → latam-remote (remote=null). Anything
    // city-level or elsewhere needs the body to qualify and is dropped with the fetch error as the reason.
    const g = geo(j.location);
    if (g.country === 'US' && g.countryLevel && !(fields.us_only_signals.length && !fields.intl_ok)) verdict = { lane: fields.intl_ok ? 'remote-intl' : 'us-remote-unstated', drop_reason: null };
    else if (g.country === 'LATAM' && g.countryLevel) verdict = { lane: 'latam-remote', drop_reason: null };
    else verdict = { lane: null, drop_reason: j.detail_error?.startsWith('skipped') ? 'detail-skipped' : 'detail-failed' };
  }
  if (verdict.lane && WORLDWIDE.has(j.source) && !fields.intl_ok && (PHRASE_LANES.has(verdict.lane) || !passes(tff, j.title))) verdict = { lane: null, drop_reason: 'phrase-not-in-body' };
  if (!verdict.lane) {
    const why = verdict.drop_reason === 'us-only' ? `us-only: ${fields.us_only_signals.join(' | ')}`.slice(0, 160)
      : /^detail-/.test(verdict.drop_reason) ? j.detail_error
        : `remote=${fields.remote}${fields.evidence.remote ? `: ${fields.evidence.remote}` : ' (no evidence)'}`;
    noteDrop(verdict.drop_reason, j, { remote: fields.remote, intl_ok: fields.intl_ok, why });
    if (j.detail_fetched) markSeen(j); // decided on the real body: no need to fetch it again tomorrow
    continue;
  }
  fresh.push({
    source: j.source, url: j.url, title: j.title, company: j.company, location: j.location, posted: j.posted, age_days: j.age_days,
    lane: verdict.lane, remote: fields.remote, intl_ok: fields.intl_ok, us_only_signals: fields.us_only_signals, salary: fields.salary,
    years_required: fields.years_required, contract_flags: fields.contract_flags, body_excerpt: excerpt(j._desc, 700),
    detail_fetched: j.detail_fetched, detail_error: j.detail_error, evidence: fields.evidence,
  });
}
for (const j of fresh) markSeen(j);
for (const [k, d] of Object.entries(seen)) if (ageDays(d) > 90) delete seen[k];
counts.new = fresh.length;
// LinkedIn feed posts found by Google (collect-google.mjs): within the window and not seen before. The routine
// judges them with its FEED-POST HANDLING rules; the radar only dates, dedups and carries the text.
const feedPosts = []; const feedCounts = { undated: 0, too_old: 0, already_seen: 0 };
for (const fp of feedPostsRaw) {
  if (!fp?.url) continue;
  if (!fp.posted || Number.isNaN(Date.parse(fp.posted))) { feedCounts.undated++; continue; }
  const age = ageDays(fp.posted); if (age > DAYS) { feedCounts.too_old++; continue; }
  const k = normUrl(fp.url); if (seen[k]) { feedCounts.already_seen++; continue; }
  feedPosts.push({ ...fp, age_days: age }); seen[k] = today;
}
counts.feed_posts = feedPosts.length;
if (feedPostsRaw.length) counts.feed_dropped = feedCounts;
fresh.sort((a, b) => LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane) || a.age_days - b.age_days || a.company.localeCompare(b.company));
sources.detail = { fetched: counts.detail_fetched, failed: counts.detail_failed, skipped: counts.detail_skipped, max: MAX_DETAIL, ...fetchStats, mode: SKIP_DETAIL ? 'skipped (RADAR_SKIP_DETAIL)' : 'live' };

// ── Write ──
mkdirSync(path.join(OUT, 'history'), { recursive: true });
const report = { generated_at: now.toISOString(), window_days: DAYS, dry_run: DRY || undefined, counts, sources, dropped_samples: dropped, new: fresh, feed_posts: feedPosts };
writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(report, null, 1));
writeFileSync(path.join(OUT, `history/${today}.json`), JSON.stringify(report, null, 1));
if (!DRY) { mkdirSync(path.join(ROOT, 'state'), { recursive: true }); writeFileSync(statePath, JSON.stringify(seen)); }

const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
// latest.md keeps the counts/sources block readable: long arrays (e.g. the LinkedIn per-query log) become "<n items>".
const compact = (v) => (Array.isArray(v) ? (v.length > 5 ? `<${v.length} items>` : v.map(compact)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x)])) : v);
const flags = (j) => [j.us_only_signals.length ? `us-only:${j.us_only_signals.length}` : '', j.intl_ok ? 'intl' : '', ...j.contract_flags, j.detail_fetched ? '' : 'no-detail'].filter(Boolean).join(' · ') || '—';
const remoteTxt = (r) => (r === true ? 'yes' : r === false ? 'no' : '?');
const md = [`# Job radar — ${today}${DRY ? ' (dry run)' : ''}`, '', `New live roles (≤${DAYS} days): **${fresh.length}**`, '',
  '| Age | Lane | Remote | Company | Title | Location | Salary | Flags | Source |', '|---|---|---|---|---|---|---|---|---|',
  ...fresh.map((j) => `| ${j.age_days}d | ${j.lane} | ${remoteTxt(j.remote)} | ${cell(j.company)} | [${cell(j.title)}](${j.url}) | ${cell(j.location)} | ${cell(j.salary || '')} | ${cell(flags(j))} | ${j.source} |`),
  '', '```', JSON.stringify(compact({ counts, sources }), null, 1), '```', ''];
if (feedPosts.length) {
  md.push('## Feed posts (LinkedIn posts found via Google, ≤ window)', '');
  for (const fp of feedPosts) md.push(`- ${fp.age_days}d · ${cell(fp.author || '?')} — [${cell((fp.text || '').slice(0, 110))}…](${fp.url})`);
  md.push('');
}
const droppedReasons = Object.keys(dropped).sort((a, b) => counts.not_eligible[b] - counts.not_eligible[a]);
if (droppedReasons.length) {
  md.push('## Dropped (samples)', '');
  for (const reason of droppedReasons) {
    md.push(`- **${reason}** (${counts.not_eligible[reason]})`);
    for (const s of dropped[reason].slice(0, 5)) md.push(`  - [${cell(s.title)}](${s.url}) — ${cell(s.company) || '—'} — ${cell(s.location) || '—'}${s.why ? ` → ${cell(s.why).slice(0, 110)}` : ''}`);
  }
  md.push('');
}
writeFileSync(path.join(OUT, 'latest.md'), md.join('\n'));
console.log(`radar${DRY ? ' (dry run → out/dry-run)' : ''}: ${fresh.length} new live roles; ${JSON.stringify(counts)}`);
