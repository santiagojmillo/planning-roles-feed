// Multinational employers with Colombian operations, read through Workday's public job search (CXS JSON), asking ONLY for
// Colombia / LATAM postings: a few requests per employer instead of paging a global board of thousands (reading J&J's
// whole board took 283 s on 2026-10-16). Tenants were verified live on 2026-10-16 (Unilever and Natura answer 403 to
// automated requests and Eli Lilly's search answers 422, so they are left out); a tenant that stops answering is
// reported in stats.errors, never silently skipped. Recency comes from Workday's "postedOn" ("Posted Today",
// "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago").
// Output (stdout): {stats, jobs:[{source:'employer:<name>', url, title, company, location, posted}]}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DAYS = Number(process.env.RADAR_DAYS || 3);
const SEARCHES = ['Colombia', 'Bogotá', 'Medellín', 'Latin America', 'LATAM'];
const MAX_PAGES = 3;            // 20 postings per page; results come newest-relevant first
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [tenant, wd host, site, display name]
const TENANTS = [
  ['ppg', 'wd5', 'ppg_careers', 'PPG'],
  ['diageo', 'wd3', 'diageo_careers', 'Diageo'],
  ['mdlz', 'wd3', 'external', 'Mondelez'],
  ['jj', 'wd5', 'JJ', 'Johnson & Johnson'],
  ['gsk', 'wd5', 'GSKCareers', 'GSK'],
  ['msd', 'wd5', 'SearchJobs', 'MSD'],
  ['mars', 'wd3', 'External', 'Mars'],
  ['dow', 'wd1', 'ExternalCareers', 'Dow'],
  ['kimberlyclark', 'wd1', 'GLOBAL', 'Kimberly-Clark'],
  ['abbott', 'wd5', 'abbottcareers', 'Abbott'],
  ['medtronic', 'wd1', 'medtroniccareers', 'Medtronic'],
  ['novartis', 'wd3', 'novartis_careers', 'Novartis'],
  ['sanofi', 'wd3', 'sanoficareers', 'Sanofi'],
  ['heinz', 'wd1', 'kraftheinz_careers', 'Kraft Heinz'],
  ['philips', 'wd3', 'jobs-and-careers', 'Philips'],
  ['nike', 'wd1', 'nke', 'Nike'],
  ['gehc', 'wd5', 'gehc_externalsite', 'GE HealthCare'],
  ['smithnephew', 'wd5', 'external', 'Smith+Nephew'],
  ['galderma', 'wd3', 'external', 'Galderma'],
  ['shell', 'wd3', 'ShellCareers', 'Shell'],
];

function ageDays(postedOn) {
  const t = String(postedOn || '').toLowerCase();
  if (/today|hoy/.test(t)) return 0;
  if (/yesterday|ayer/.test(t)) return 1;
  if (/30\+/.test(t)) return 31;
  const m = t.match(/(\d+)\s*(day|día|dia)/); if (m) return Number(m[1]);
  return null;
}
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function search(t, wd, site, text, offset) {
  const url = `https://${t}.${wd}.myworkdayjobs.com/wday/cxs/${t}/${site}/jobs`;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: text }),
        signal: AbortSignal.timeout(25000),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return await r.json();
    } catch (e) {
      if (i >= 2) return { error: e?.name === 'TimeoutError' ? 'timeout' : String(e?.message || e) };
      await sleep(3000 * (i + 1));
    }
  }
}

const stats = { tenants: TENANTS.length, requests: 0, postings_seen: 0, old_or_undated: 0, kept: 0, by_employer: {}, errors: [] };
const jobs = []; const seen = new Set();
for (const [t, wd, site, name] of TENANTS) {
  const b = (stats.by_employer[name] = { seen: 0, kept: 0 });
  let failed = 0;
  for (const text of SEARCHES) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await search(t, wd, site, text, page * 20);
      stats.requests++;
      await sleep(400);
      if (d.error) { failed++; break; }
      const posts = d.jobPostings || [];
      let fresh = 0;
      for (const p of posts) {
        const key = `${t}${p.externalPath}`;
        if (!p.externalPath || seen.has(key)) continue;
        seen.add(key); stats.postings_seen++; b.seen++;
        const age = ageDays(p.postedOn);
        if (age === null || age > DAYS) { stats.old_or_undated++; continue; }
        fresh++;
        jobs.push({ source: `employer:${name}`, url: `https://${t}.${wd}.myworkdayjobs.com/${site}${p.externalPath}`, title: p.title || '', company: name, location: p.locationsText || '', posted: isoDaysAgo(age) });
        stats.kept++; b.kept++;
      }
      if (posts.length < 20 || (page > 0 && fresh === 0)) break;
    }
  }
  if (failed === SEARCHES.length) stats.errors.push(`${name} (${t}/${site}): no search answered`);
}
process.stderr.write(`employers: ${stats.tenants} Workday employers, ${stats.requests} requests, ${stats.postings_seen} Colombia/LATAM postings seen, ${stats.kept} within ${DAYS} days${stats.errors.length ? `; FAILED: ${stats.errors.join('; ')}` : ''}\n`);
process.stdout.write(JSON.stringify({ stats, jobs }));
