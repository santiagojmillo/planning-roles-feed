// Pure helpers for job-radar build.mjs: HTML → text, field extraction (remote / intl /
// US-only signals / salary / years / contract flags), lane assignment per the owner's
// eligibility rules, and relative-date parsing. No I/O, no network.
//
// Self-test: node radar/classify.mjs --self-test

// ───────────────────────────── text ─────────────────────────────
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', euro: '€', pound: '£', yen: '¥', copy: '©', reg: '®', trade: '™',
  iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', deg: '°', times: '×', shy: '',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ccedil: 'ç', atilde: 'ã', otilde: 'õ',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù', acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü', Ccedil: 'Ç', Atilde: 'Ã', Otilde: 'Õ',
};
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return e in NAMED_ENTITIES ? NAMED_ENTITIES[e] : m;
  });
}

// HTML (or HTML-escaped HTML, as Greenhouse returns) → readable plain text, one block per line.
export function cleanText(html) {
  let s = String(html ?? '');
  if (!s.trim()) return '';
  if (!/<[a-z!/]/i.test(s) && /&lt;\s*\/?\s*[a-z]/i.test(s)) s = decodeEntities(s); // escaped markup
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|dd|dt|pre|figure)\s*>/gi, '\n')
    .replace(/<(p|div|h[1-6]|tr|section|article|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/ /g, ' ');
  return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

// Length-preserving accent stripper (é→e, ñ→n) so ASCII regexes and verbatim slicing share indexes.
export function deaccent(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    if (ch.charCodeAt(0) < 0x80 || ch.length !== 1) { out += ch; continue; }
    const n = ch.normalize('NFD');
    out += n.length > 1 && /[A-Za-z]/.test(n[0]) ? n[0] : ch;
  }
  return out;
}

const BOILERPLATE = [
  /^show (more|less)$/i, /equal (employment )?opportunity/i, /without regard to/i, /all qualified applicants/i, /\bcookies?\b/i,
  /privacy (policy|notice|statement)/i, /^apply( now)?!?$/i, /share this job/i, /^sign in/i, /join to apply/i, /referrals increase/i,
  /get notified about new/i, /see who you know/i, /^palabras clave/i, /^set (job )?alert/i, /^similar jobs/i, /^about the job$/i,
  /^job description$/i, /^descripci[oó]n del (puesto|cargo|empleo)$/i, /reasonable accommodation/i, /\be-verify\b/i, /^report this job/i,
  /^you may also like/i, /^job details$/i, /^job id:?\s*\S+$/i, /^[\W•]*$/,
];
// First `max` chars of the cleaned description with boilerplate lines removed.
export function excerpt(text, max = 700) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 2 && !BOILERPLATE.some((re) => re.test(l)));
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (joined.length <= max) return joined;
  const cut = joined.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim() + '…';
}

// ───────────────────────────── detection helpers ─────────────────────────────
const NEG_BEFORE = /(\bnot\b|\bno es\b|\bisn'?t\b|\bnon[- ]?|\bno\b|\bnunca\b|\bcannot\b|\bcan'?t\b|\bunable\b|\bwithout\b|\bsin\b)[^.;:\n!?]*$/;
const negatedBefore = (norm, idx, window = 40) => NEG_BEFORE.test(norm.slice(Math.max(0, idx - window), idx));

const REMOTE_RE = /\b(remote|remot[oa]s?|teletrabajo|home[- ]office|work from home|from anywhere|100 ?% ?remot\w*|fully remote|distributed team)\b/g;
const FULLY_REMOTE_RE = /\b(fully remote|100 ?% ?remot\w*|completamente remot[oa]|totalmente remot[oa]|remote[- ]first|work from anywhere)\b/;
// hybrid / on-site statements. "hybrid" is skipped in technical collocations; "on-site" is skipped for visits/audits.
const ONSITE_RE = /\b(hybrid(?!\s+(?:cloud|planning|app|application|architecture|approach|algorithm|vehicle|method|model (?:of|for)|forecasting))|hibrid[oa]s?|(?<!\boccasional |\bperiodic |\bsome |\bfree )on[- ]?site(?!\s+(?:visit|audit|inspection|presence at|travel|support to|trip|facilit|gym|parking|cafeteria|canteen|amenit|childcare|daycare|restaurant|dining|fitness|laundry|clinic|medical|nurse|massage|perks|meals?|lunch|breakfast))|presencial(?:es|idad)?|in[- ]office|days? (?:per|a) week in|dias? (?:a la|por) semana en)\b/g;

const INTL_RE = /\b(latam|latin ?america|latinoamerica|america latina|international candidates|candidates (?:outside|in any country)|anywhere in the world|worldwide|work from anywhere|global remote|independent contractor|contractors?|contrato por prestacion|colombia)\b/g;
const INTL_NEG = /(\bnot\b|\bno\b|\bnon\b|\bisn'?t\b|\bcannot\b|\bcan'?t\b|\bunable\b|\bexcept\b|\bexcluding\b|\bunfortunately\b|\bsin\b)[^.;:\n!?]*$/;

const US_STATES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri',
  'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming', 'district of columbia', 'washington, d.c.', 'washington d.c.', 'washington dc'];
const US_STATE_CODES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
  'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY', 'DC']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const US_STATE_RE = new RegExp(`\\b(${US_STATES.slice().sort((a, b) => b.length - a.length).map(esc).join('|')})\\b`, 'g');
const NON_US_GEO = /\b(colombia|mexico|latam|latin america|latinoamerica|spain|espana|argentina|chile|peru|brazil|brasil|costa rica|uruguay|ecuador|panama|guatemala|europe|emea|canada|uk|united kingdom|india|philippines|portugal|germany|france|poland|romania)\b/;

