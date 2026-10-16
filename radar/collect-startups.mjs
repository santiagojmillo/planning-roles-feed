// Startup job sources (free, no key):
//   1. YC "Work at a Startup": every company the YC API marks as hiring (api.ycombinator.com/v0.1/companies?isHiring=true,
//      ~50 pages of 25), then each company's public jobs page (ycombinator.com/companies/<slug>/jobs), whose
//      data-page JSON lists every posting with title, location, salary, minimum experience, visa rule and a relative
//      "createdAt" ("3 days", "about 1 month"). YC's /jobs/role/... pages show only ~39 postings each, so they are not used.
//   2. Hacker News "Ask HN: Who is hiring?" (monthly thread by the whoishiring account), top-level comments posted in
//      the window, read through the Algolia HN API. Most comments arrive in the first days of the month.
// Owner rules applied here, because these fields never reach the posting body the routine reads:
//   - YC visa "US citizen/visa only" on a US or unstated location → dropped (US work authorization; owner rule 2026-07-31).
//   - YC minimum experience under 5 years ("Any (new grads ok)", "1+ years", "3+ years") → dropped (filter 2).
// Everything else (title, recency, location, salary) is judged downstream exactly like other radar items.
// Output (stdout): {stats, jobs:[{source:'yc'|'hn', url, title, company, location, posted}]}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DAYS = Number(process.env.RADAR_DAYS || 3);
const YC_MAX_PAGES = Number(process.env.RADAR_YC_MAX_PAGES || 80);   // runaway guard; the walk ends at the API's totalPages
const YC_CONCURRENCY = 4;
const SLUG = /^[A-Za-z0-9._-]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const log = (s) => process.stderr.write(`startups: ${s}\n`);

async function get(url, as = 'text') {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(25000) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, body: as === 'json' ? await r.json() : await r.text() };
    } catch (e) {
      if (i >= 2) return { ok: false, status: 0, error: e?.name === 'TimeoutError' ? 'timeout' : String(e?.message || e) };
      await sleep(3000 * (i + 1));
    }
  }
}
const ENT = { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/' };
const decode = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e in ENT) return ENT[e];
  if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; }
  return m;
});
const dataPage = (html) => { const m = html.match(/data-page="([^"]+)"/); if (!m) return null; try { return JSON.parse(decode(m[1])); } catch { return null; } };

// "about 22 hours" → 0, "1 day" / "a day" → 1, "3 days" → 3, "about 1 month" → 30. Unknown → null (dropped as undated).
function relAgeDays(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return null;
  if (/second|minute|hour|just now/.test(t)) return 0;
  let m = t.match(/(\d+)\s*day/); if (m) return Number(m[1]);
  if (/\b(a|an|one)\s+day/.test(t)) return 1;
  m = t.match(/(\d+)\s*week/); if (m) return 7 * Number(m[1]);
  if (/\b(a|an|one)\s+week/.test(t)) return 7;
  if (/month/.test(t)) { m = t.match(/(\d+)/); return 30 * (m ? Number(m[1]) : 1); }
  if (/year/.test(t)) return 365;
  return null;
}
const JUNIOR_EXP = /^(any|1\+|2\+|3\+|4\+)/i;   // YC minExperience values below 5 years
// YC shows "US citizen/visa only" on some non-US postings too (London, Paris), so the visa rule only applies to US or
// unstated locations; a posting that names another country goes through the normal location rules downstream.
const NON_US = /(,\s*(GB|UK|FR|DE|ES|NL|CO|MX|BR|AR|CL|PE|IN|CA|IE|PT|IT|PL|SE|DK|CH|AT|BE)\b|colombia|latam|latin america|europe|spain|mexico|brazil|argentina|chile|peru|canada|india|united kingdom|england)/i;

const stats = { yc: { hiring_companies: 0, pages: 0, company_pages: 0, page_errors: 0, postings: 0, old: 0, undated: 0, us_only_visa: 0, junior_experience: 0, kept: 0, dropped_samples: { us_only_visa: [], junior_experience: [] } }, hn: {} };
const sample = (k, p, company) => { const a = stats.yc.dropped_samples[k]; if (a.length < 12) a.push(`${p.title} — ${company} — ${p.location || '?'}`); };
const jobs = [];

