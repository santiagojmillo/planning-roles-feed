// Free Colombia / LATAM / remote boards: Magneto (sitemap + JSON-LD), GetOnBoard API, Remotive API.
// Output: JSON {stats, jobs:[{source,url,title,company,location,posted}]} on stdout.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DAYS = Number(process.env.RADAR_DAYS || 3);
const today = new Date();
const ageDays = (d) => (today - new Date(d)) / 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, { headers: { 'User-Agent': UA } }); } catch (e) {
      if (i >= 2) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

const PLAN_SLUG = /(planeacion|planning|demand|demanda|s-op|sop|ibp|abastecimiento|cadena-de-suministro|cadena-de-abastecimiento|supply|inventario|forecast|pronostico)/;
const LEVEL_SLUG = /(director|gerente|jefe|head|lider|manager|coordinador-nacional|lead)/;
const stats = {};
const jobs = [];

// Magneto (Colombia)
try {
  const xml = await (await get('https://sitemaps.magneto365.com/sitemap-jobs.xml')).text();
  const entries = [...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map((m) => ({ url: m[1], lastmod: m[2] }));
  const cand = entries.filter((e) => ageDays(e.lastmod) <= DAYS + 1 && PLAN_SLUG.test(e.url) && LEVEL_SLUG.test(e.url)).slice(0, 60);
  let fetched = 0;
  for (const e of cand) {
    const html = await (await get(e.url)).text().catch(() => '');
    fetched++;
    const ld = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g) || [];
    for (const block of ld) {
      try {
        const j = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/g, ''));
        if (j['@type'] !== 'JobPosting') continue;
        const place = [].concat(j.jobLocation || [])[0]?.address || {};
        jobs.push({ source: 'magneto', url: e.url, title: j.title || '', company: j.hiringOrganization?.name || '',
          location: [place.addressLocality, place.addressCountry].filter(Boolean).join(', '), posted: (j.datePosted || '').slice(0, 10) });
      } catch { /* not JSON-LD job */ }
    }
    await sleep(400);
  }
  stats.magneto = { sitemap: entries.length, candidates: cand.length, fetched };
} catch (e) { stats.magneto = { error: String(e) }; }

// GetOnBoard (LATAM)
try {
  let n = 0;
  for (const q of ['supply chain', 'planning', 'demand planning', 'abastecimiento', 'planeacion', 'inventory']) {
    const d = await (await get(`https://www.getonbrd.com/api/v0/search/jobs?query=${encodeURIComponent(q)}&per_page=60`)).json();
    for (const it of d.data || []) {
      const a = it.attributes || {};
      const posted = a.published_at ? new Date(a.published_at * 1000).toISOString().slice(0, 10) : '';
      jobs.push({ source: 'getonbrd', url: it.links?.public_url || `https://www.getonbrd.com/jobs/${it.id}`, title: a.title || '',
        company: a.company?.data?.attributes?.name || '', location: a.remote ? 'Remote' : (a.countries || []).join(', '), posted });
      n++;
    }
    await sleep(500);
  }
  stats.getonbrd = { items: n };
} catch (e) { stats.getonbrd = { error: String(e) }; }