const snippet = (orig, start, end, max = 60) => {
  let s = orig.slice(start, Math.min(end, start + max)).replace(/\s+/g, ' ').trim();
  if (end - start > max) { const sp = s.lastIndexOf(' '); if (sp > max * 0.5) s = s.slice(0, sp); }
  return s.replace(/[\s,;:(\-–]+$/, '');
};
const upperAt = (orig, idx) => /^(US|U\.S\.|W)/.test(orig.slice(idx, idx + 4)); // "US"/"U.S."/"W2" must be upper-case in the original

function usOnlySignals(orig, norm) {
  const out = [];
  const push = (s) => { if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase()) && out.length < 8) out.push(s); };
  let m;
  const re401 = /\b401 ?\(?k\)?/g;
  while ((m = re401.exec(norm))) push(snippet(orig, m.index, m.index + m[0].length));
  // US Remote / US-based / U.S.-based / based in the US / US-only
  const reUs = /\b(?:(us|u\.s\.)[- ]?(?:remote|based|only)|united states[- ]based|based in the (?:us|u\.s\.|united states)|remote[- ](?:us|usa)\b(?! time)|remote \((?:us|usa|united states)(?: only)?\))\b/g;
  while ((m = reUs.exec(norm))) {
    const needsUpper = /^(us|u\.s\.)/.test(m[0]) || /^remote[- (]/.test(m[0]);
    if (needsUpper) { const i = m[0].search(/us|u\.s\./); if (!upperAt(orig, m.index + i)) continue; }
    push(snippet(orig, m.index, m.index + Math.max(m[0].length, 40)));
  }
  // authorized / eligible to work in the United States
  const reAuth = /\b(?:(?:authori[sz]ed|authori[sz]ation|eligible|eligibility|legally (?:able|permitted|entitled)|right|permission|permitted) to work (?:in|within) the (?:united states|u\.?s\.?a?\b)|(?:us|u\.s\.) work authori[sz]ation|work authori[sz]ation in the (?:us|u\.s\.|united states))/g;
  while ((m = reAuth.exec(norm))) push(snippet(orig, m.index, m.index + Math.max(m[0].length, 50)));
  // must reside / be located / live in … (skipped when the sentence names a non-US geography)
  const reReside = /\bmust (?:currently )?(?:reside|be located|live|be living|be based|be physically located) (?:in|within)\b/g;
  while ((m = reReside.exec(norm))) {
    const after = norm.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (NON_US_GEO.test(after)) continue;
    push(snippet(orig, m.index, m.index + m[0].length + 40));
  }
  // W2 / W-2 (upper-case)
  const reW2 = /\bw-?2\b/g;
  while ((m = reW2.exec(norm))) if (upperAt(orig, m.index) && !/^w-?2 form of/.test(norm.slice(m.index))) push(snippet(orig, m.index, m.index + Math.max(m[0].length, 30)));
  // citizenship / green card / clearance
  const reCit = /\b(?:(?:us|u\.s\.) citizen(?:ship)?|green card|security clearance|(?:us|u\.s\.) person)\b/g;
  while ((m = reCit.exec(norm))) { if (/^us\b/.test(m[0]) && !upperAt(orig, m.index)) continue; push(snippet(orig, m.index, m.index + Math.max(m[0].length, 40))); }
  // ≥ 3 distinct US states (full names anywhere; abbreviations only in "City, ST" or "ST, ST, ST" lists)
  const states = new Map();
  US_STATE_RE.lastIndex = 0;
  while ((m = US_STATE_RE.exec(norm))) if (!states.has(m[1])) states.set(m[1], m.index);
  const reCityState = /\b[A-Z][A-Za-z.]+(?: [A-Z][A-Za-z.]+){0,2}, ([A-Z]{2})\b/g;
  while ((m = reCityState.exec(orig))) if (US_STATE_CODES.has(m[1]) && !states.has(m[1])) states.set(m[1], m.index + m[0].length - 2);
  const reCodeList = /\b[A-Z]{2}(?:\s*(?:,|\/|&|\bor\b|\band\b)\s*[A-Z]{2}){2,}\b/g;
  while ((m = reCodeList.exec(orig))) for (const c of m[0].match(/\b[A-Z]{2}\b/g) || []) if (US_STATE_CODES.has(c) && !states.has(c)) states.set(c, m.index + m[0].indexOf(c));
  if (states.size >= 3) {
    const names = [...states.entries()].sort((a, b) => a[1] - b[1]).map(([k, i]) => (k.length === 2 ? k : orig.slice(i, i + k.length)));
    push(`states: ${names.join(', ')}`.slice(0, 60));
  }
  return out;
}

