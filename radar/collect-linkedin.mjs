// LinkedIn public jobs listing (guest endpoint, no login, no key).
// Query matrix ported from the existing daily monitor (verified 2026-09-30),
// narrowed to postings from the last 3 days (f_TPR=r259200).
// Output: JSON array on stdout of {source,url,title,company,location,posted}.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const WINDOW = process.env.RADAR_LI_TPR || 'r259200'; // 3 days
const MAX_START = 50;

const CO_KW = ['planeacion', 'planeacion de demanda', 'demand planning', 'supply chain', 'S&OP', 'abastecimiento',
  'cadena de suministro', 'director de planeacion', 'jefe de planeacion', 'gerente de planeacion', 'IBP', 'inventarios'];
const US_KW = ['remote demand planning', 'demand planning manager remote', 'remote demand planning director', 'remote S&OP',
  'remote supply planning manager', 'remote IBP', 'remote supply chain planning', 'remote inventory planning manager',
  'remote head of planning', 'senior planner remote S&OP'];

const MATRIX = [
  ...['Medellín, Antioquia, Colombia', 'Bogotá, D.C., Capital District, Colombia', 'Colombia']
    .flatMap((loc) => CO_KW.map((kw) => ({ lane: 'colombia', loc, kw }))),
  ...US_KW.map((kw) => ({ lane: 'us-remote', loc: 'United States', kw })),
  ...['demand planning', 'supply chain planning', 'S&OP', 'IBP']
    .map((kw) => ({ lane: 'madrid', loc: 'Madrid, Community of Madrid, Spain', kw })),
  ...['LATAM supply chain', 'LATAM demand planning', 'Latin America supply chain', 'Americas demand planning',
    'remote demand planning', 'remote supply chain planning', 'remote S&OP', 'planificación de la demanda remoto']
    .map((kw) => ({ lane: 'spain', loc: 'Spain', kw })),
  ...['remote demand planning', 'remote S&OP', 'remote supply planning', 'demand planning LATAM']
    .map((kw) => ({ lane: 'latam-remote', loc: 'Latin America', kw })),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

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

async function fetchPage(kw, loc, start) {
  const url = `${BASE}?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&f_TPR=${WINDOW}&start=${start}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,es;q=0.8' } }).catch((e) => ({ ok: false, status: 0, err: e }));
    if (res.ok) return { status: 200, html: await res.text() };
    if (res.status === 429 || res.status === 0 || res.status >= 500) { await sleep(4000 * (attempt + 1)); continue; }
    return { status: res.status, html: '' };
  }
  return { status: 429, html: '' };
}

const seen = new Map();
const stats = { queries: 0, pages: 0, blocked: 0, cards: 0 };
for (const q of MATRIX) {
  stats.queries++;
  for (let start = 0; start < MAX_START;) {
    const { status, html } = await fetchPage(q.kw, q.loc, start);
    if (status !== 200) { stats.blocked++; break; }
    stats.pages++;
    const cards = parseCards(html);
    stats.cards += cards.length;
    for (const c of cards) {
      if (!seen.has(c.id)) seen.set(c.id, { ...c, lane: q.lane });
    }
    if (cards.length < 10) break;
    start += cards.length;
    await sleep(1200);
  }
  await sleep(800);
}

const jobs = [...seen.values()].map((c) => ({
  source: `linkedin:${c.lane}`,
  url: `https://www.linkedin.com/jobs/view/${c.id}`,
  title: c.title, company: c.company, location: c.location, posted: c.posted,
}));
process.stderr.write(`linkedin: ${stats.queries} queries, ${stats.pages} pages, ${stats.cards} cards, ${jobs.length} unique, ${stats.blocked} blocked/failed queries\n`);
process.stdout.write(JSON.stringify({ stats, jobs }));