// Remotive (remote)
try {
  let n = 0;
  for (const q of ['supply chain', 'demand planning', 'planning']) {
    const d = await (await get(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}`)).json();
    for (const j of d.jobs || []) {
      jobs.push({ source: 'remotive', url: j.url, title: j.title, company: j.company_name, location: j.candidate_required_location || 'Remote', posted: (j.publication_date || '').slice(0, 10) });
      n++;
    }
    await sleep(500);
  }
  stats.remotive = { items: n };
} catch (e) { stats.remotive = { error: String(e) }; }

// elempleo (Colombia). robots.txt allows /co/ofertas-empleo/ (search) and /co/ofertas-trabajo/ (offers); checked
// 2026-10-16. Search pages carry a schema.org ItemList (20 offers, newest first); each offer page carries a JobPosting
// with datePosted ("2026-9-11"), company, city and often the salary. Only titles with a level word are opened.
try {
  const QUERIES = ['planeacion', 'planeacion de la demanda', 'abastecimiento', 'cadena de abastecimiento', 'supply chain', 'inventarios', 's&op', 'demand planning'];
  const LEVEL = /(director|gerente|jefe|head|l[ií]der|manager|lead\b|coordinador nacional)/i;
  const offers = new Map(); let pages = 0;
  for (const q of QUERIES) {
    const slug = q.toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    for (let page = 1; page <= 3; page++) {
      const html = await (await get(`https://www.elempleo.com/co/ofertas-empleo/trabajo-${slug}${page > 1 ? `?page=${page}` : ''}`)).text().catch(() => '');
      pages++;
      const items = [...html.matchAll(/"@id":\s*"(https:\/\/www\.elempleo\.com\/co\/ofertas-trabajo\/[^"]+)",\s*"@type":\s*"WebPage",\s*"name":\s*"([^"]*)"/g)];
      for (const [, url, name] of items) if (!offers.has(url)) offers.set(url, name);
      await sleep(400);
      if (items.length < 20) break;
    }
  }
  const cand = [...offers].filter(([, name]) => LEVEL.test(name));
  let opened = 0; let kept = 0;
  for (const [url, name] of cand.slice(0, 80)) {
    const html = await (await get(url)).text().catch(() => '');
    opened++;
    for (const block of html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g) || []) {
      try {
        const j = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/g, ''));
        if (j['@type'] !== 'JobPosting') continue;
        const [y, m, d] = String(j.datePosted || '').split(/[-T]/);
        const posted = y && m && d ? `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` : '';
        if (posted && ageDays(posted) > DAYS + 1) break;
        const addr = j.jobLocation?.address || {};
        jobs.push({ source: 'elempleo', url, title: j.title || name, company: j.hiringOrganization?.name || '', location: [addr.addressLocality, addr.addressCountry === 'CO' ? 'Colombia' : addr.addressCountry].filter(Boolean).join(', '), posted });
        kept++;
      } catch { /* not JSON-LD job */ }
    }
    await sleep(400);
  }
  stats.elempleo = { search_pages: pages, offers: offers.size, level_titles: cand.length, opened, kept, capped: cand.length > 80 ? cand.length - 80 : 0 };
} catch (e) { stats.elempleo = { error: String(e) }; }

// SGestión / T-Apps candidate portals (Colombian ATS). Add more apps here.
const SG_APPS = [{ app: 'sg_chazey', company: 'Chazey Partners Colombia (GBS)' }];
for (const { app, company } of SG_APPS) {
  try {
    const base = 'https://www.sgestion.co/sg_panel/link/';
    const page = await get(`${base}empleo.php?app=${app}&lang=es`);
    const cookie = (page.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    const csrf = (await page.text()).match(/"csrf":"([a-f0-9]+)"/)?.[1] || '';
    const res = await fetch(`${base}portalCandidato/vacantes.php?app=${app}&lang=es`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf, Cookie: cookie },
    });
    const vac = (await res.json())?.data?.vacantes || [];
    for (const v of vac) {
      jobs.push({ source: `sgestion:${app}`, url: `${base}empleo.php?app=${app}&vacante=${v.id}&lang=es`, title: v.titulo || '',
        company, location: `${v.ciudad || 'Medellín'}, Colombia${v.modalidad ? ` (${v.modalidad})` : ''}`, posted: (v.publicada || '').slice(0, 10) });
    }
    stats[`sgestion:${app}`] = { items: vac.length };
  } catch (e) { stats[`sgestion:${app}`] = { error: String(e) }; }
}

process.stderr.write(`boards: ${JSON.stringify(stats)}\n`);
process.stdout.write(JSON.stringify({ stats, jobs }));