// Salary: first currency pattern with a number (range preferred when it starts at the same place).
const NUM = '\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d+)?(?:\\s?[kKMm](?![A-Za-z]))?(?![\\d%])';
const SYM = '(?:US\\$|USD|COP|EUR|MXN|CLP|ARS|PEN|BRL|UYU|GTQ|CRC|DOP|GBP|CAD|AUD|CHF|€|£|\\$)';
const POST = '(?:USD|COP|EUR|MXN|CLP|ARS|PEN|BRL|UYU|GTQ|CRC|DOP|GBP|CAD|€|£|dollars|d[oó]lares|pesos|euros|usd)';
const UNIT = `(?:\\s?${POST})?(?:\\s?(?:/|per|por|al|a[l]?\\s)\\s?(?:year|yr|annum|month|mes|hour|hr|hora|a[ñn]o|week|semana|day|d[ií]a)(?:ly)?|\\s?(?:anuales?|mensuales?|annually|yearly|monthly|hourly|brutos?|netos?|gross|net|base))?`;
const SEP = '\\s?(?:-|–|—|to|a|and|y|hasta)\\s?';
const SAL_P1 = new RegExp(`${SYM}\\s?(?:${NUM})(?:${SEP}${SYM}?\\s?(?:${NUM}))?${UNIT}`, 'g');
const SAL_P2 = new RegExp(`(?<![\\w.,])(?:${NUM})(?:${SEP}(?:${NUM}))?\\s?${POST}\\b${UNIT}`, 'g');
const SAL_P3 = new RegExp(`(?:salary|salario|sueldo|compensation|remuneraci[oó]n|pay range|base pay|rango salarial|asignaci[oó]n salarial)[^\\n.]{0,40}?(${SYM}?\\s?(?:${NUM})(?:${SEP}${SYM}?\\s?(?:${NUM}))?${UNIT})`, 'gi');
function firstSalary(orig) {
  let best = null;
  const consider = (idx, text) => {
    if (!/\d{2}|\d\s?[kKMm]\b/.test(text)) return;             // needs ≥ 2 digits or a k/M figure
    if (/^\$?\s?\d{1,2}([.,]\d+)?\s?%/.test(text)) return;       // percentages
    if (best === null || idx < best.idx) best = { idx, text };
  };
  let m;
  SAL_P1.lastIndex = 0; while ((m = SAL_P1.exec(orig))) consider(m.index, m[0]);
  SAL_P2.lastIndex = 0; while ((m = SAL_P2.exec(orig))) consider(m.index, m[0]);
  SAL_P3.lastIndex = 0; while ((m = SAL_P3.exec(orig))) consider(m.index + m[0].indexOf(m[1]), m[1]);
  if (!best) return null;
  return best.text.replace(/\s+/g, ' ').replace(/[\s,;:(\-–]+$/, '').trim().slice(0, 80);
}

const YEARS_RE = /\b(\d{1,2})\s?(?:\+|or more|o mas)?\s?(?:(?:-|–|to|a|or)\s?\d{1,2}\s?\+?\s?)?(?:years?|yrs?|anos?|annos?)\b/g;
const YEARS_CTX_AFTER = /^[^.\n]{0,60}?(experien|exp\b|trabajando|working|in (?:supply|demand|planning|s&op|a |an )|en (?:planeacion|planificacion|cadena|supply|demanda|roles|cargos))/;
const YEARS_CTX_BEFORE = /(minimum|minimo|at least|al menos|mas de|more than|over|requires?|require|experien|experiencia de|con)\W*$/;
function yearsRequired(norm) {
  let fallback = null; let m;
  YEARS_RE.lastIndex = 0;
  while ((m = YEARS_RE.exec(norm))) {
    const n = Number(m[1]);
    if (!(n >= 1 && n <= 25)) continue;
    const after = norm.slice(m.index + m[0].length, m.index + m[0].length + 70);
    const before = norm.slice(Math.max(0, m.index - 40), m.index);
    if (YEARS_CTX_AFTER.test(after) || YEARS_CTX_BEFORE.test(before)) return n;
    if (fallback === null) fallback = n;
  }
  return fallback;
}

const CONTRACT_FLAGS = [
  ['fixed-term', /\bfixed[- ]term\b|\btermino fijo\b|\bcontrato a termino\b|\bcontrato por (?:\d+|dos|tres|seis|doce) meses\b|\b(?:\d{1,2}|six|twelve|nine|seis|doce)[- ]month (?:contract|assignment|position|role|engagement)\b|\bcontrato temporal\b|\bplazo fijo\b/],
  ['temporal', /\btemporal(?:es)?\b|\btemporary\b|\btemporari[oa]\b|\btemp\b(?= (?:role|position|contract|assignment))/],
  ['obra o labor', /\bobra o labor\b|\bobra labor\b/],
  ['maternity', /\bmaternity (?:leave )?(?:cover|replacement|backfill)\b|\bcover(?:ing)? (?:for )?(?:a |an |the )?maternity\b|\bmaternity leave (?:contract|position|role|vacancy)\b|\breemplazo (?:por|de) (?:licencia de )?maternidad\b|\b(?:cubrir|cobertura de) licencia de maternidad\b/],
  ['cover', /\b(?:maternity|paternity|parental|sick|leave|absence) cover\b|\bcover(?:ing)? (?:for )?(?:a |an |the )?(?:maternity|paternity|parental|sick|leave|absence)\b|\bleave of absence cover\b/],
  ['interim', /\binterim\b|\binterin[oa]\b/],
  ['internship', /\binternship\b|\bintern\b|\bpracticas profesionales\b|\b(?:alumnos?|estudiantes?) en practica\b|\bpractica profesional\b|\bpasantia\b|\bestagio\b/],
  ['practicante', /\bpracticantes?\b/],
  ['pasante', /\bpasantes?\b/],
  ['part-time', /\bpart[- ]time\b|\b(?:tiempo|jornada) parcial\b/],
  ['medio tiempo', /\bmedio tiempo\b|\bmedia jornada\b/],
];

// ───────────────────────────── extractFields ─────────────────────────────
// { title, location, text } → { remote, intl_ok, us_only_signals, salary, years_required, contract_flags }
export function extractFields({ title = '', location = '', text = '' } = {}) {
  const orig = `${location || ''}\n${title || ''}\n${text || ''}`;
  const norm = deaccent(orig).toLowerCase();
  const bodyStart = (location || '').length + 1 + (title || '').length + 1;

  // verbatim context around a match, for the audit trail (`evidence`)
  const ctx = (idx, len) => orig.slice(Math.max(0, idx - 35), idx + len + 35).replace(/\s+/g, ' ').trim();

  // remote
  let remoteHit = null; let negatedHit = null; let onsiteHit = null; let m;
  REMOTE_RE.lastIndex = 0;
  while ((m = REMOTE_RE.exec(norm))) {
    if (negatedBefore(norm, m.index)) negatedHit ??= [m.index, m[0].length];
    else remoteHit ??= [m.index, m[0].length];
  }
  ONSITE_RE.lastIndex = 0;
  while ((m = ONSITE_RE.exec(norm))) if (!negatedBefore(norm, m.index)) { onsiteHit = [m.index, m[0].length]; break; }
  const fully = FULLY_REMOTE_RE.test(norm);
  let remote = null; let remoteEvidence = null;
  if (onsiteHit && !fully) { remote = false; remoteEvidence = ctx(...onsiteHit); }
  else if (remoteHit) { remote = true; remoteEvidence = ctx(...remoteHit); }
  else if (negatedHit) { remote = false; remoteEvidence = ctx(...negatedHit); }

  // intl_ok ("colombia" only counts when the location itself is not Colombia)
  const locIsCO = geo(location).country === 'CO';
  let intl_ok = false; let intlEvidence = null;
  INTL_RE.lastIndex = 0;
  while ((m = INTL_RE.exec(norm))) {
    if (m[1] === 'colombia' && locIsCO) continue;
    const before = norm.slice(Math.max(0, m.index - 40), m.index);
    const after = norm.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (INTL_NEG.test(before)) continue;
    // "worldwide" counts only in a hiring context ("hire worldwide", "remote worldwide"), not "customers worldwide"
    if (m[1] === 'worldwide' && !(/(remote|work(?:ing)?|hire|hiring|recruit(?:ing)?|candidates?|applicants?|anywhere|open to|talent|employees|team members|positions?|roles?|from|located|based)\W{1,3}$/.test(before)
      || /^\W{1,3}(remote|candidates?|applicants?|talent|hiring|team|employees)/.test(after))) continue;
    // "contractor" as an engagement type, not EEO boilerplate ("Federal Contractor") or vendor management
    if (/^contractors?$/.test(m[1]) && (/(federal|government|defense|defence|prime|general|third[- ]party|sub|military|external|outside)\W{1,3}$/.test(before)
      || /^\W{1,3}(management|relationships?|performance|oversight|compliance|safety|selection|invoices?|agreements? with|and (?:supplier|vendor)s?|or (?:supplier|vendor)s?)/.test(after))) continue;
    intl_ok = true; intlEvidence = ctx(m.index, m[0].length); break;
  }

  const us_only_signals = usOnlySignals(orig, norm);
  const salary = firstSalary(orig.slice(bodyStart)) || firstSalary(orig);
  const years_required = yearsRequired(norm.slice(bodyStart));
  const contract_flags = CONTRACT_FLAGS.filter(([, re]) => re.test(norm)).map(([k]) => k);
  return { remote, intl_ok, us_only_signals, salary, years_required, contract_flags, evidence: { remote: remoteEvidence, intl: intlEvidence } };
}

// ───────────────────────────── geography ─────────────────────────────
const CO_MEDELLIN = ['medellin', 'envigado', 'itagui', 'sabaneta', 'bello', 'rionegro', 'guarne', 'girardota', 'la estrella', 'copacabana', 'antioquia'];
const CO_BOGOTA = ['bogota', 'd.c.', 'd.c', 'capital district', 'distrito capital', 'funza', 'mosquera', 'madrid', 'cota', 'siberia', 'chia', 'cajica', 'tenjo',
  'tabio', 'sopo', 'la calera', 'soacha', 'tocancipa', 'gachancipa', 'zipaquira', 'facatativa', 'cundinamarca'];
// names that identify Colombia even without the country word (ambiguous ones like Madrid / Bello / Córdoba / Armenia excluded)
const CO_DISTINCT = ['medellin', 'envigado', 'itagui', 'sabaneta', 'rionegro', 'guarne', 'girardota', 'la estrella', 'antioquia', 'bogota', 'capital district',
  'distrito capital', 'funza', 'mosquera', 'chia', 'cajica', 'tenjo', 'tabio', 'sopo', 'la calera', 'soacha', 'tocancipa', 'gachancipa', 'zipaquira', 'facatativa',
  'cundinamarca', 'cali', 'barranquilla', 'bucaramanga', 'pereira', 'manizales', 'cucuta', 'ibague', 'santa marta', 'villavicencio', 'cartagena de indias',
  'valle del cauca', 'risaralda', 'atlantico', 'tolima', 'huila', 'narino', 'boyaca', 'quindio', 'choco', 'magdalena', 'casanare', 'la guajira', 'dosquebradas',
  'floridablanca', 'palmira', 'popayan', 'monteria', 'sincelejo', 'tunja', 'yopal', 'neiva', 'pasto', 'valledupar'];
const CO_ANY_CITY = [...new Set([...CO_MEDELLIN, ...CO_BOGOTA, ...CO_DISTINCT])];
const ES_MADRID = ['madrid', 'alcobendas', 'pozuelo', 'getafe', 'las rozas', 'tres cantos', 'san fernando de henares', 'torrejon', 'alcala de henares',
  'community of madrid', 'comunidad de madrid', 'leganes', 'mostoles', 'fuenlabrada', 'alcorcon', 'majadahonda', 'boadilla', 'rivas', 'coslada', 'parla', 'valdemoro'];
const ES_DISTINCT = ['madrid', 'barcelona', 'sevilla', 'seville', 'bilbao', 'zaragoza', 'malaga', 'alicante', 'valladolid', 'vigo', 'gijon', 'pamplona',
  'san sebastian', 'donostia', 'catalonia', 'cataluna', 'catalunya', 'andalusia', 'andalucia', 'basque country', 'pais vasco', 'euskadi', 'galicia', 'castilla',
  'aragon', 'asturias', 'cantabria', 'navarra', 'murcia', 'canarias', 'canary islands', 'baleares', 'balearic', 'comunidad valenciana', 'valencian community',
  'extremadura', 'la rioja', 'castellon', 'tarragona', 'girona', 'lleida', 'almeria', 'cadiz', 'huelva', 'jaen', 'badajoz', 'burgos', 'leon', 'albacete', 'toledo',
  'guadalajara, spain', 'esplugues', 'llobregat', 'sant cugat', 'hospitalet', 'rubi', 'terrassa', 'sabadell', 'mataro', 'manresa', 'getafe', 'alcobendas', 'pozuelo',
  'las rozas', 'tres cantos', 'alcala de henares', 'torrejon'];
const LATAM_COUNTRIES = ['mexico', 'argentina', 'chile', 'peru', 'brazil', 'brasil', 'uruguay', 'ecuador', 'costa rica', 'panama', 'dominican republic',
  'republica dominicana', 'guatemala', 'paraguay', 'bolivia'];
const LATAM_TAGS = ['latin america', 'latam', 'latinoamerica', 'america latina', 'americas', 'south america', 'central america', 'sudamerica', 'suramerica', 'centroamerica'];
// LATAM metro names that appear without a country (LinkedIn "X Metropolitan Area"); US-colliding names (San Jose, Lima) deliberately left out.
const LATAM_CITIES = ['mexico city', 'ciudad de mexico', 'cdmx', 'monterrey', 'guadalajara', 'buenos aires', 'santiago de chile', 'santiago metropolitan', 'sao paulo',
  'rio de janeiro', 'montevideo', 'quito', 'guayaquil', 'panama city', 'santo domingo', 'guatemala city', 'asuncion', 'santa cruz de la sierra', 'cordoba, argentina',
  'nuevo leon', 'jalisco', 'queretaro', 'torreon', 'tijuana', 'puebla', 'recife', 'belo horizonte', 'brasilia', 'fortaleza', 'manaus', 'curitiba', 'porto alegre',
  'rosario', 'mendoza', 'valparaiso', 'arequipa'];
const US_METRO_CORES = ['boston', 'new york', 'los angeles', 'chicago', 'dallas', 'fort worth', 'seattle', 'washington dc', 'baltimore', 'atlanta', 'philadelphia',
  'denver', 'houston', 'miami', 'fort lauderdale', 'phoenix', 'minneapolis', 'st. louis', 'detroit', 'san diego', 'austin', 'pittsburgh', 'nashville', 'charlotte',
  'orlando', 'tampa', 'salt lake', 'portland', 'las vegas', 'kansas city', 'cincinnati', 'columbus', 'indianapolis', 'raleigh', 'sacramento', 'san francisco',
  'san jose', 'bay area', 'milwaukee', 'cleveland', 'hartford', 'richmond', 'jacksonville', 'memphis', 'louisville', 'oklahoma city', 'new orleans', 'buffalo',
  'rochester', 'albany', 'grand rapids', 'omaha', 'tulsa', 'el paso', 'san antonio', 'birmingham', 'providence', 'honolulu', 'boise', 'madison', 'des moines',
  'albuquerque', 'tucson', 'fresno', 'baton rouge', 'knoxville', 'greenville', 'chattanooga', 'harrisburg', 'allentown', 'dayton', 'toledo', 'akron', 'wichita',
  'spokane', 'reno', 'anchorage', 'charleston', 'savannah', 'lexington', 'syracuse', 'hartford'];
const US_COUNTRY_TOKEN = /^(?:the )?(?:united states(?: of america)?|usa|u\.s\.a?\.?|us|estados unidos|eeuu|ee\.uu\.)$/;
const GEO_NOISE = /\b(remote|remoto|remota|hybrid|hibrido|on[- ]?site|presencial|only|nationwide|anywhere|worldwide|global|timezones?|time zones?|based|from|desde|work from home|teletrabajo|or|o|y|and)\b/g;
const has = (n, list) => list.some((w) => new RegExp(`(^|[^a-z])${esc(w)}($|[^a-z])`).test(n));

// Location string → { country: 'CO'|'ES'|'LATAM'|'US'|'OTHER'|'NONE', metro: 'medellin'|'bogota'|'madrid'|null, countryLevel }
export function geo(location) {
  const raw = String(location ?? '').replace(/\s+/g, ' ').trim();
  const n = deaccent(raw).toLowerCase();
  const rawTokens = raw.split(/\s*[,;/|]\s*/).filter(Boolean);
  const tokens = n.split(/\s*[,;/|]\s*/).filter(Boolean).map((t) => t.replace(/[()]/g, ' ').replace(GEO_NOISE, ' ').replace(/[\s:–-]+/g, ' ').trim());
  const stripped = n.replace(/[()]/g, ' ').replace(GEO_NOISE, ' ').replace(/[\s:,;/|–-]+/g, ' ').trim();

  const isCO = /(^|[^a-z])colombia($|[^a-z])/.test(n) || (/(^|[,\s])co$/.test(n) && has(n, CO_ANY_CITY)) || (has(n, CO_DISTINCT) && !/(^|[^a-z])(spain|espana|mexico|argentina|chile|peru|venezuela|ecuador|panama|brazil|brasil|united states|usa)($|[^a-z])/.test(n));
  if (isCO) {
    const metro = has(n, CO_MEDELLIN) ? 'medellin' : has(n, CO_BOGOTA) ? 'bogota' : null;
    const countryLevel = !metro && !has(n, CO_ANY_CITY) && !has(n, ['valle', 'santander', 'caldas', 'cauca', 'meta', 'cesar', 'sucre', 'bolivar', 'cordoba', 'amazonas', 'arauca', 'putumayo', 'vichada', 'guaviare', 'vaupes', 'guainia', 'san andres']);
    return { country: 'CO', metro, countryLevel, raw };
  }
  const isES = /(^|[^a-z])(spain|espana|espanha|espagne)($|[^a-z])/.test(n) || /(^|[,\s])es$/.test(n) || (has(n, ES_DISTINCT) && !/(^|[^a-z])(colombia|mexico|argentina|chile|peru|venezuela|cundinamarca|united states|usa)($|[^a-z])/.test(n));
  const meaningful = tokens.filter(Boolean);
  if (isES) {
    const metro = has(n, ES_MADRID) ? 'madrid' : null;
    return { country: 'ES', metro, countryLevel: !metro && meaningful.length <= 1, raw };
  }
  const nNoNewMexico = n.replace(/new mexico/g, 'nm-state');
  if (has(nNoNewMexico, LATAM_COUNTRIES) || has(n, LATAM_TAGS) || has(n, LATAM_CITIES)) {
    return { country: 'LATAM', metro: null, countryLevel: meaningful.length <= 1 && !has(n, LATAM_CITIES), raw };
  }
  // United States: country tokens, state names, "City, ST", LinkedIn metro phrases ("Greater Boston Area", "Greater Cleveland")
  const hasCountryToken = tokens.some((t) => US_COUNTRY_TOKEN.test(t)) || US_COUNTRY_TOKEN.test(stripped) || /(^|[^a-z])(united states|usa|u\.s\.a?\.?)($|[^a-z])/.test(n) || /\bUS\b/.test(raw);
  const stateName = has(n, US_STATES.filter((s) => s !== 'georgia' && s !== 'washington')) || /(^|[^a-z])(georgia|washington)($|[^a-z])/.test(n) && hasCountryToken;
  const cityState = rawTokens.some((t, i) => i > 0 && US_STATE_CODES.has(t.trim()) && /^[A-Za-zÀ-ÿ.' -]+$/.test(rawTokens[i - 1]));
  const metroPhrase = /\b(metropolitan area|greater|area|metroplex)\b/.test(n) && has(n, US_METRO_CORES);
  const dc = /\bwashington,? d\.?c\.?\b/.test(n) || /\bd\.?c\.?\b/.test(n) && has(n, ['washington']);
  if (hasCountryToken || stateName || cityState || metroPhrase || dc) {
    const subnational = stateName || cityState || metroPhrase || dc || (hasCountryToken && tokens.filter((t) => t && !US_COUNTRY_TOKEN.test(t) && !/^(canada|europe|apac|emea|uk|united kingdom|australia|mexico|india|usa timezones)$/.test(t)).some((t) => /^[a-z .'-]{3,}$/.test(t) && !/^(north|northern) america$/.test(t)));
    return { country: 'US', metro: null, countryLevel: !subnational, raw };
  }
  if (!stripped || /^(remote|global|worldwide|anywhere|international|emea|europe|apac|north america|northern america|canada europe|europe canada|wfh)$/.test(stripped)) {
    return { country: 'NONE', metro: null, countryLevel: false, raw };
  }
  return { country: 'OTHER', metro: null, countryLevel: tokens.length <= 1, raw };
}

// True when the location alone already qualifies the posting (no body needed): Medellín / Bogotá / Madrid metro, country-level Colombia.
export function locationQualifiesAlone(location) {
  const g = geo(location);
  return (g.country === 'CO' && (g.metro !== null || g.countryLevel)) || (g.country === 'ES' && g.metro === 'madrid');
}

// ───────────────────────────── assignLane ─────────────────────────────
// Owner's eligibility rules, verbatim. → { lane, drop_reason }
export function assignLane({ location, title, remote, intl_ok, us_only_signals } = {}) {
  const g = geo(location);
  const usOnly = Array.isArray(us_only_signals) && us_only_signals.length > 0;
  const keep = (lane) => ({ lane, drop_reason: null });
  const drop = (reason) => ({ lane: null, drop_reason: reason });
  void title; // title evidence already feeds `remote` via extractFields
  switch (g.country) {
    case 'CO':
      if (g.metro === 'medellin') return keep('colombia-medellin');
      if (g.metro === 'bogota') return keep('colombia-bogota');
      if (remote === true) return keep('colombia-remote');
      if (remote === null && g.countryLevel) return keep('colombia-remote');
      return drop('co-other-city-onsite');
    case 'ES':
      if (g.metro === 'madrid') return keep('spain-madrid');
      if (remote === true) return keep('spain-remote');
      return drop('es-other-city-onsite');
    case 'LATAM':
      return remote === true ? keep('latam-remote') : drop('latam-onsite');
    case 'US':
      if (!g.countryLevel && remote !== true) return drop('us-onsite');
      if (usOnly && !intl_ok) return drop('us-only');
      if (intl_ok) return keep('remote-intl');
      return keep('us-remote-unstated');
    default:
      return remote === true && intl_ok ? keep('remote-other-intl') : drop('other-country');
  }
}

// ───────────────────────────── dates ─────────────────────────────
const isoDate = (d) => d.toISOString().slice(0, 10);
// "3 days ago" / "23 hours ago" / "hace 2 semanas" / "Posted 30+ Days Ago" / "yesterday" → YYYY-MM-DD, else null.
export function parseRelativeDate(str, nowISO) {
  const s = deaccent(String(str ?? '')).toLowerCase().replace(/\s+/g, ' ').trim();
  const now = nowISO ? new Date(nowISO) : new Date();
  if (!s || Number.isNaN(now.getTime())) return null;
  if (/\b(just now|today|hoy|ahora|moments? ago|hace un momento|hace unos (?:minutos|instantes|segundos)|recien|recently)\b/.test(s)) return isoDate(now);
  if (/\b(yesterday|ayer)\b/.test(s)) return isoDate(new Date(now.getTime() - 86400000));
  const m = s.match(/(\d+|an?|una?)\s*\+?\s*(minute|min|hour|hr|day|week|wk|month|year|minuto|hora|dia|semana|mes|ano)(?:e?s)?\b/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
    const unit = m[2];
    const ms = /^(minute|min|minuto)$/.test(unit) ? 60000 : /^(hour|hr|hora)$/.test(unit) ? 3600000 : /^(day|dia)$/.test(unit) ? 86400000
      : /^(week|wk|semana)$/.test(unit) ? 7 * 86400000 : /^(month|mes)$/.test(unit) ? 30 * 86400000 : 365 * 86400000;
    return isoDate(new Date(now.getTime() - n * ms));
  }
  const abs = String(str ?? '').match(/\d{4}-\d{2}-\d{2}/);
  if (abs) return abs[0];
  if (/\b(19|20)\d{2}\b/.test(s)) { const t = Date.parse(String(str)); if (!Number.isNaN(t)) return isoDate(new Date(t)); }
  return null;
}

// ───────────────────────────── self-test ─────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('classify.mjs') && process.argv.includes('--self-test')) {
  let pass = 0; let fail = 0;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const check = (name, got, want) => { if (eq(got, want)) pass++; else { fail++; console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); } };
  const run = (location, title, text) => { const f = extractFields({ title, location, text }); return { f, l: assignLane({ location, title, ...f }) }; };

  // 1. IEM-style: US country-level, "US Remote Compensation Range" + 401(k) → us-only
  let r = run('United States', 'Supply Planning Manager', 'Join IEM. This role is Remote. US Remote Compensation Range: $100,000 - $120,000 per year. Benefits include medical, dental and 401(k) with company match. 5+ years of supply planning experience.');
  check('1 IEM lane', r.l, { lane: null, drop_reason: 'us-only' });
  check('1 IEM remote/intl', [r.f.remote, r.f.intl_ok], [true, false]);
  check('1 IEM signals', r.f.us_only_signals.length >= 2 && r.f.us_only_signals.some((s) => /^US Remote Compensation Range/.test(s)) && r.f.us_only_signals.includes('401(k)'), true);
  check('1 IEM salary/years', [r.f.salary, r.f.years_required], ['$100,000 - $120,000 per year', 5]);
  // 2. Mexico City on-site → latam-onsite
  r = run('Mexico City, Mexico', 'Demand Planning Manager', 'This is an on-site role at our Mexico City headquarters, Monday to Friday.');
  check('2 Mexico City on-site', [r.f.remote, r.l.drop_reason], [false, 'latam-onsite']);
  // 3. Mexico + "100% remoto para toda LATAM" → latam-remote + intl_ok
  r = run('Mexico', 'Gerente de Planeación de Demanda', 'Posición 100% remota para toda LATAM. Contrato indefinido. Salario: USD 3,000 - 4,000 mensuales.');
  check('3 Mexico remoto LATAM', [r.f.remote, r.f.intl_ok, r.l.lane], [true, true, 'latam-remote']);
  // 4. Bogotá on-site → colombia-bogota
  r = run('Bogota, D.C., Capital District, Colombia', 'Jefe de Planeación', 'Modalidad presencial en nuestras oficinas de Bogotá.');
  check('4 Bogotá on-site', [r.f.remote, r.l.lane], [false, 'colombia-bogota']);
  // 5. Country-level Colombia + no evidence → colombia-remote with remote=null
  r = run('Colombia', 'Supply Chain Planning Manager', 'We are hiring a planning manager to lead S&OP for the Andean region.');
  check('5 Colombia country-level null', [r.f.remote, r.l.lane], [null, 'colombia-remote']);
  // 6. Getafe on-site → spain-madrid
  r = run('Getafe, Community of Madrid, Spain', 'Demand Planner', 'Puesto presencial en planta de Getafe.');
  check('6 Getafe on-site', [r.f.remote, r.l.lane], [false, 'spain-madrid']);
  // 7. Barcelona hybrid → es-other-city-onsite
  r = run('Barcelona, Catalonia, Spain', 'SAP IBP Planning Consultant', 'Modelo híbrido: 3 días en oficina. Hybrid working.');
  check('7 Barcelona hybrid', [r.f.remote, r.l.drop_reason], [false, 'es-other-city-onsite']);
  // 8. NZ remote without intl → other-country
  r = run('Auckland, New Zealand', 'Head of Planning', 'This is a fully remote role. You must be based in New Zealand.');
  check('8 NZ remote no intl', [r.f.remote, r.f.intl_ok, r.l.drop_reason], [true, false, 'other-country']);
  // 9. US city + "This position is remote" + 401(k) → us-only
  r = run('Providence, RI', 'Demand Planner-Forecaster - Remote', 'This position is remote. We offer a 401k plan and health insurance.');
  check('9 US city remote 401k', [r.f.remote, r.l.drop_reason], [true, 'us-only']);
  // 10. "not a remote position" negation → remote=false → US city → us-onsite
  r = run('Dallas, TX', 'Supply Planning Manager', 'Please note this is not a remote position. Candidates must commute to Dallas.');
  check('10 negated remote', [r.f.remote, r.l.drop_reason], [false, 'us-onsite']);
  // 11. maternity cover flag
  r = run('Madrid, Community of Madrid, Spain', 'Demand Planning Manager (maternity cover)', 'Fixed-term contract covering a maternity leave of 12 months.');
  check('11 maternity cover flags', r.f.contract_flags, ['fixed-term', 'maternity', 'cover']);
  // 12. salary + years EN
  r = run('United States', 'Director of Planning', 'Salary range: $120,000 – $140,000 per year, plus bonus. Requires a minimum of 7+ years of experience in demand planning.');
  check('12 salary/years EN', [r.f.salary, r.f.years_required], ['$120,000 – $140,000 per year', 7]);
  // 13. salary + years ES
  r = run('Medellín, Antioquia, Colombia', 'Director de Planeación', 'Salario: $9.000.000 a $10.000.000 COP mensuales. Mínimo 5 años de experiencia liderando equipos de planeación.');
  check('13 salary/years ES', [r.f.salary, r.f.years_required, r.l.lane], ['$9.000.000 a $10.000.000 COP mensuales', 5, 'colombia-medellin']);
  // 14. Envigado → colombia-medellin regardless of remote; Cali → remote required
  check('14a Envigado', assignLane({ location: 'Envigado, Antioquia, Colombia', remote: false, intl_ok: false, us_only_signals: [] }).lane, 'colombia-medellin');
  check('14b Cali null', assignLane({ location: 'Cali, Valle del Cauca, Colombia', remote: null, intl_ok: false, us_only_signals: [] }).drop_reason, 'co-other-city-onsite');
  check('14c Cali remote', assignLane({ location: 'Cali, Valle del Cauca, Colombia', remote: true, intl_ok: false, us_only_signals: [] }).lane, 'colombia-remote');
  // 15. US country-level + intl_ok → remote-intl even with us_only signals; silent → us-remote-unstated
  r = run('United States', 'Supply Planning Manager', 'We hire independent contractors across LATAM. US employees receive 401(k).');
  check('15a US intl', [r.f.intl_ok, r.l.lane], [true, 'remote-intl']);
  r = run('United States', 'Supply Planning Manager', 'Lead the S&OP cycle for our CPG portfolio.');
  check('15b US silent', r.l.lane, 'us-remote-unstated');
  // 16. Madrid, Cundinamarca → colombia-bogota (not Spain); Greater Madrid Metropolitan Area → spain-madrid
  check('16a Madrid Cundinamarca', assignLane({ location: 'Madrid, Cundinamarca, Colombia', remote: null, intl_ok: false, us_only_signals: [] }).lane, 'colombia-bogota');
  check('16b Greater Madrid', assignLane({ location: 'Greater Madrid Metropolitan Area', remote: null, intl_ok: false, us_only_signals: [] }).lane, 'spain-madrid');
  // 17. "Latin America" tag
  check('17a LATAM tag remote', assignLane({ location: 'Latin America', remote: true, intl_ok: true, us_only_signals: [] }).lane, 'latam-remote');
  check('17b LATAM tag null', assignLane({ location: 'Latin America', remote: null, intl_ok: true, us_only_signals: [] }).drop_reason, 'latam-onsite');
  // 18. ≥3 US states → signal; "No visa sponsorship" alone → none
  r = run('United States', 'Planning Manager', 'This remote role is open to residents of California, Texas, New York and Florida only.');
  check('18a states list', [r.f.us_only_signals.length >= 1, r.l.drop_reason], [true, 'us-only']);
  r = run('United States', 'Planning Manager', 'Remote. No visa sponsorship is available for this position.');
  check('18b visa alone', [r.f.us_only_signals, r.l.lane], [[], 'us-remote-unstated']);
  // 19. negated intl
  r = run('United States', 'Planning Manager', 'Remote within the US. We are not open to international candidates at this time.');
  check('19 negated intl', r.f.intl_ok, false);
  // 20. Denver, CO is US (Colorado); Medellín, CO is Colombia; Bogotá, D.C., CO is Bogotá
  check('20a Denver CO', assignLane({ location: 'Denver, CO', remote: null, intl_ok: false, us_only_signals: [] }).drop_reason, 'us-onsite');
  check('20b Medellín CO', assignLane({ location: 'Medellín, CO', remote: null, intl_ok: false, us_only_signals: [] }).lane, 'colombia-medellin');
  check('20c Bogotá CO', assignLane({ location: 'Bogotá, D.C., CO', remote: false, intl_ok: false, us_only_signals: [] }).lane, 'colombia-bogota');
  // 21. Spain country-level
  check('21a Spain remote', assignLane({ location: 'Spain', remote: true, intl_ok: false, us_only_signals: [] }).lane, 'spain-remote');
  check('21b Spain null', assignLane({ location: 'Spain', remote: null, intl_ok: false, us_only_signals: [] }).drop_reason, 'es-other-city-onsite');
  // 22. hybrid mentioned but fully remote stated → remote=true
  r = run('Spain', 'Planning Manager', 'We are a fully remote team; a hybrid desk in Madrid is available if you prefer.');
  check('22 hybrid + fully remote', [r.f.remote, r.l.lane], [true, 'spain-remote']);
  // 23. HireLatam-style Colombia country-level: WFH + contractor → colombia-remote, intl_ok, salary
  r = run('Colombia', 'Remote Operations & Supply Chain Manager', 'Independent contractor roles in US companies. (100% Work From Home) Location: Remote from Latin America. Salary : $2,000 USD/month ($13.00 USD/hour).');
  check('23 HireLatam', [r.f.remote, r.f.intl_ok, r.l.lane, r.f.salary], [true, true, 'colombia-remote', '$2,000 USD/month']);
  // 24. parseRelativeDate
  const NOW = '2026-10-13T15:00:00Z';
  check('24a days ago', parseRelativeDate('3 days ago', NOW), '2026-10-10');
  check('24b hours ago', parseRelativeDate('23 hours ago', NOW), '2026-10-12');
  check('24c hace semanas', parseRelativeDate('hace 2 semanas', NOW), '2026-09-29');
  check('24d reposted week', parseRelativeDate('Reposted 1 week ago', NOW), '2026-10-06');
  check('24e workday', parseRelativeDate('Posted 30+ Days Ago', NOW), '2026-09-13');
  check('24f today / garbage', [parseRelativeDate('Posted Today', NOW), parseRelativeDate('n/a', NOW)], ['2026-10-13', null]);
  // 25. cleanText on Greenhouse-escaped HTML and ordinary HTML
  check('25a greenhouse escaped', cleanText('&lt;div class=&quot;x&quot;&gt;&lt;p&gt;We&amp;#39;re hiring&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Remote&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;'), "We're hiring\n• Remote");
  check('25b html', cleanText('<p>Hello&nbsp;<strong>world</strong></p><script>x()</script><br>Bye &amp; thanks'), 'Hello world\nBye & thanks');
  // 26. multi-country lists
  check('26a USA+LATAM list', assignLane({ location: 'USA, Canada, Argentina, Mexico, Peru', remote: true, intl_ok: false, us_only_signals: [] }).lane, 'latam-remote');
  check('26b worldwide', assignLane({ location: 'Worldwide', remote: true, intl_ok: true, us_only_signals: [] }).lane, 'remote-other-intl');
  check('26c remote unknown no intl', assignLane({ location: 'Remote', remote: true, intl_ok: false, us_only_signals: [] }).drop_reason, 'other-country');
  check('26d US - Remote', assignLane({ location: 'US - Remote', remote: true, intl_ok: false, us_only_signals: [] }).lane, 'us-remote-unstated');
  check('26e California, United States + remote', assignLane({ location: 'California, United States', remote: true, intl_ok: false, us_only_signals: [] }).lane, 'us-remote-unstated');
  check('26f California, United States null', assignLane({ location: 'California, United States', remote: null, intl_ok: false, us_only_signals: [] }).drop_reason, 'us-onsite');
  // 27. location-alone qualification
  check('27 qualifies alone', ['Medellín, Antioquia, Colombia', 'Colombia', 'Madrid, Community of Madrid, Spain', 'Cali, Colombia', 'United States', 'Mexico'].map(locationQualifiesAlone), [true, true, true, false, false, false]);
  // 28. excerpt strips boilerplate and caps length
  check('28 excerpt', excerpt('Show more\nAbout the job\nLead S&OP.\nWe are an equal opportunity employer.\n' + 'x'.repeat(800), 100).length <= 100, true);
  // 29. maternity as a benefit is not a flag; "cover letter" is not a flag
  r = run('Madrid, Community of Madrid, Spain', 'Planning Manager', 'Benefits: 16 weeks paid maternity leave. Please send a cover letter.');
  check('29 maternity benefit', r.f.contract_flags, []);

  console.log(`classify self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
