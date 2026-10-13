// Google Programmable Search (Custom Search JSON API — free tier: 100 queries/day) as the date-filtered
// web search the owner's playbook runs by hand. Four groups, ~18 queries a day:
//   feed           LinkedIn FEED POSTS announcing Colombian planning vacancies (linkedin.com/posts, last RADAR_DAYS days)
//   jobs-worldwide LinkedIn job pages that say they hire from anywhere
//   workday-co     Workday career sites with planning roles in Colombia
//   boards-co      computrabajo / elempleo manager-level planning titles
// Feed posts are fetched logged-out (LinkedIn renders post pages publicly), dated from the 19-digit activity id
// ((id >> 22) = ms since the Unix epoch) and emitted as `feed_posts`; job links are emitted as `jobs` for build.mjs
// to date, fetch and classify like any other candidate.
//
// No-op without GOOGLE_CSE_KEY and GOOGLE_CSE_CX (see README → "Optional: Google search"). Never throws.
// Output (stdout): {stats, jobs:[{source:'google:<group>', url, title, company, location, posted}], feed_posts:[{url, author, posted, text, query}]}

const KEY = process.env.GOOGLE_CSE_KEY;
const CX = process.env.GOOGLE_CSE_CX;
const DAYS = Number(process.env.RADAR_DAYS || 3);
const MAX_POST_FETCH = Number(process.env.RADAR_GOOGLE_MAX_POSTS || 40);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const out = { stats: { queries: 0, results: 0, errors: [], by_group: {} }, jobs: [], feed_posts: [] };
const emit = () => process.stdout.write(JSON.stringify(out));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

if (!KEY || !CX) {
  out.stats.skipped = 'GOOGLE_CSE_KEY / GOOGLE_CSE_CX not set — Google search skipped (free setup in README)';
  process.stderr.write(`google: ${out.stats.skipped}\n`);
  emit(); process.exit(0);
}

const GROUPS = [
  { group: 'feed', site: 'linkedin.com/posts', date: `d${DAYS}`, queries: [
    'vacante "Director de Planeación" Medellín', 'vacante "Gerente de Planeación" Medellín', 'vacante "Jefe de Planeación" Medellín',
    'vacante "planeación de la demanda" Colombia', 'vacante "S&OP" Colombia gerente OR director OR jefe',
    'vacante "Director de Cadena de Abastecimiento" Medellín', 'vacante "Director de Planeación" Bogotá',
    'vacante "Gerente de Planeación de la Demanda" Bogotá', '#EmpleoMedellin planeación gerente OR jefe OR director',
    'vacante supply chain Medellín gerente OR director OR jefe',
  ] },
  { group: 'jobs-worldwide', site: 'linkedin.com/jobs/view', date: `d${DAYS}`, queries: [
    '"open to applicants worldwide" "supply chain"', '"open to applicants worldwide" planning',
    '"work from anywhere" "supply chain" planning', '"Latin America" remote ("supply planning" OR "demand planning") manager',
  ] },
  { group: 'workday-co', site: 'myworkdayjobs.com', date: 'd7', queries: [
    '("demand planning" OR "supply planning" OR "S&OP" OR "materials planning") (Bogotá OR Medellín OR Colombia)',
  ] },
  { group: 'boards-co', site: null, date: `d${DAYS}`, queries: [
    'site:co.computrabajo.com (jefe OR gerente OR director) planeación demanda OR abastecimiento',
    'site:elempleo.com (jefe OR gerente OR director) "planeación" demanda OR abastecimiento OR "S&OP"',
  ] },
];

async function cse(q, site, date) {
  const u = new URL('https://www.googleapis.com/customsearch/v1');
  u.searchParams.set('key', KEY); u.searchParams.set('cx', CX); u.searchParams.set('q', q); u.searchParams.set('num', '10');
  if (site) { u.searchParams.set('siteSearch', site); u.searchParams.set('siteSearchFilter', 'i'); }
  if (date) u.searchParams.set('dateRestrict', date);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 && attempt === 0) { await sleep(5000); continue; }
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return await r.json();
    } catch (e) { if (attempt) return { error: e?.message || String(e) }; await sleep(3000); }
  }
  return { error: 'unknown' };
}

// LinkedIn post URL → publication date from the activity / ugcPost id (verified exact to the second, 2026-09-12).
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

// "Company hiring Title in City | LinkedIn" → fields; other boards: "Title - Company - City"
function parseTitle(group, title, link) {
  const t = dec(title).replace(/\s*[|\-–]\s*LinkedIn$/i, '');
  if (group === 'jobs-worldwide') { const m = t.match(/^(.*?) hiring (.*?)(?: in (.*))?$/); if (m) return { company: m[1], title: m[2], location: m[3] || '' }; return { company: '', title: t, location: '' }; }
  if (group === 'workday-co') { const m = link.match(/^https?:\/\/([^.]+)\./); return { company: m ? m[1] : '', title: t.split(/\s[|–-]\s/)[0], location: '' }; }
  const parts = t.split(/\s[|–-]\s/); return { title: parts[0] || t, company: parts[1] || '', location: parts[2] || '' };
}

const seenUrl = new Set(); const posts = [];
for (const g of GROUPS) {
  out.stats.by_group[g.group] = { queries: 0, results: 0 };
  for (const q of g.queries) {
    out.stats.queries++; out.stats.by_group[g.group].queries++;
    const res = await cse(q, g.site, g.date);
    if (res.error) { out.stats.errors.push({ group: g.group, q, error: res.error }); if (/HTTP 403|HTTP 429/.test(res.error)) break; continue; }
    for (const it of res.items || []) {
      const link = it.link || ''; if (!link || seenUrl.has(link)) continue; seenUrl.add(link);
      out.stats.results++; out.stats.by_group[g.group].results++;
      if (g.group === 'feed') { if (/linkedin\.com\/posts\//.test(link)) posts.push({ url: link, query: q, snippet: dec(it.snippet || '') }); continue; }
      const f = parseTitle(g.group, it.title || '', link);
      out.jobs.push({ source: `google:${g.group}`, url: link, title: f.title, company: f.company, location: f.location, posted: '' });
    }
    await sleep(400);
  }
}

// Feed posts: date from the id first (free), fetch only those inside the window.
let fetched = 0;
for (const p of posts) {
  const d = postDate(p.url);
  if (d && Math.floor((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(d)) / 86400000) > DAYS) continue;
  if (fetched >= MAX_POST_FETCH) { out.stats.posts_skipped = (out.stats.posts_skipped || 0) + 1; continue; }
  fetched++;
  const r = await fetchPost(p.url);
  out.feed_posts.push({ url: p.url, query: p.query, posted: d || r.published || null, author: r.author || '', text: r.text || p.snippet, fetch_error: r.error || null });
  await sleep(1500);
}
out.stats.feed_candidates = posts.length; out.stats.feed_fetched = fetched;
process.stderr.write(`google: ${out.stats.queries} queries, ${out.stats.results} results, ${out.jobs.length} job links, ${out.feed_posts.length} feed posts (${out.stats.errors.length} errors)\n`);
emit();