// ── 1. YC Work at a Startup ──
try {
  const companies = [];
  let total = 1;
  for (let page = 1; page <= Math.min(total, YC_MAX_PAGES); page++) {
    const r = await get(`https://api.ycombinator.com/v0.1/companies?isHiring=true&page=${page}`, 'json');
    if (!r.ok) { stats.yc.error = `companies page ${page}: ${r.status || r.error}`; break; }
    total = Number(r.body.totalPages) || page;
    companies.push(...(r.body.companies || []));
    stats.yc.pages++;
    await sleep(300);
  }
  if (total > YC_MAX_PAGES) stats.yc.truncated = `stopped at ${YC_MAX_PAGES} of ${total} company pages`;
  const slugs = [...new Set(companies.map((c) => c.slug).filter((s) => s && SLUG.test(s)))];
  stats.yc.hiring_companies = slugs.length;
  let next = 0;
  async function worker() {
    while (next < slugs.length) {
      const slug = slugs[next++];
      const r = await get(`https://www.ycombinator.com/companies/${slug}/jobs`);
      await sleep(250);
      if (!r.ok) { stats.yc.page_errors++; continue; }
      const d = dataPage(r.body);
      const props = d?.props || {};
      stats.yc.company_pages++;
      const company = props.company?.name || slug;
      for (const p of props.jobPostings || []) {
        stats.yc.postings++;
        const age = relAgeDays(p.createdAt);
        if (age === null) { stats.yc.undated++; continue; }
        if (age > DAYS) { stats.yc.old++; continue; }
        if (/us citizen/i.test(p.visa || '') && !NON_US.test(p.location || '')) { stats.yc.us_only_visa++; sample('us_only_visa', p, company); continue; }
        if (JUNIOR_EXP.test(String(p.minExperience || ''))) { stats.yc.junior_experience++; sample('junior_experience', p, company); continue; }
        jobs.push({ source: 'yc', url: `https://www.ycombinator.com${p.url}`, title: decode(p.title || '').trim(), company, location: p.location || '', posted: isoDaysAgo(age) });
        stats.yc.kept++;
      }
    }
  }
  await Promise.all(Array.from({ length: YC_CONCURRENCY }, worker));
} catch (e) { stats.yc.error = String(e?.message || e); }

// ── 2. Hacker News "Who is hiring?" ──
const TOPIC = /(supply chain|plann|s&op|s&oe|\bibp\b|inventor|demand|forecast|replenish|procure|sourcing|logistic|operations|fulfil)/i;
const ROLE = /(supply|plann|s&op|inventor|demand|forecast|replenish|procure|sourcing|logistic|operations|fulfil)/i;
try {
  const s = await get('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10', 'json');
  const story = s.ok ? (s.body.hits || []).find((h) => /who is hiring/i.test(h.title || '')) : null;
  if (!story) { stats.hn.error = s.ok ? 'no "Who is hiring?" thread found' : `search failed: ${s.status || s.error}`; }
  else {
    const sid = Number(story.objectID);
    const since = Math.floor(Date.now() / 1000) - (DAYS + 1) * 86400;
    let hits = [];
    for (let page = 0; page < 10; page++) {
      const r = await get(`https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${sid}&numericFilters=created_at_i>${since}&hitsPerPage=1000&page=${page}`, 'json');
      if (!r.ok) { stats.hn.error = `comments page ${page}: ${r.status || r.error}`; break; }
      hits = hits.concat(r.body.hits || []);
      if (page + 1 >= (r.body.nbPages || 1)) break;
    }
    const top = hits.filter((h) => Number(h.parent_id) === sid);
    stats.hn = { thread: story.title, comments_in_window: hits.length, top_level: top.length, on_topic: 0, kept: 0 };
    for (const h of top) {
      const text = decode(String(h.comment_text || '').replace(/<p>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');
      if (!TOPIC.test(text)) continue;
      stats.hn.on_topic++;
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const first = lines[0] || '';
      const title = (ROLE.test(first) ? first : (lines.find((l) => ROLE.test(l) && l.length <= 200) || first)).slice(0, 200);
      const segs = first.split('|').map((x) => x.trim());
      const location = segs.slice(1).find((x) => /remote|onsite|on-site|hybrid|,|\b(us|usa|uk|eu|latam|europe)\b/i.test(x)) || (/remote/i.test(text) ? 'Remote' : '');
      jobs.push({ source: 'hn', url: `https://news.ycombinator.com/item?id=${h.objectID}`, title, company: segs[0].slice(0, 80), location, posted: String(h.created_at || '').slice(0, 10) });
      stats.hn.kept++;
    }
  }
} catch (e) { stats.hn.error = String(e?.message || e); }

log(JSON.stringify(stats));
process.stdout.write(JSON.stringify({ stats, jobs }));
