// Merge all collector output into out/latest.json + out/latest.md.
// Rules: first-published ≤ RADAR_DAYS (default 3) days ago, planning title,
// eligible location (Colombia, Spain, remote, country-level US), not seen before.
//
// Usage: node radar/build.mjs <career-ops dir>

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CO = path.resolve(process.argv[2] || 'career-ops');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAYS = Number(process.env.RADAR_DAYS || 3);
const yaml = createRequire(path.join(CO, 'package.json'))('js-yaml');

const now = new Date();
const today = now.toISOString().slice(0, 10);
const ageDays = (d) => Math.floor((Date.parse(today) - Date.parse(d)) / 86400000);
const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return dflt; } };

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
const tff = portals.title_filter_full || portals.title_filter;
const titleOk = (t) => tff.positive.some((k) => kwTest(k, t)) && !tff.negative.some((k) => kwTest(k, t));

// ── Location gate ──
const LOC_CO_ES = /colombia|medell|bogot|antioquia|itag|envigado|rionegro|sabaneta|cundinamarca|mosquera|funza|madrid|spain|españa|espana/i;
const LOC_REMOTE = /remote|remoto|anywhere|worldwide|latam|latin america|americas|global|work from home|teletrabajo/i;
const LOC_US_COUNTRY = /^(united states( of america)?|usa|us)$/i;
function lane(job) {
  const l = (job.location || '').trim();
  const t = job.title || '';
  if (LOC_CO_ES.test(l)) return /madrid|spain|españa|espana/i.test(l) ? 'spain' : 'colombia';
  if (LOC_REMOTE.test(l) || /remote/i.test(t)) return 'remote';
  if (LOC_US_COUNTRY.test(l)) return 'us-country';
  if (!l) return 'unknown';
  return null;
}

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
for (const f of ['linkedin', 'boards']) {
  const d = readJson(path.join(ROOT, `tmp/${f}.json`), null);
  if (!d) { sources[f] = { error: 'no output' }; continue; }
  sources[f] = d.stats;
  cands.push(...d.jobs);
}

// ── Filter + dedup ──
const statePath = path.join(ROOT, 'state/seen.json');
const seen = readJson(statePath, {});
const normUrl = (u) => (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/$/, '');
const normRole = (j) => `${(j.company || '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${(j.title || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
const counts = { candidates: cands.length, undated: 0, too_old: 0, title: 0, location: 0, already_seen: 0, dup_in_run: 0, new: 0 };
const fresh = []; const runKeys = new Set();
for (const j of cands) {
  if (!j.posted || Number.isNaN(Date.parse(j.posted))) { counts.undated++; continue; }
  const age = ageDays(j.posted);
  if (age > DAYS) { counts.too_old++; continue; }
  if (!titleOk(j.title)) { counts.title++; continue; }
  const ln = lane(j);
  if (!ln) { counts.location++; continue; }
  const ku = normUrl(j.url); const kr = normRole(j);
  if (runKeys.has(ku) || runKeys.has(kr)) { counts.dup_in_run++; continue; }
  runKeys.add(ku); runKeys.add(kr);
  if (seen[ku] || seen[kr]) { counts.already_seen++; continue; }
  fresh.push({ ...j, age_days: age, lane: ln });
}
for (const j of fresh) { seen[normUrl(j.url)] = today; seen[normRole(j)] = today; }
for (const [k, d] of Object.entries(seen)) if (ageDays(d) > 90) delete seen[k];
counts.new = fresh.length;
fresh.sort((a, b) => a.age_days - b.age_days || a.lane.localeCompare(b.lane));

mkdirSync(path.join(ROOT, 'out/history'), { recursive: true });
mkdirSync(path.join(ROOT, 'state'), { recursive: true });
const report = { generated_at: now.toISOString(), window_days: DAYS, counts, sources, new: fresh };
writeFileSync(path.join(ROOT, 'out/latest.json'), JSON.stringify(report, null, 1));
writeFileSync(path.join(ROOT, `out/history/${today}.json`), JSON.stringify(report, null, 1));
writeFileSync(statePath, JSON.stringify(seen));
const md = [`# Job radar — ${today}`, '', `New live roles (≤${DAYS} days): **${fresh.length}**`, '',
  '| Age | Lane | Company | Title | Location | Source |', '|---|---|---|---|---|---|',
  ...fresh.map((j) => `| ${j.age_days}d | ${j.lane} | ${j.company} | [${j.title.replace(/\|/g, '/')}](${j.url}) | ${(j.location || '').replace(/\|/g, '/')} | ${j.source} |`),
  '', '```', JSON.stringify({ counts, sources }, null, 1), '```', ''].join('\n');
writeFileSync(path.join(ROOT, 'out/latest.md'), md);
console.log(`radar: ${fresh.length} new live roles; ${JSON.stringify(counts)}`);
