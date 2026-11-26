/* CPRS4CC import/normalization engine.
 * Every imported item is normalized to an HL7 FHIR R4 (US Core-aligned) resource.
 * Each resource carries one or more source-reference extensions (file, pages/locator, format).
 * Works in the browser and in Node (inject DOMParser / pdfjs / JSZip via Engine.deps). */
(function (root) {
'use strict';

const EXT_SRC = 'https://cprs4cc.example.org/fhir/StructureDefinition/source-reference';
const EXT_PRINTED = 'https://cprs4cc.example.org/fhir/StructureDefinition/printed-value';   // the number exactly as printed in the source ("6.0", "1.020", "<0.10")
const CS_LOCAL = 'https://cprs4cc.example.org/fhir/CodeSystem/cprs4cc';
const LOINC = 'http://loinc.org', SCT = 'http://snomed.info/sct', RXN = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const UCUM = 'http://unitsofmeasure.org';
const V3INT = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation';
const OBSCAT = 'http://terminology.hl7.org/CodeSystem/observation-category';
const CNS = 'urn:hl7-org:v3', XSI = 'http://www.w3.org/2001/XMLSchema-instance';

const deps = { DOMParser: root.DOMParser, pdfjs: root.pdfjsLib, JSZip: root.JSZip, subtle: root.crypto && root.crypto.subtle };

/* ---------------- small utilities ---------------- */
const uid = () => (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
const clone = o => JSON.parse(JSON.stringify(o));
const stripAccents = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = s => stripAccents(s).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const pad = n => String(n).padStart(2, '0');
function utf8ToB64(s) {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
  const b = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin);
}
function b64ToUtf8(b) {
  if (typeof Buffer !== 'undefined') return Buffer.from(b, 'base64').toString('utf8');
  const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u);
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
async function sha256(buf) {
  try { if (!deps.subtle) return null; const d = await deps.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join(''); } catch (e) { return null; }
}
const HTML_ENT = { nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', deg: '°', plusmn: '±', micro: 'µ', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', le: '≤', ge: '≥', ne: '≠', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', Eacute: 'É', Ntilde: 'Ñ' };
function decodeEntities(s) {
  return String(s).replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,8}));/g, (m, d, x, n) => {
    if (n) return Object.prototype.hasOwnProperty.call(HTML_ENT, n) ? HTML_ENT[n] : m;
    const cp = d ? +d : parseInt(x, 16); if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return ' ';
    return cp === 160 ? ' ' : String.fromCodePoint(cp);
  });
}
/* HTML -> text with the layout the line parsers expect: one line per block/row, two spaces between table cells. */
function htmlToText(h) {
  const NL = '\u0001', CELL = '\u0002';
  let s = String(h).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|head|noscript|template|svg|object)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (m, b) => NL + b.replace(/<[^>]+>/g, '').replace(/\r?\n/g, NL) + NL);
  s = s.replace(/<(br|hr)\b[^>]*>/gi, NL).replace(/<li\b[^>]*>/gi, NL + '- ').replace(/<\/(p|div|tr|li|h[1-6]|ul|ol|table|section|article|header|footer|blockquote|dd|dt|dl|caption|fieldset|form)\s*>/gi, NL)
       .replace(/<(p|div|tr|h[1-6]|ul|ol|table|section|article|blockquote|dl|caption)\b[^>]*>/gi, NL).replace(/<\/t[dh]\s*>/gi, CELL).replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/[ \t\r\n\f\v ]+/g, ' ');
  return s.replace(new RegExp(' ?' + NL + ' ?', 'g'), '\n').replace(new RegExp(' ?' + CELL + ' ?', 'g'), '  ').replace(/[ ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\n[ ]+(?=\S)/g, '\n').trim();
}
/* RTF (Epic "text/rtf" note bodies) -> plain text */
function rtfToText(r) {
  let s = String(r).replace(/\{\\\*[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '').replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|header|footer)\b(?:[^{}]|\{[^{}]*\})*\}/g, '');
  s = s.replace(/\\par[d]?\b ?/g, '\n').replace(/\\(?:line|row)\b ?/g, '\n').replace(/\\tab\b ?/g, '\t').replace(/\\'([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
       .replace(/\\u(-?\d+)\??/g, (m, n) => String.fromCharCode(n < 0 ? +n + 65536 : +n)).replace(/\\[a-zA-Z]+-?\d* ?/g, '').replace(/\\([{}\\])/g, '$1').replace(/[{}]/g, '');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------------- date handling ---------------- */
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function tzOffset(y, mo, d, h, mi) {
  const off = -new Date(y, mo - 1, d, h, mi).getTimezoneOffset();
  const s = off >= 0 ? '+' : '-', a = Math.abs(off); return s + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
}
/* Build a FHIR date/dateTime. Times without a stated zone are given the viewer's local offset (FHIR requires a zone when a time is present). */
function fhirDT(y, mo, d, h, mi, s, tz) {
  if (!y) return null;
  if (y < 100) y += y > 50 ? 1900 : 2000;
  if (mo == null) return String(y);
  if (d == null) return y + '-' + pad(mo);
  const date = y + '-' + pad(mo) + '-' + pad(d);
  if (h == null) return date;
  return date + 'T' + pad(h) + ':' + pad(mi || 0) + ':' + pad(s || 0) + (tz || tzOffset(y, mo, d, h, mi || 0));
}
const DATE_RES = [
  // 09/14/2026 08:12 ; 9/14/26@0812 ; 10/02/2026 10:15 AM
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:\s*[@ T]\s*(\d{1,2}):?(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?\b/i, f: m => [+m[3], +m[1], +m[2], m[4], m[5], m[6], m[7]] },
  // SEP 14, 2026@08:55 ; Jul 21, 2026 7:32 AM ; Sep 14 2026
  { re: /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s*[@ ,]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i, f: m => [+m[3], MON[m[1].toUpperCase()], +m[2], m[4], m[5], m[6], m[7]] },
  // 14 Sep 2026 [08:55]
  { re: /\b(\d{1,2})[ -](JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*[ -](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i, f: m => [+m[3], MON[m[2].toUpperCase()], +m[1], m[4], m[5], m[6], m[7]] },
  // ISO 2026-09-14[T08:12[:00][Z|+hh:mm]]
  { re: /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/, f: m => [+m[1], +m[2], +m[3], m[4], m[5], m[6], null, m[7]] },
];
function findDate(text) {
  if (!text) return null;
  let best = null;
  for (const { re, f } of DATE_RES) {
    const m = String(text).match(re); if (!m) continue;
    if (best && best.index <= m.index) continue;
    let [y, mo, d, h, mi, s, ap, tz] = f(m);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    h = h != null ? +h : null; mi = mi != null ? +mi : null; s = s != null ? +s : null;
    if (h != null && ap) { ap = ap.toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; }
    if (h != null && h > 23) h = null;
    if (tz === 'Z') tz = '+00:00'; else if (tz && tz.length === 5) tz = tz.slice(0, 3) + ':' + tz.slice(3);
    best = { iso: fhirDT(y, mo, d, h, mi, s, tz), index: m.index, raw: m[0] };
  }
  return best;
}
const parseDT = t => { const r = findDate(t); return r ? r.iso : null; };
/* HL7 v2 / CDA TS: YYYY[MM[DD[HH[MM[SS[.S]]]]]][+/-ZZZZ] */
function tsToFhir(v) {
  if (!v) return null; const m = String(v).match(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.\d+)?([+-]\d{4})?/); if (!m) return null;
  const tz = m[7] ? m[7].slice(0, 3) + ':' + m[7].slice(3) : null;
  return fhirDT(+m[1], m[2] ? +m[2] : null, m[3] ? +m[3] : null, m[4] != null ? +m[4] : null, m[5] != null ? +m[5] : 0, m[6] != null ? +m[6] : 0, tz);
}
const minuteKey = dt => dt ? String(dt).slice(0, 16) : '';
const dayKey = dt => dt ? String(dt).slice(0, 10) : '';

/* ---------------- terminology helpers ---------------- */
const UCUM_MAP = { 'mmol/l': 'mmol/L', 'meq/l': 'meq/L', 'mg/dl': 'mg/dL', 'g/dl': 'g/dL', '%': '%', 'fl': 'fL', 'pg': 'pg', 'u/l': 'U/L', 'iu/l': '[IU]/L', 'mg/g': 'mg/g', 'mg/l': 'mg/L', 'ng/ml': 'ng/mL', 'ng/dl': 'ng/dL', 'pg/ml': 'pg/mL', 'ug/dl': 'ug/dL',
  'k/cmm': '10*3/uL', 'k/ul': '10*3/uL', 'x10e3/ul': '10*3/uL', '10*3/ul': '10*3/uL', 'thou/ul': '10*3/uL', 'm/cmm': '10*6/uL', 'm/ul': '10*6/uL', 'x10e6/ul': '10*6/uL', '10*6/ul': '10*6/uL',
  'uiu/ml': 'u[IU]/mL', 'miu/l': 'm[IU]/L', 'miu/ml': 'm[IU]/mL', 'sec': 's', 's': 's', '/min': '/min', 'bpm': '/min', 'beats/min': '/min', 'breaths/min': '/min', 'mmhg': 'mm[Hg]', 'mm[hg]': 'mm[Hg]', 'kg': 'kg', 'g': 'g', 'lb': '[lb_av]', 'lbs': '[lb_av]', '[lb_av]': '[lb_av]',
  'in': '[in_i]', '[in_i]': '[in_i]', 'cm': 'cm', 'f': '[degF]', '°f': '[degF]', '[degf]': '[degF]', 'c': 'Cel', '°c': 'Cel', 'cel': 'Cel', 'kg/m2': 'kg/m2', 'kg/m^2': 'kg/m2', 'ml/min/1.73m2': 'mL/min/{1.73_m2}', '{score}': '{score}', 'mg': 'mg' };
function qty(value, unit) {
  const q = { value: Number(value) };
  if (typeof value === 'string') { const pr = value.trim().replace(/^\+/, ''); if (pr && Number.isFinite(q.value) && String(q.value) !== pr) q.extension = [{ url: EXT_PRINTED, valueString: pr }]; }   // keep "6.0" / "1.020" as printed
  if (unit) { q.unit = unit; const u = UCUM_MAP[String(unit).toLowerCase()]; if (u) { q.system = UCUM; q.code = u; } }
  return q;
}
/* Lab name -> LOINC. The catalog (catalog.txt, ~200 common results incl. serum tumor markers) is injected at build time.
   Mapping is by printed name and specimen; the printed name is always kept in code.text and the added coding is userSelected:false. */
const LAB_CATALOG_TXT = `/*CATALOG*/`;
const NN = s => stripAccents(s).toUpperCase().replace(/%/g, ' PCT ').replace(/#/g, ' ABS ').replace(/[^A-Z0-9]+/g, ' ').replace(/\bANTIGEN\b/g, 'AG').replace(/\b(ANTIBODY|ANTIBODIES)\b/g, 'AB').replace(/\s+/g, ' ').trim();
const LAB_CAT = []; const LAB_ALIAS = new Map();
let CAT_TXT = LAB_CATALOG_TXT;
if (/^\/\*CATALOG/.test(CAT_TXT) && typeof require === 'function') { try { CAT_TXT = require('fs').readFileSync(require('path').join(__dirname, 'catalog.txt'), 'utf8'); } catch (e) { } }
let CUR_GROUP = '';
for (const ln of CAT_TXT.split('\n')) {
  if (/^##\s*/.test(ln)) { CUR_GROUP = ln.replace(/^##\s*/, '').trim(); continue; }
  if (!ln.trim() || /^#/.test(ln)) continue; const [code, display, aliases, spec] = ln.split('|');
  const e = { code, display, spec: (spec || 'S').trim(), aliases: aliases.split(';').filter(Boolean), group: CUR_GROUP }; LAB_CAT.push(e);
  for (const a of aliases.split(';')) { const k = NN(a); if (!k) continue; const l = LAB_ALIAS.get(k) || []; if (!l.includes(e)) l.push(e); LAB_ALIAS.set(k, l); }
}
const SPEC_WORDS = /\b(SERUM|SER|PLASMA|PLAS|BLOOD|BLD|WHOLE|WB|LEVEL|LVL|QUANT|QUANTITATIVE|QUANTITATION|RANDOM|URINE|UR|URN|UA|ARTERIAL|ART|VENOUS|VEN|POC|S P|SP)\b/g;
function specCat(spec, name) {
  const s = (String(spec || '') + ' ' + String(name || '')).toUpperCase();
  if (/\bURINE|\bUR\b|\bURN\b|\bUA\b|URINALYSIS|\b24\s*H(OU)?R\b/.test(s)) return 'U';
  if (/ARTERIAL|\bABG\b|\bART\b/.test(s)) return 'A';
  if (/VENOUS|\bVBG\b/.test(s)) return 'V';
  return null;
}
function lookupLab(name, specimen, numeric) {
  const cat = specCat(specimen, name); const full = NN(name);
  const keys = [full, full.replace(SPEC_WORDS, ' ').replace(/\s+/g, ' ').trim(), full.replace(/\s+(TOTAL|CALC|CALCULATED)$/, '')];
  for (const k of keys) {
    const c = k && LAB_ALIAS.get(k); if (!c) continue; let pick = null;
    const by = sp => c.find(e => e.spec === sp);
    if (cat === 'U') pick = numeric ? (by('U') || by('Q')) : (by('Q') || by('U'));
    else if (cat === 'A' || cat === 'V') pick = by(cat);
    else { pick = by('S') || by('B'); if (!pick && new Set(c.map(e => e.spec)).size === 1 && !['A', 'V'].includes(c[0].spec)) pick = c[0]; }
    if (pick) return pick;
  }
  return null;
}
function labCode(name, specimen, numeric) {
  const e = lookupLab(name, specimen, numeric !== false);
  return e ? { coding: [{ system: LOINC, code: e.code, display: e.display, userSelected: false }], text: name } : { text: name };
}
const VITAL = {
  bp: ['85354-9', 'Blood pressure panel with all children optional', null], hr: ['8867-4', 'Heart rate', '/min'], rr: ['9279-1', 'Respiratory rate', '/min'],
  temp: ['8310-5', 'Body temperature', null], spo2: ['59408-5', 'Oxygen saturation in Arterial blood by Pulse oximetry', '%'], wt: ['29463-7', 'Body weight', null],
  ht: ['8302-2', 'Body height', null], bmi: ['39156-5', 'Body mass index (BMI) [Ratio]', 'kg/m2'], pain: ['72514-3', 'Pain severity - 0-10 verbal numeric rating [Score] - Reported', null],
};
const VITAL_LOINCS = new Set(['85354-9', '55284-4', '8867-4', '9279-1', '8310-5', '59408-5', '2708-6', '29463-7', '8302-2', '39156-5', '72514-3', '8480-6', '8462-4', '8287-5', '9843-4', '3141-9']);
function flagCode(f) {
  if (!f) return null; const s = String(f).trim().toUpperCase().replace(/\s+/g, ' ');
  const map = { H: 'H', HIGH: 'H', L: 'L', LOW: 'L', HH: 'HH', 'H*': 'HH', 'CRITICAL HIGH': 'HH', LL: 'LL', 'L*': 'LL', 'CRITICAL LOW': 'LL', A: 'A', ABNORMAL: 'A', '*': 'A', AA: 'AA', CRITICAL: 'AA', PANIC: 'AA', N: 'N', NORMAL: 'N' };
  const c = map[s]; if (!c) return { text: f };
  const disp = { H: 'High', L: 'Low', HH: 'Critical high', LL: 'Critical low', A: 'Abnormal', AA: 'Critical abnormal', N: 'Normal' }[c];
  return { coding: [{ system: V3INT, code: c, display: disp }], text: f };
}
/* Reference range text -> {low, high, text}. Accepts "3.5 - 5.1", "3.5-5.1 mmol/L", "(3.5-5.1)", "<200", ">= 40", "Normal: 70-99", "3.5 to 5.1". */
const RANGE_CORE = /^(?:(?:ref(?:erence)?\.?\s*(?:range|interval)?|normal(?:\s*range)?|range|nl)\s*[:=]?\s*)?\(?\[?\s*((?:[<>]=?|≤|≥)\s*-?\d+(?:\.\d+)?|-?\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*-?\d+(?:\.\d+)?)\s*\]?\)?\s*([A-Za-z%\/^0-9.*\[\]{}µ]+(?:\/[A-Za-z0-9.\[\]]+)?)?\s*$/i;
function parseRange(r, unit) {
  if (!r) return null; const t = String(r).trim(); const out = { text: t };
  const mm = t.match(RANGE_CORE); const core = mm ? mm[1].replace(/≤/, '<=').replace(/≥/, '>=') : t;
  const u = unit || (mm && mm[2] && /[A-Za-z%]/.test(mm[2]) ? mm[2] : undefined);
  let m;
  if ((m = core.match(/^(-?\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(-?\d+(?:\.\d+)?)/))) { out.low = qty(m[1], u); out.high = qty(m[2], u); }
  else if ((m = core.match(/^<=?\s*(-?\d+(?:\.\d+)?)/))) out.high = qty(m[1], u);
  else if ((m = core.match(/^>=?\s*(-?\d+(?:\.\d+)?)/))) out.low = qty(m[1], u);
  return out;
}
const isRange = c => RANGE_CORE.test(String(c).trim()) && /\d/.test(c);
const rangeUnit = c => { const m = String(c).trim().match(RANGE_CORE); return m && m[2] && /[A-Za-z%]/.test(m[2]) ? m[2] : ''; };
const FLAG_RE = /^(HH|LL|H\*?|L\*?|A|AA|\*|N|High|Low|Abnormal|Normal|Critical(?: High| Low)?|Panic)$/i;

/* ---- observation values: one place that knows every value[x] shape ---- */
const printedNum = q => { const e = q && (q.extension || []).find(x => x.url === EXT_PRINTED); return e ? e.valueString : (q && q.value != null ? String(q.value) : ''); };
const qText = q => q ? (q.comparator || '') + printedNum(q) : '';
const SYS_DIA = { '8480-6': 0, '8462-4': 1 };
function orderedComponents(r) {
  const comps = (r.component || []).slice(); const rank = c => { const k = ((c.code && c.code.coding) || []).map(x => SYS_DIA[x.code]).find(x => x != null); return k == null ? 9 : k; };
  return comps.some(c => rank(c) < 9) ? comps.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]) : comps;   // systolic before diastolic whatever the file's order
}
function obsValue(r) {
  if (r.valueQuantity) return { value: qText(r.valueQuantity), unit: r.valueQuantity.unit || '' };
  if (r.valueCodeableConcept) return { value: codeText(r.valueCodeableConcept), unit: '' };
  if (r.valueString != null) return { value: String(r.valueString), unit: '' };
  if (r.valueInteger != null) return { value: String(r.valueInteger), unit: '' };
  if (r.valueBoolean != null) return { value: String(r.valueBoolean), unit: '' };
  if (r.valueRatio) { const n = r.valueRatio.numerator || {}, d = r.valueRatio.denominator || {}; const nu = n.unit && n.unit !== d.unit ? ' ' + n.unit : ''; return { value: qText(n) + nu + ':' + qText(d), unit: '' }; }
  if (r.valueRange) { const lo = qText(r.valueRange.low), hi = qText(r.valueRange.high); return { value: lo && hi ? lo + '-' + hi : hi ? '<=' + hi : lo ? '>=' + lo : '', unit: (r.valueRange.low || r.valueRange.high || {}).unit || '' }; }
  if (r.valueDateTime != null || r.valueTime != null) return { value: String(r.valueDateTime != null ? r.valueDateTime : r.valueTime), unit: '' };
  if (r.valuePeriod) return { value: [r.valuePeriod.start, r.valuePeriod.end].filter(Boolean).join(' – '), unit: '' };
  if (r.valueSampledData) return { value: '[sampled data, ' + (r.valueSampledData.dimensions || 1) + ' channel(s)]', unit: '' };
  if (r.component && r.component.length) { const cs = orderedComponents(r); return { value: cs.map(c => c.valueQuantity ? qText(c.valueQuantity) : c.valueCodeableConcept ? codeText(c.valueCodeableConcept) : c.valueString != null ? String(c.valueString) : c.valueInteger != null ? String(c.valueInteger) : '').join('/'), unit: (cs[0].valueQuantity || {}).unit || '' }; }
  if (r.dataAbsentReason) return { value: codeText(r.dataAbsentReason), unit: '' };
  return { value: '', unit: '' };
}
const obsDate = r => r.effectiveDateTime || r.effectiveInstant || (r.effectivePeriod || {}).start || ((r.effectiveTiming || {}).event || [])[0] || r.issued || '';
const HUMAN_USE_RANK = { official: 0, usual: 1, temp: 3, maiden: 4, old: 5, nickname: 6, anonymous: 7 };
/* Patient names: official/usual first; fill family/given from a text-only name */
function orderedNames(names) {
  const list = (names || []).filter(Boolean).map(n => { const o = Object.assign({}, n); if (!o.family && o.text) { const pn = parseNameValue(o.text); if (pn) { o.family = pn.family; if (!(o.given || []).length) o.given = pn.given; } } return o; });
  return list.map((n, i) => [n, i]).sort((a, b) => ((a[0].family ? 0 : 10) + (HUMAN_USE_RANK[a[0].use] != null ? HUMAN_USE_RANK[a[0].use] : 2)) - ((b[0].family ? 0 : 10) + (HUMAN_USE_RANK[b[0].use] != null ? HUMAN_USE_RANK[b[0].use] : 2)) || a[1] - b[1]).map(x => x[0]);
}

/* ---------------- the store ---------------- */
const M = new WeakMap();            // resource -> {patientKey, fileIds:Set, kind, dkey}
const state = { patients: [], resources: [], files: [], byKey: new Map() };
const PATIENT_REFS = new Map();     // FHIR Patient reference ("Patient/123", urn:uuid, fullUrl) -> patient key; lets Observation.ndjson find the patients of Patient.ndjson
const meta = r => M.get(r) || {};

function srcExt(file, loc) {
  const ex = [{ url: 'file', valueString: file.name }];
  if (loc.pages) ex.push({ url: 'pages', valueString: String(loc.pages) });
  if (loc.locator) ex.push({ url: 'locator', valueString: loc.locator });
  ex.push({ url: 'format', valueCode: file.format });
  if (loc.system || file.system) ex.push({ url: 'system', valueString: loc.system || file.system });
  if (loc.originalId) ex.push({ url: 'originalId', valueString: loc.originalId });
  if (loc.method || file.method) ex.push({ url: 'method', valueCode: loc.method || file.method });
  ex.push({ url: 'importedAt', valueDateTime: file.importedAt });
  return { url: EXT_SRC, extension: ex };
}
function sources(r) {
  return (r.extension || []).filter(e => e.url === EXT_SRC).map(e => { const o = {}; for (const x of e.extension) o[x.url] = x.valueString || x.valueCode || x.valueDateTime; return o; });
}
function pagesStr(set) {
  const a = [...set].filter(x => x != null).map(Number).sort((x, y) => x - y); if (!a.length) return null;
  const out = []; let s = a[0], p = a[0];
  for (const n of a.slice(1).concat([null])) { if (n === p + 1 || n === p) { p = n; continue; } out.push(s === p ? String(s) : s + '-' + p); s = p = n; }
  return out.join(', ');
}

/* ---- patient identity ---- */
function patientKeyOf(p) {
  const n0 = orderedNames(p.name)[0] || {};
  const fam = norm(n0.family || '').replace(/[0-9]/g, '').replace(/\s+/g, '');
  const giv = norm((n0.given || [])[0] || '').replace(/[0-9]/g, '').replace(/\s+/g, '');
  return fam + '|' + (giv[0] || '') + '|' + (p.birthDate || '');
}
function upsertPatient(p, file, loc) {
  let key = patientKeyOf(p);
  let ex = state.patients.find(x => x.key === key);
  if (!ex && !p.birthDate) ex = state.patients.find(x => x.key.startsWith(key.split('|').slice(0, 2).join('|') + '|'));
  if (ex) {
    for (const id of p.identifier || []) if (!(ex.resource.identifier || []).some(i => i.value === id.value)) (ex.resource.identifier = ex.resource.identifier || []).push(id);
    if (!ex.resource.gender && p.gender) ex.resource.gender = p.gender;
    if (!ex.resource.birthDate && p.birthDate) ex.resource.birthDate = p.birthDate;
    if (!(ex.resource.address || []).length && p.address) ex.resource.address = p.address;
    ex.resource.extension.push(srcExt(file, loc));
    return ex.key;
  }
  const r = clone(p); r.resourceType = 'Patient'; r.id = uid(); delete r.meta; delete r.text; if (r.name) r.name = orderedNames(r.name);
  r.extension = (r.extension || []).filter(e => e.url !== EXT_SRC); r.extension.push(srcExt(file, loc));
  state.patients.push({ key, resource: r });
  return key;
}
function patientRef(key) { const p = state.patients.find(x => x.key === key); return p ? { reference: 'urn:uuid:' + p.resource.id } : undefined; }
function ensureUnknownPatient(file) {
  return upsertPatient({ name: [{ family: 'UNIDENTIFIED', given: ['PATIENT'], text: 'UNIDENTIFIED PATIENT' }] }, file, { locator: 'no patient identity found in file' });
}

/* ---- classification ---- */
/* ---- functional status: performance scales (ECOG, Karnofsky, Lansky, Palliative Performance Scale) ----
   Scores are normalized to a numeric valueQuantity (unit {score}) so they can be listed and trended like a vital sign. */
const ECOG_TXT = ['Fully active, able to carry on all pre-disease performance without restriction', 'Restricted in physically strenuous activity but ambulatory and able to do light or sedentary work', 'Ambulatory and capable of all self-care but unable to work; up and about more than 50% of waking hours', 'Capable of only limited self-care; confined to bed or chair more than 50% of waking hours', 'Completely disabled; cannot carry on any self-care; totally confined to bed or chair', 'Dead'];
const KPS_TXT = { 100: 'Normal; no complaints; no evidence of disease', 90: 'Able to carry on normal activity; minor signs or symptoms', 80: 'Normal activity with effort; some signs or symptoms', 70: 'Cares for self; unable to carry on normal activity or do active work', 60: 'Requires occasional assistance but able to care for most needs', 50: 'Requires considerable assistance and frequent medical care', 40: 'Disabled; requires special care and assistance', 30: 'Severely disabled; hospitalization indicated although death not imminent', 20: 'Very sick; hospitalization necessary; active supportive treatment', 10: 'Moribund; fatal processes progressing rapidly', 0: 'Dead' };
const LANSKY_TXT = { 100: 'Fully active, normal', 90: 'Minor restrictions in physically strenuous activity', 80: 'Active, but tires more quickly', 70: 'Greater restriction of, and less time spent in, play activities', 60: 'Up and around, but minimal active play; keeps busy with quieter activities', 50: 'Gets dressed but lies around much of the day; no active play; able to do quiet play and activities', 40: 'Mostly in bed; participates in quiet activities', 30: 'In bed; needs assistance even for quiet play', 20: 'Often sleeping; play entirely limited to very passive activities', 10: 'No play; does not get out of bed', 5: 'Unresponsive', 0: 'Dead' };
const FUNC_SCALES = {
  ecog: { name: 'ECOG performance status', short: 'ECOG', max: 5, step: 1, better: 'lower', who: 'adults', text: s => ECOG_TXT[s] },
  karnofsky: { name: 'Karnofsky performance status', short: 'Karnofsky', max: 100, step: 10, better: 'higher', who: 'adults', text: s => KPS_TXT[s] },
  lansky: { name: 'Lansky play-performance scale', short: 'Lansky', max: 100, step: 10, better: 'higher', who: 'children (0-16 y)', text: s => LANSKY_TXT[s] },
  pps: { name: 'Palliative performance scale', short: 'PPS', max: 100, step: 10, better: 'higher', who: 'palliative care', text: () => '' },
};
const ECOG_LA = { 'LA9622-7': 0, 'LA9623-5': 1, 'LA9624-3': 2, 'LA9625-0': 3, 'LA9626-8': 4, 'LA9627-6': 5 };
const FUNC_CODES = { '89247-1': 'ecog', '89243-0': 'karnofsky', 'C38144': 'lansky' };
const FUNC_NAME_RE = [['lansky', /\blansky\b/i], ['karnofsky', /\bkarnofsky\b|\bKPS\b/i], ['pps', /\bpalliative performance\b|\bPPS\b/i], ['ecog', /\bECOG\b|\bzubrod\b|\bWHO performance\b|\beastern cooperative\b/i]];
function funcScaleOf(r) {
  for (const c of (r.code && r.code.coding) || []) if (FUNC_CODES[c.code]) return FUNC_CODES[c.code];
  const t = codeText(r.code) + ' ' + ((r.code && r.code.coding) || []).map(c => c.display || '').join(' ');
  for (const [k, re] of FUNC_NAME_RE) if (re.test(t)) return k;
  return null;
}
function funcScore(r, scale) {                                  // numeric score from whatever value form the source used
  if (r.valueQuantity && r.valueQuantity.value != null && !isNaN(+r.valueQuantity.value)) return +r.valueQuantity.value;
  if (r.valueInteger != null) return +r.valueInteger;
  const cc = r.valueCodeableConcept;
  if (cc) { for (const c of cc.coding || []) if (ECOG_LA[c.code] != null) return ECOG_LA[c.code]; }
  const t = r.valueString != null ? String(r.valueString) : cc ? codeText(cc) : '';
  const m = t.match(/(?:^|[^\d.])(\d{1,3})(?:\s*%)?(?![\d.])/); if (m) return +m[1];
  if (scale === 'ecog' && t) { for (const [i, tx] of ECOG_TXT.entries()) if (t.toLowerCase().indexOf(tx.toLowerCase().slice(0, 18)) >= 0) return i; }
  return null;
}
function funcInfo(r) {                                          // {scale, score, meaning} for a recognized performance scale
  const scale = funcScaleOf(r); if (!scale) return null;
  const sc = FUNC_SCALES[scale]; const v = funcScore(r, scale);
  if (v == null || isNaN(v) || v < 0 || v > sc.max) return { scale, score: null, meaning: '' };
  return { scale, score: v, meaning: sc.text(v) || '' };
}
function normalizeFunc(r) {                                     // store the score as a quantity so it can be trended
  if (r.resourceType !== 'Observation') return;
  const fi = funcInfo(r); if (!fi || fi.score == null) return;
  if (r.valueQuantity && +r.valueQuantity.value === fi.score && !r.valueString && !r.valueInteger && !r.valueCodeableConcept) return;
  const orig = r.valueString != null ? String(r.valueString) : r.valueCodeableConcept ? codeText(r.valueCodeableConcept) : null;
  if (orig && orig.replace(/\D/g, '') !== String(fi.score) && !(r.note || []).some(n => n.text === 'Reported as: ' + orig)) (r.note = r.note || []).push({ text: 'Reported as: ' + orig });
  delete r.valueString; delete r.valueInteger; delete r.valueCodeableConcept; delete r.valueRange;
  r.valueQuantity = { value: fi.score, unit: 'score', system: UCUM, code: '{score}' };
}
const FUNC_CAT = 'functional-status';

function obsKind(r) {
  const cats = (r.category || []).flatMap(c => (c.coding || []).map(x => x.code));
  if (cats.includes(FUNC_CAT) || funcScaleOf(r)) return 'func';
  if (cats.includes('vital-signs')) return 'vital';
  if (cats.includes('laboratory')) return 'lab';
  if (cats.includes('social-history')) return 'social';
  if (cats.includes('survey')) return 'survey';
  const codes = (r.code && r.code.coding || []).map(c => c.code);
  if (codes.some(c => VITAL_LOINCS.has(c))) return 'vital';
  if (r.valueQuantity && r.referenceRange) return 'lab';
  return cats.length ? 'obs-other' : 'lab';
}
function codeText(cc) { if (!cc) return ''; return cc.text || ((cc.coding || []).find(c => c.display) || {}).display || ((cc.coding || [])[0] || {}).code || ''; }
function docText(r) {
  const out = [];
  for (const c of (r.content || []).map(c => c.attachment).concat(r.presentedForm || [])) {
    if (!c) continue; const ct = String(c.contentType || '').toLowerCase();
    if (c.data) {
      const kb = Math.max(1, Math.round(String(c.data).length * 0.75 / 1024));
      if (/pdf/.test(ct) || /^JVBERi0/.test(c.data)) out.push('[PDF document attached to this record (' + kb + ' KB). Its content is not displayed here; open the original PDF.]');
      else if (/^(image|video|audio)\//.test(ct) || /dicom|octet-stream|zip/.test(ct)) out.push('[' + (ct || 'binary') + ' attachment (' + kb + ' KB) is not displayed here.]');
      else { let t = ''; try { t = b64ToUtf8(c.data); } catch (e) { t = '[undecodable attachment]'; } out.push(/rtf/.test(ct) || /^\{\\rtf/.test(t) ? rtfToText(t) : /html|xml/.test(ct) ? htmlToText(t) : t); }
    }
    else if (c.url) out.push('[Document content is stored externally and was not included in the imported file: ' + c.url + ']');
  }
  if (!out.length && r.conclusion) out.push(r.conclusion);
  if (!out.length && r.text && r.text.div) out.push(htmlToText(r.text.div));
  return out.join('\n\n-----\n\n');
}
function docKind(r) {
  if (r.resourceType === 'DocumentReference' && (r.category || []).some(c => (c.coding || []).some(x => x.code === 'unstructured-import'))) return 'unstructured';
  const codes = (r.type ? [r.type] : []).concat(r.code ? [r.code] : []).concat(r.category || []).flatMap(c => (c.coding || []).map(x => x.code));
  const txt = norm([codeText(r.type), codeText(r.code), r.description, ...(r.category || []).map(codeText)].join(' '));
  if (codes.some(c => ['11488-4', '34099-2', '34100-8', '34104-0'].includes(c)) || /\bCONSULT/.test(txt)) return 'consult';
  if (codes.includes('18842-5') || /DISCHARGE SUMMAR/.test(txt)) return 'dcsumm';
  if (codes.some(c => ['11526-1', '60567-5', '60568-3', '22637-3', 'PAT', 'SP', 'CP'].includes(c)) || /PATHOLOG|CYTOLOG|BIOPSY/.test(txt)) return 'pathology';
  if (codes.some(c => ['18748-4', '18726-0', 'LP29684-5', 'RAD', '18782-3', '30704-1'].includes(c)) || /RADIOLOG|IMAGING|X RAY|XRAY|CHEST \d VIEW|\bCT\b|\bMRI\b|ULTRASOUND|\bUS ABDOMEN/.test(txt)) return 'radiology';
  return 'note';
}
function kindOf(r) {
  switch (r.resourceType) {
    case 'Observation': return obsKind(r);
    case 'Condition': return 'problem';
    case 'AllergyIntolerance': return 'allergy';
    case 'MedicationRequest': case 'MedicationStatement': return 'med';
    case 'Immunization': return 'imm';
    case 'Procedure': return 'proc';
    case 'Encounter': return 'enc';
    case 'Appointment': return 'appt';
    case 'DocumentReference': return docKind(r);
    case 'DiagnosticReport': {
      const hasDoc = (r.presentedForm || []).length || (!(r.result || []).length && r.conclusion);
      return hasDoc ? docKind(r) : 'panel';
    }
    default: return 'other';
  }
}
function medName(r) {
  if (r.medicationCodeableConcept) return codeText(r.medicationCodeableConcept);
  if (r.medicationReference) { if (r.medicationReference.display) return r.medicationReference.display; const ref = r.medicationReference.reference; const m = state.resources.find(x => x.resourceType === 'Medication' && ('urn:uuid:' + x.id) === ref); return m ? codeText(m.code) : 'Medication (referenced)'; }
  return '';
}
function primaryValue(r) { return obsValue(r).value; }
function dedupeKey(r, kind) {
  const loinc = cc => { const c = (cc && cc.coding || []).find(x => x.system === LOINC || x.system === SCT); return c ? c.code : norm(codeText(cc)); };
  switch (kind) {
    case 'lab': case 'vital': case 'social': case 'survey': case 'func': case 'obs-other':
      return 'obs|' + loinc(r.code) + '|' + minuteKey(obsDate(r)) + '|' + primaryValue(r);
    case 'problem': return 'cond|' + loinc(r.code) + '|' + dayKey(r.onsetDateTime || r.recordedDate);
    case 'allergy': return 'alg|' + norm(codeText(r.code));
    case 'med': return 'med|' + norm(medName(r)).split(' ').slice(0, 3).join(' ') + '|' + dayKey(r.authoredOn || (r.effectivePeriod || {}).start || r.effectiveDateTime || r.dateAsserted);
    case 'imm': return 'imm|' + loinc(r.vaccineCode) + '|' + dayKey(r.occurrenceDateTime);
    case 'proc': return 'proc|' + loinc(r.code) + '|' + minuteKey(r.performedDateTime || (r.performedPeriod || {}).start);
    case 'enc': return 'enc|' + minuteKey((r.period || {}).start) + '|' + norm(codeText((r.type || [])[0]));
    case 'appt': return 'appt|' + minuteKey(r.start);
    case 'panel': return 'dr|' + loinc(r.code) + '|' + minuteKey(r.effectiveDateTime);
    case 'unstructured': return null;
    case 'other': return null;
    default: { const t = norm(docText(r)).slice(0, 600); return t ? 'doc|' + dayKey(r.date || ((r.context || {}).period || {}).start || r.effectiveDateTime) + '|' + hashStr(t) : null; }
  }
}
let MERGE = true;
/* Add a normalized resource to the store (or merge its source reference into an identical existing item). */
function addResource(r, file, loc, patientKey, report) {
  if (!r.id) r.id = uid();
  r.extension = (r.extension || []).filter(e => e.url !== EXT_SRC);
  r.extension.push(srcExt(file, loc));
  const pref = patientRef(patientKey);
  if (pref) {
    if (['AllergyIntolerance', 'Condition', 'DocumentReference', 'DiagnosticReport', 'Observation', 'Procedure', 'MedicationRequest', 'MedicationStatement', 'Encounter'].includes(r.resourceType)) r.subject = pref;
    if (r.resourceType === 'AllergyIntolerance' || r.resourceType === 'Immunization') { delete r.subject; r.patient = pref; }
    if (r.resourceType === 'Appointment') r.participant = [{ actor: Object.assign({ display: 'Patient' }, pref), status: 'accepted' }].concat((r.participant || []).filter(p => !(p.actor && p.actor.display === 'Patient')));
  }
  if (r.resourceType === 'Observation' && r.code && !(r.code.coding || []).some(c => c.system === LOINC)) {
    const cats = (r.category || []).flatMap(c => (c.coding || []).map(x => x.code));
    if (!cats.some(c => ['vital-signs', 'survey', 'social-history', 'exam'].includes(c))) {
      const e = lookupLab(codeText(r.code), (r.specimen && r.specimen.display) || '', !!r.valueQuantity);
      if (e) (r.code.coding = r.code.coding || []).push({ system: LOINC, code: e.code, display: e.display, userSelected: false });
    }
  }
  normalizeFunc(r);
  const kind = kindOf(r);
  const dkey = MERGE ? dedupeKey(r, kind) : null;
  const fullKey = dkey ? patientKey + '§' + dkey : null;
  if (fullKey && state.byKey.has(fullKey)) {
    const ex = state.byKey.get(fullKey);
    ex.extension.push(srcExt(file, loc)); meta(ex).fileIds.add(file.id);
    report.merged++; return ex;
  }
  M.set(r, { patientKey, fileIds: new Set([file.id]), kind, dkey });
  state.resources.push(r); if (fullKey) state.byKey.set(fullKey, r);
  report.counts[kind] = (report.counts[kind] || 0) + 1;
  return r;
}
function addUnstructured(text, file, loc, patientKey, report, opt) {
  text = String(text || '').replace(/\s+$/g, '').replace(/^\s*\n/, '');
  if (!text.trim()) return null;
  const d = (opt && opt.date !== undefined) ? opt.date : (findDate(text) || {}).iso;
  const r = {
    resourceType: 'DocumentReference', status: 'current',
    type: { text: (opt && opt.label) || 'Unmapped imported content' },
    category: [{ coding: [{ system: CS_LOCAL, code: 'unstructured-import', display: 'Unstructured imported content' }] }],
    description: (opt && opt.label) || 'Content that could not be mapped to a standard data element',
    content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: utf8ToB64(text), title: file.name } }],
  };
  if (d) { if (/T/.test(d)) r.date = d; else r.context = { period: { start: d } }; }
  return addResource(r, file, loc, patientKey, report);
}
function makeDoc({ title, date, author, custodian, body, loincCode, loincDisplay, kind }) {
  const r = {
    resourceType: 'DocumentReference', status: 'current',
    type: loincCode ? { coding: [{ system: LOINC, code: loincCode, display: loincDisplay }], text: title } : { text: title },
    category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }],
    description: title,
    content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: utf8ToB64(body || ''), title } }],
  };
  if (date) { if (/T/.test(date)) r.date = date; else r.context = { period: { start: date } }; }
  if (author) r.author = [{ display: author }];
  if (custodian) r.custodian = { display: custodian };
  return r;
}
const DOC_LOINC = { note: ['11506-3', 'Progress note'], consult: ['11488-4', 'Consult note'], dcsumm: ['18842-5', 'Discharge summary'], radiology: ['18748-4', 'Diagnostic imaging study'], pathology: ['11526-1', 'Pathology study'] };

/* ================= FHIR (JSON / NDJSON / Bundle) ================= */
const RETAINED_ONLY = new Set(['Claim', 'ExplanationOfBenefit', 'SupplyDelivery', 'Provenance', 'CareTeam', 'Device', 'Organization', 'Practitioner', 'PractitionerRole', 'Location', 'Medication', 'ImagingStudy', 'MedicationAdministration', 'CarePlan', 'Coverage', 'Goal', 'ServiceRequest', 'Specimen', 'RelatedPerson', 'MedicationDispense', 'QuestionnaireResponse', 'FamilyMemberHistory', 'Binary']);
const SHARED_TYPES = new Set(['Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Medication', 'Binary', 'Specimen', 'Device']);   // not about one patient
/* "https://host/fhir/Patient/123/_history/2" and "Patient/123" are the same reference */
const refKey = ref => { if (typeof ref !== 'string') return ref; const m = ref.match(/(?:^|\/)([A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64})(?:\/_history\/[^\/]+)?$/); return m ? m[1] : ref; };
const idVariants = (type, id, full) => [type + '/' + id, 'urn:uuid:' + id, full, refKey(full)].filter(Boolean);
function remapRefs(o, lookup) {
  if (Array.isArray(o)) { o.forEach(x => remapRefs(x, lookup)); return; }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) {
    if (k === 'reference' && typeof o[k] === 'string') { const m = lookup(o[k]); if (m) o[k] = m; }
    else remapRefs(o[k], lookup);
  }
}
const CC_COND = 'http://terminology.hl7.org/CodeSystem/condition-clinical', CC_VER = 'http://terminology.hl7.org/CodeSystem/condition-ver-status';
const AL_CLIN = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', AL_VER = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';
const ENC_CLASS = { inpatient: ['IMP', 'inpatient encounter'], outpatient: ['AMB', 'ambulatory'], ambulatory: ['AMB', 'ambulatory'], emergency: ['EMER', 'emergency'], home: ['HH', 'home health'], field: ['FLD', 'field'], daytime: ['SS', 'short stay'], virtual: ['VR', 'virtual'], 'short stay': ['SS', 'short stay'] };
/* DSTU2 / STU3 -> R4 shapes, decided field by field so a file that mixes versions still works. Returns true when something was converted. */
function fhirToR4(r) {
  let ch = false; const set = (k, v) => { r[k] = v; ch = true; }; const mv = (from, to) => { if (r[from] !== undefined) { if (r[to] === undefined) r[to] = r[from]; delete r[from]; ch = true; } };
  const cc = (system, v) => typeof v === 'string' ? { coding: [{ system, code: v }] } : v;
  if (r.resourceType === 'MedicationOrder') { r.resourceType = 'MedicationRequest'; ch = true; if (!r.intent) r.intent = 'order'; mv('dateWritten', 'authoredOn'); mv('reasonCodeableConcept', 'reasonCode'); if (r.reasonCode && !Array.isArray(r.reasonCode)) r.reasonCode = [r.reasonCode]; mv('prescriber', 'requester'); mv('patient', 'subject'); }
  if (r.resourceType === 'DiagnosticOrder') { r.resourceType = 'ServiceRequest'; ch = true; mv('patient', 'subject'); }
  switch (r.resourceType) {
    case 'Condition': mv('patient', 'subject'); mv('dateRecorded', 'recordedDate'); mv('assertedDate', 'recordedDate');
      if (typeof r.clinicalStatus === 'string') set('clinicalStatus', cc(CC_COND, r.clinicalStatus)); if (typeof r.verificationStatus === 'string') set('verificationStatus', cc(CC_VER, r.verificationStatus)); break;
    case 'AllergyIntolerance': mv('substance', 'code'); mv('onset', 'onsetDateTime'); mv('assertedDate', 'recordedDate');
      if (typeof r.status === 'string' && r.clinicalStatus === undefined && r.verificationStatus === undefined) { const st = r.status; delete r.status; ch = true; if (['active', 'inactive', 'resolved'].includes(st)) r.clinicalStatus = cc(AL_CLIN, st); else r.verificationStatus = cc(AL_VER, st); }
      if (typeof r.clinicalStatus === 'string') set('clinicalStatus', cc(AL_CLIN, r.clinicalStatus)); if (typeof r.verificationStatus === 'string') set('verificationStatus', cc(AL_VER, r.verificationStatus));
      if (typeof r.category === 'string') set('category', [r.category]); break;
    case 'Immunization': mv('date', 'occurrenceDateTime'); if (r.wasNotGiven === true || r.notGiven === true) set('status', 'not-done'); delete r.wasNotGiven; delete r.notGiven; break;
    case 'Procedure': mv('patient', 'subject'); if (r.notPerformed === true || r.notDone === true) set('status', 'not-done'); delete r.notPerformed; delete r.notDone; break;
    case 'MedicationStatement': mv('patient', 'subject'); if (r.wasNotTaken === true || r.taken === 'n') set('status', 'not-taken'); delete r.wasNotTaken; if (typeof r.taken === 'string') { delete r.taken; ch = true; } break;
    case 'MedicationRequest': mv('patient', 'subject'); break;
    case 'Observation': mv('patient', 'subject'); if (r.interpretation && !Array.isArray(r.interpretation)) set('interpretation', [r.interpretation]); break;
    case 'Encounter': mv('patient', 'subject'); mv('reason', 'reasonCode');
      if (typeof r.class === 'string') { const m = ENC_CLASS[r.class.toLowerCase()] || [r.class.toUpperCase(), r.class]; set('class', { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: m[0], display: m[1] }); } break;
    case 'DocumentReference': mv('created', 'date'); mv('indexed', 'date'); break;
    case 'DiagnosticReport': mv('patient', 'subject'); if (r.performer && !Array.isArray(r.performer)) set('performer', [r.performer]); if (Array.isArray(r.performer) && r.performer.some(p => p && p.actor)) set('performer', r.performer.map(p => p && p.actor ? p.actor : p)); break;
  }
  return ch;
}
function isErroneous(r) {
  if (r.status === 'entered-in-error') return true;
  return [r.verificationStatus, r.clinicalStatus].some(cc => cc && (cc.coding || []).some(c => c.code === 'entered-in-error'));
}
const humanName = n => { const x = orderedNames(n)[0]; return x ? (x.text || [(x.prefix || []).join(' '), (x.given || []).join(' '), x.family].filter(Boolean).join(' ')).trim() : ''; };
const nameOfRes = r => ['Practitioner', 'RelatedPerson', 'Patient'].includes(r.resourceType) ? humanName(r.name) : (r.name || '');

function importFHIR(text, file, report) {
  const t = text.trim(); let items = [];
  const push = (res, loc, full) => {
    if (res && res.resourceType === 'Bundle') { (res.entry || []).forEach((e, i) => { if (e && e.resource) push(e.resource, loc + '.entry[' + i + ']', e.fullUrl); }); return; }
    if (res && typeof res === 'object' && !Array.isArray(res) && res.resourceType) items.push({ res, loc, full });
    else report.warnings.push('Item at ' + loc + ' is not a FHIR resource and was skipped.');
  };
  let j; if (t.startsWith('{') || t.startsWith('[')) { try { j = JSON.parse(t); } catch (e) { j = undefined; } }
  if (j !== undefined) { if (Array.isArray(j)) j.forEach((r, i) => push(r, '[' + i + ']')); else if (j.resourceType === 'Bundle') (j.entry || []).forEach((e, i) => { if (e && e.resource) push(e.resource, 'Bundle.entry[' + i + ']', e.fullUrl); }); else push(j, 'root'); }
  else {
    t.split(/\r?\n/).forEach((l, i) => { if (!l.trim()) return; try { push(JSON.parse(l), 'NDJSON line ' + (i + 1)); } catch (e) { report.warnings.push('NDJSON line ' + (i + 1) + ' is not valid JSON and was skipped.'); } });
    if (!items.length && !report.warnings.length) report.warnings.push('Not valid JSON/NDJSON.');
    if (!items.length) { addUnstructured(text.slice(0, 20000), file, { locator: 'whole file (invalid JSON)' }, report.defaultPatient || ensureUnknownPatient(file), report); return; }
  }
  if (!items.length) { report.warnings.push('No FHIR resources found.'); return; }
  const skipped = { outcome: 0, error: 0 }; const converted = new Set();
  items = items.filter(x => { if (x.res.resourceType === 'OperationOutcome' || x.res.resourceType === 'Parameters') { skipped.outcome++; return false; } return true; });
  for (const x of items) { x.orig = x.res.resourceType + '/' + x.res.id; x.res = clone(x.res); const ot = x.res.resourceType; if (fhirToR4(x.res)) converted.add(ot); }
  if (converted.size) report.warnings.push('This file uses FHIR DSTU2/STU3 resource shapes (' + [...converted].join(', ') + '); they were converted to R4. Check values that look unusual against the source.');

  // ---- patients (a file may hold none, one, or many; a ZIP's other files may define the patients)
  const scope = { patientRefs: PATIENT_REFS };
  const local = [];
  for (const p of items.filter(x => x.res.resourceType === 'Patient')) { p.pkey = upsertPatient(p.res, file, { locator: p.loc, originalId: 'Patient/' + p.res.id }); if (!local.includes(p.pkey)) local.push(p.pkey); for (const k of idVariants('Patient', p.res.id, p.full)) scope.patientRefs.set(k, p.pkey); }
  let unknownKey = null; const unknown = () => unknownKey || (unknownKey = ensureUnknownPatient(file)); let unresolved = 0;
  const sole = local.length === 1 ? local[0] : (!local.length ? (report.defaultPatient || null) : null);
  const keyFor = r => {
    const ref = (r.subject || r.patient || r.beneficiary || {}).reference;
    if (ref) { const k = scope.patientRefs.get(ref) || scope.patientRefs.get(refKey(ref)); if (k) return k; }
    if (sole) return sole;
    if (SHARED_TYPES.has(r.resourceType) && local.length) return local[0];
    if (local.length > 1) unresolved++;
    return unknown();
  };
  const patUrn = k => patientRef(k).reference;

  // ---- id remapping so internal references survive
  const map = new Map();
  for (const x of items) {
    const r = x.res;
    if (r.resourceType === 'Patient') { for (const k of idVariants('Patient', r.id, x.full)) map.set(k, patUrn(x.pkey)); continue; }
    x.newId = uid(); for (const k of idVariants(r.resourceType, r.id, x.full)) map.set(k, 'urn:uuid:' + x.newId);
  }
  const lookup = ref => map.get(ref) || map.get(refKey(ref)) || (scope.patientRefs.has(ref) || scope.patientRefs.has(refKey(ref)) ? patUrn(scope.patientRefs.get(ref) || scope.patientRefs.get(refKey(ref))) : null);

  // ---- display names for referenced people/organizations, medications by reference, Binary attachments
  const disp = new Map(), meds = new Map(), bins = new Map();
  for (const x of items) {
    const r = x.res;
    if (['Practitioner', 'Organization', 'Location', 'RelatedPerson'].includes(r.resourceType)) for (const k of idVariants(r.resourceType, r.id, x.full)) disp.set(k, nameOfRes(r));
    if (r.resourceType === 'Medication') for (const k of idVariants('Medication', r.id, x.full)) meds.set(k, r);
    if (r.resourceType === 'Binary' && r.data) for (const k of idVariants('Binary', r.id, x.full)) bins.set(k, x);
  }
  const fromContained = (res, ref) => (typeof ref === 'string' && ref[0] === '#') ? (res.contained || []).find(c => '#' + c.id === ref) : null;
  const fillDisp = (res, ref) => { if (!ref || !ref.reference || ref.display) return; const c = fromContained(res, ref.reference); const d = c ? nameOfRes(c) : (disp.get(ref.reference) || disp.get(refKey(ref.reference))); if (d) ref.display = d; };
  const inlineBinary = att => {
    if (!att || att.data || !att.url) return; const b = bins.get(att.url) || bins.get(refKey(att.url)); if (!b) return;
    att.data = b.res.data; if (!att.contentType) att.contentType = b.res.contentType; delete att.url; b.used = true;
  };
  const erroneous = new Set();
  for (const x of items) if (x.res.resourceType !== 'Patient' && isErroneous(x.res)) { x.skip = true; skipped.error++; idVariants(x.res.resourceType, x.res.id, x.full).forEach(k => erroneous.add(k)); }

  let lastKey = null; const used = new Set(local);
  for (const x of items) {
    const r0 = x.res; if (r0.resourceType === 'Patient' || x.skip) continue;
    const r = r0; const orig = x.orig;
    if (r.resourceType === 'Binary' && x.used) continue;
    r.id = x.newId; delete r.text; lastKey = keyFor(r); used.add(lastKey);      // route by the ORIGINAL patient reference, before references are rewritten
    for (const f of ['performer', 'author', 'participant', 'location']) (Array.isArray(r[f]) ? r[f] : r[f] ? [r[f]] : []).forEach(p => { fillDisp(r, p.actor || p.individual || p.location || p); });
    for (const f of ['custodian', 'requester', 'recorder', 'asserter', 'serviceProvider', 'prescriber']) fillDisp(r, r[f]);
    (r.resultsInterpreter || []).forEach(p => fillDisp(r, p));
    if (r.medicationReference && !r.medicationReference.display) { const m = fromContained(r, r.medicationReference.reference) || meds.get(r.medicationReference.reference) || meds.get(refKey(r.medicationReference.reference)); if (m) r.medicationReference.display = codeText(m.code); }
    (r.content || []).forEach(c => inlineBinary(c.attachment)); (r.presentedForm || []).forEach(inlineBinary);
    if (r.resourceType === 'DiagnosticReport' && erroneous.size && r.result) r.result = r.result.filter(q => !erroneous.has(q.reference) && !erroneous.has(refKey(q.reference)));
    remapRefs(r, lookup);
    if (r.resourceType === 'Observation') (r.referenceRange || []).forEach(rr => { if (!rr.low && !rr.high && rr.text) { const pr = parseRange(rr.text, (r.valueQuantity || {}).unit); if (pr && pr.low) rr.low = pr.low; if (pr && pr.high) rr.high = pr.high; } });
    const loc = { locator: x.loc + ' (' + orig + ')', originalId: orig };
    if (r.resourceType === 'DocumentReference' && (r.content || []).some(c => c.attachment && !c.attachment.data && c.attachment.url)) report.warnings.push('DocumentReference ' + orig + ' points to external content (' + r.content[0].attachment.url + '); only metadata was imported.');
    addResource(r, file, loc, lastKey, report);
  }
  report.patientKey = local[local.length - 1] || lastKey || sole || null; report.patientKeys = [...used];
  if (skipped.error) report.warnings.push(skipped.error + ' resource(s) marked entered-in-error were not imported.');
  if (skipped.outcome) report.skipped = Object.assign(report.skipped || {}, { operationOutcome: skipped.outcome });
  if (unresolved) report.warnings.push(unresolved + ' resource(s) refer to a patient that is not in this file and were assigned to "UNIDENTIFIED PATIENT". Import the Patient file first, or import the whole export as one ZIP.');
}

/* ================= HL7 v2 (ORU results, MDM documents, VXU immunizations) ================= */
const V2_SYS = { LN: LOINC, SCT: SCT, SNM: SCT, SNM3: SCT, SNOMEDCT: SCT, SNOMED: SCT, I10: 'http://hl7.org/fhir/sid/icd-10-cm', I10C: 'http://hl7.org/fhir/sid/icd-10-cm', ICD10: 'http://hl7.org/fhir/sid/icd-10-cm', ICD10CM: 'http://hl7.org/fhir/sid/icd-10-cm', I9: 'http://hl7.org/fhir/sid/icd-9-cm', I9C: 'http://hl7.org/fhir/sid/icd-9-cm', ICD9: 'http://hl7.org/fhir/sid/icd-9-cm',
  RXNORM: RXN, RXN: RXN, CVX: 'http://hl7.org/fhir/sid/cvx', NDC: 'http://hl7.org/fhir/sid/ndc', CPT: 'http://www.ama-assn.org/go/cpt', C4: 'http://www.ama-assn.org/go/cpt', HCPCS: 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets', UCUM: UCUM };
const v2Sys = c => V2_SYS[String(c || '').toUpperCase()] || 'urn:hl7v2:' + (c || 'local');
const V2_STATUS = { F: 'final', U: 'final', P: 'preliminary', S: 'preliminary', R: 'preliminary', C: 'corrected', A: 'amended', X: 'cancelled', I: 'registered' };
function importHL7v2(text, file, report) {
  const segs = text.replace(/[\x0b\x1c]/g, '').split(/\r\n|\r|\n/).map(s => s.replace(/^\s+/, '')).filter(s => s.trim());
  if (!segs.length || !/^(MSH|FHS|BHS)/.test(segs[0])) report.warnings.push('No MSH segment; not an HL7 v2 message.');
  let fs = '|', comp = '^', rep = '~', sendingFac = '';
  const setEnc = line => { fs = line[3] || '|'; const f = line.split(fs); const enc = f[1] || '^~\\&'; comp = enc[0] || '^'; rep = enc[1] || '~'; sendingFac = (f[3] || '').split(comp)[0]; };
  const F = (seg, n) => (seg[n] || ''); const C = (v, n) => (v || '').split(comp)[n] || '';
  const unesc = s => s.replace(/\\\.br\\/g, '\n').replace(/\\F\\/g, '|').replace(/\\S\\/g, '^').replace(/\\T\\/g, '&').replace(/\\R\\/g, '~').replace(/\\E\\/g, '\\');
  const xcn = v => { const p = (v || '').split(comp); const o = /^\d/.test(p[0]) ? 1 : 0; return [p[o + 1], p[o + 2], p[o]].filter(Boolean).join(' '); };
  /* CE / CWE / CNE -> CodeableConcept, including the alternate triplet (components 4-6): local code + LOINC is the usual case */
  const ce = v => { const p = (v || '').split(comp); const cc = { coding: [] }; const add = (id, tx, sy) => { if (id) cc.coding.push({ system: v2Sys(sy || 'local'), code: id, display: tx || undefined }); };
    add(p[0], p[1], p[2]); add(p[3], p[4], p[5]); cc.text = p[1] || p[4] || p[0] || p[3] || undefined; if (!cc.coding.length) delete cc.coding; return cc; };
  const num = x => /^[<>]?=?\s*-?\d+(?:\.\d+)?$/.test(String(x).trim());
  let pKey = null, obr = null, txa = null, lastObs = null, docBuf = null; const skipped = { deleted: 0 };
  const docKindOf = s => /RAD|IMAG|\bUS\b|\bCT\b|\bMR|\bXR|X-RAY|ULTRASOUND/i.test(s) ? 'radiology' : /PATH|BIOPSY|CYTOL/i.test(s) ? 'pathology' : 'note';
  const flushDoc = () => {
    if (!docBuf) return;
    const kind = docKindOf(docBuf.title + ' ' + docBuf.text.slice(0, 400)); const L = DOC_LOINC[kind];
    const r = makeDoc({ title: docBuf.title, date: docBuf.date, author: docBuf.author, custodian: docBuf.org || sendingFac, body: docBuf.text, loincCode: L[0], loincDisplay: L[1] });
    addResource(r, file, { locator: 'segments ' + docBuf.from + '-' + docBuf.to + ' (' + (txa ? 'TXA/' : 'OBR/') + 'OBX TX)' }, pKey, report); docBuf = null;
  };
  segs.forEach((line, i) => {
    const id = line.slice(0, 3); const n = i + 1;
    if (id === 'FHS' || id === 'BHS' || id === 'BTS' || id === 'FTS') { if (id === 'FHS' || id === 'BHS') setEnc(line); return; }
    if (id === 'MSH') { flushDoc(); setEnc(line); obr = null; txa = null; lastObs = null; pKey = null; return; }
    const seg = line.split(fs);
    if (id === 'PID') {
      flushDoc(); const nm = F(seg, 5).split(rep)[0]; const p = { name: [{ family: C(nm, 0), given: [C(nm, 1), C(nm, 2)].filter(Boolean) }], birthDate: (tsToFhir(F(seg, 7)) || '').slice(0, 10) || undefined, gender: { M: 'male', F: 'female', O: 'other', U: 'unknown', A: 'other', N: 'unknown' }[F(seg, 8)] };
      const pid = F(seg, 3).split(rep)[0]; if (C(pid, 0)) p.identifier = [{ type: { text: C(pid, 4) || 'MR' }, system: 'urn:hl7v2:' + (C(pid, 3) || sendingFac), value: C(pid, 0) }];
      pKey = upsertPatient(p, file, { locator: 'segment ' + n + ' (PID)' }); report.patientKey = pKey; return;
    }
    if (!pKey) pKey = report.defaultPatient || ensureUnknownPatient(file);
    if (id === 'OBR') { flushDoc(); obr = { code: F(seg, 4), date: tsToFhir(F(seg, 7)), issued: tsToFhir(F(seg, 22)), prov: F(seg, 16), seg: n }; lastObs = null; return; }
    if (id === 'TXA') { flushDoc(); txa = { title: C(F(seg, 2), 1) || C(F(seg, 2), 0) || 'Document', date: tsToFhir(F(seg, 4)) || tsToFhir(F(seg, 6)), author: xcn(F(seg, 9).split(rep)[0]), seg: n }; lastObs = null; return; }
    if (id === 'OBX') {
      const type = F(seg, 2), codeF = F(seg, 3), val = F(seg, 5), units = C(F(seg, 6), 0), range = F(seg, 7), flags = F(seg, 8).split(rep)[0], st = F(seg, 11), org = C(F(seg, 23), 0);
      const dt = tsToFhir(F(seg, 14)) || (obr && obr.date) || (txa && txa.date) || null;
      if (st === 'D' || st === 'W') { skipped.deleted++; return; }                // deleted / posted to the wrong patient
      if (st === 'N' || st === 'O') return;                                         // not asked / order detail only
      if (type === 'TX' || type === 'FT') {
        const t = val.split(rep).map(unesc).join('\n');
        if (!docBuf) docBuf = { title: txa ? txa.title : (C(obr ? obr.code : codeF, 1) || C(codeF, 1) || 'Report'), date: txa ? (txa.date || dt) : dt, author: txa ? txa.author : (obr && obr.prov ? xcn(obr.prov) + ' (ordering provider)' : ''), org, text: t, from: txa ? txa.seg : (obr ? obr.seg : n), to: n };
        else { docBuf.text += '\n' + t; docBuf.to = n; }
        return;
      }
      flushDoc();
      if (type === 'ED' || type === 'RP') {                                         // encapsulated data: a whole report as a PDF / text / RTF
        const p = val.split(comp); const mt = (p[1] || 'application') + '/' + (p[2] || 'octet-stream'), enc = (p[3] || '').toLowerCase(), data = p.slice(4).join(comp);
        const title = C(codeF, 1) || (obr && C(obr.code, 1)) || 'Report'; const kind = docKindOf(title + ' ' + (obr ? C(obr.code, 1) : '')); const L = DOC_LOINC[kind];
        const r = makeDoc({ title, date: dt, author: obr && obr.prov ? xcn(obr.prov) + ' (ordering provider)' : '', custodian: org || sendingFac, body: '', loincCode: L[0], loincDisplay: L[1] });
        if (type === 'RP') r.content = [{ attachment: { contentType: mt, url: val.split(comp)[0], title } }];
        else r.content = [{ attachment: { contentType: mt, data: enc === 'base64' ? data.replace(/\s/g, '') : utf8ToB64(unesc(data)), title } }];
        addResource(r, file, { locator: 'segment ' + n + ' (OBX-' + F(seg, 1) + ' ' + type + ')' }, pKey, report); return;
      }
      const cc = ce(codeF); if (!cc.text) cc.text = 'Observation';
      const r = { resourceType: 'Observation', status: V2_STATUS[st] || 'final', category: [{ coding: [{ system: OBSCAT, code: 'laboratory', display: 'Laboratory' }] }], code: cc };
      if (dt) r.effectiveDateTime = dt; if (obr && obr.issued) r.issued = obr.issued.length > 10 ? obr.issued : undefined;
      if (type === 'NM' && num(val)) { const m = val.trim().match(/^([<>]=?)?\s*(-?\d+(?:\.\d+)?)/); r.valueQuantity = qty(m[2], units); if (m[1]) r.valueQuantity.comparator = m[1]; }
      else if (type === 'SN') {                                                      // structured numeric: comparator ^ num1 ^ separator ^ num2
        const p = val.split(comp); const cmp = (p[0] || '').trim(), n1 = (p[1] || '').trim(), sep = (p[2] || '').trim(), n2 = (p[3] || '').trim();
        if (/^(<=?|>=?)$/.test(cmp) && num(n1)) { r.valueQuantity = qty(n1, units); r.valueQuantity.comparator = cmp; }
        else if (num(n1) && (sep === ':' || sep === '/') && num(n2)) r.valueRatio = { numerator: qty(n1), denominator: qty(n2) };
        else if (num(n1) && sep === '-' && num(n2)) r.valueRange = { low: qty(n1, units), high: qty(n2, units) };
        else if (num(n1) && (!cmp || cmp === '=') && !sep) r.valueQuantity = qty(n1, units);
        else r.valueString = unesc(val.split(comp).join(' ').trim());
      }
      else if (type === 'CE' || type === 'CWE' || type === 'CNE') r.valueCodeableConcept = ce(val);
      else if ((type === 'DT' || type === 'TS' || type === 'DTM') && tsToFhir(val)) r.valueDateTime = tsToFhir(val);
      else r.valueString = unesc(val);
      const rr = parseRange(range, units); if (rr) r.referenceRange = [rr];
      const fl = flagCode(flags); if (fl) r.interpretation = [fl];
      if (org) r.performer = [{ display: org }];
      lastObs = addResource(r, file, { locator: 'segment ' + n + ' (OBX-' + F(seg, 1) + ')' }, pKey, report);
      return;
    }
    if (id === 'RXA') {                                                              // VXU: immunization administered
      flushDoc(); const p = ce(F(seg, 5)); const comp20 = F(seg, 20); const refused = comp20 === 'RE', done = comp20 === '' || comp20 === 'CP' || comp20 === 'PA';
      const dtv = tsToFhir(F(seg, 3)); const r = { resourceType: 'Immunization', status: refused ? 'not-done' : done ? 'completed' : 'not-done', vaccineCode: p.text || p.coding ? p : { text: 'Vaccine' } };
      if (dtv) r.occurrenceDateTime = dtv; else r.occurrenceString = 'unknown'; if (F(seg, 15)) r.lotNumber = F(seg, 15).split(rep)[0]; if (C(F(seg, 17), 1) || C(F(seg, 17), 0)) r.manufacturer = { display: C(F(seg, 17), 1) || C(F(seg, 17), 0) };
      if (F(seg, 9)) r.note = [{ text: C(F(seg, 9), 1) || C(F(seg, 9), 0) }];
      addResource(r, file, { locator: 'segment ' + n + ' (RXA)' }, pKey, report); return;
    }
    if (id === 'NTE' && lastObs) { (lastObs.note = lastObs.note || []).push({ text: unesc(F(seg, 3)) }); return; }
    if (id === 'SPM' && lastObs) { lastObs.specimen = { display: C(F(seg, 4), 1) || C(F(seg, 4), 0) }; return; }
    if (['PV1', 'PV2', 'ORC', 'EVN', 'PD1', 'MSA', 'ERR'].includes(id)) return;     // routing/administrative segments with no clinical content
    addUnstructured(line, file, { locator: 'segment ' + n + ' (' + id + ')', }, pKey, report, { label: 'Unrecognized HL7 v2 segment ' + id, date: null });
  });
  flushDoc();
  if (skipped.deleted) report.warnings.push(skipped.deleted + ' result(s) flagged deleted or posted to the wrong patient (OBX-11 D/W) were not imported.');
}

/* ================= HL7 C-CDA (CCD, notes, Epic / VA / Oracle Health exports) ================= */
const OID = { '2.16.840.1.113883.6.1': LOINC, '2.16.840.1.113883.6.96': SCT, '2.16.840.1.113883.6.88': RXN, '2.16.840.1.113883.12.292': 'http://hl7.org/fhir/sid/cvx',
  '2.16.840.1.113883.6.90': 'http://hl7.org/fhir/sid/icd-10-cm', '2.16.840.1.113883.6.103': 'http://hl7.org/fhir/sid/icd-9-cm', '2.16.840.1.113883.6.12': 'http://www.ama-assn.org/go/cpt',
  '2.16.840.1.113883.6.285': 'urn:oid:2.16.840.1.113883.6.285', '2.16.840.1.113883.6.69': 'http://hl7.org/fhir/sid/ndc', '2.16.840.1.113883.5.4': 'http://terminology.hl7.org/CodeSystem/v3-ActCode' };
const SEC = [
  ['results', ['2.16.840.1.113883.10.20.22.2.3.1', '2.16.840.1.113883.10.20.22.2.3'], ['30954-2']],
  ['vitals', ['2.16.840.1.113883.10.20.22.2.4.1', '2.16.840.1.113883.10.20.22.2.4'], ['8716-3']],
  ['problems', ['2.16.840.1.113883.10.20.22.2.5.1', '2.16.840.1.113883.10.20.22.2.5'], ['11450-4']],
  ['meds', ['2.16.840.1.113883.10.20.22.2.1.1', '2.16.840.1.113883.10.20.22.2.1', '2.16.840.1.113883.10.20.22.2.38', '2.16.840.1.113883.10.20.22.2.11.1', '2.16.840.1.113883.10.20.22.2.44'], ['10160-0', '29549-3', '10183-2']],
  ['allergies', ['2.16.840.1.113883.10.20.22.2.6.1', '2.16.840.1.113883.10.20.22.2.6'], ['48765-2']],
  ['imms', ['2.16.840.1.113883.10.20.22.2.2.1', '2.16.840.1.113883.10.20.22.2.2'], ['11369-6']],
  ['procs', ['2.16.840.1.113883.10.20.22.2.7.1', '2.16.840.1.113883.10.20.22.2.7'], ['47519-4']],
  ['encs', ['2.16.840.1.113883.10.20.22.2.22.1', '2.16.840.1.113883.10.20.22.2.22'], ['46240-8']],
  ['social', ['2.16.840.1.113883.10.20.22.2.17'], ['29762-2']],
  ['notes', ['2.16.840.1.113883.10.20.22.2.65'], []],
  // functional / mental / cognitive status, advance directives, health-status evaluations: patient observations that are not labs
  ['functional', ['2.16.840.1.113883.10.20.22.2.14'], ['47420-5']],
  ['survey', ['2.16.840.1.113883.10.20.22.2.56', '2.16.840.1.113883.10.20.22.2.21.1', '2.16.840.1.113883.10.20.22.2.21', '2.16.840.1.113883.10.20.22.2.61', '2.16.840.1.113883.10.20.22.2.57'], ['10190-7', '42348-3', '11383-7', '61144-2']],
  // past medical history reads like a problem list
  ['problems', ['2.16.840.1.113883.10.20.22.2.20'], ['11348-0']],
  // plans, goals, family history, assessments, health concerns: keep the text, but never file them as the patient's own results
  ['narrative', ['2.16.840.1.113883.10.20.22.2.10', '2.16.840.1.113883.10.20.22.2.60', '2.16.840.1.113883.10.20.22.2.15', '2.16.840.1.113883.10.20.22.2.58', '2.16.840.1.113883.10.20.22.2.9', '2.16.840.1.113883.10.20.22.2.8'], ['18776-5', '61146-7', '10157-6', '75310-3', '51847-2', '51848-0', '8653-8']],
];
const SEC_TITLE_RESULTS = /\b(results?|laborator\w*|diagnostic\w*|imaging|pathology|microbiology|radiology)\b/i;
const NONE_RE = /^(?:no (?:known|information|data|record|current|active|significant|prior|previous|reported|documented|history)|none(?: known| reported| recorded| documented)?\b|nothing\b|not (?:available|applicable|on file)\b|patient has no known|no drug therapy)/i;
const NONE_CODES = new Set(['396782006', '160245001', '182849000', '716186003', '160244002', '409137002', '1090801000168104']);   // "no known problems / medications / allergies ..." statements
const isNoneStatement = cc => !!cc && (NONE_RE.test(String(cc.text || '').trim()) || (cc.coding || []).some(c => NONE_CODES.has(c.code)));
const SUMMARY_DOC_CODES = new Set(['34133-9', '60591-5', '18761-7', '57133-1', '81218-0']);
const T = {   // C-CDA entry templates
  PROBLEM_OBS: '2.16.840.1.113883.10.20.22.4.4', PROBLEM_STATUS: '2.16.840.1.113883.10.20.22.4.6', HEALTH_STATUS: '2.16.840.1.113883.10.20.22.4.5', AGE_OBS: '2.16.840.1.113883.10.20.22.4.31',
  ALLERGY_OBS: '2.16.840.1.113883.10.20.22.4.7', SEVERITY: '2.16.840.1.113883.10.20.22.4.8', REACTION: '2.16.840.1.113883.10.20.22.4.9', INSTRUCTIONS: '2.16.840.1.113883.10.20.22.4.20', NOTE_ACT: '2.16.840.1.113883.10.20.22.4.202' };
const CDA_STATUS_CODE = { '55561003': 'active', '73425007': 'inactive', '413322009': 'resolved' };      // SNOMED problem / allergy status values
const CDA_ALLERGY_CAT = { '416098002': 'medication', '59037007': 'medication', '414285001': 'food', '235719002': 'food', '426232007': 'environment', '426284001': 'environment', '419199007': null, '418038007': null, '420134006': null };
const CDA_ALLERGY_TYPE = { '416098002': 'allergy', '414285001': 'allergy', '426232007': 'allergy', '419199007': 'allergy', '59037007': 'intolerance', '235719002': 'intolerance' };
const CDA_OBS_STATUS = { completed: 'final', aborted: 'cancelled', cancelled: 'cancelled', active: 'preliminary', held: 'registered', new: 'registered', suspended: 'registered' };
const CDA_ACT_CLASS = /^(IMP|ACUTE|NONAC|EMER|AMB|OBSENC|PRENC|SS|HH|VR|FLD)$/;
const isNum = s => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(String(s).trim());

function importCDA(text, file, report) {
  const doc = new deps.DOMParser().parseFromString(text, 'text/xml');
  const all = (el, name) => Array.from(el.getElementsByTagNameNS(CNS, name));
  const kids = (el, name) => el ? Array.from(el.childNodes).filter(n => n.nodeType === 1 && n.localName === name) : [];
  const kid = (el, name) => kids(el, name)[0] || null;
  const path = (el, ...names) => { for (const n of names) { el = kid(el, n); if (!el) return null; } return el; };
  const at = (el, a) => el ? (el.getAttribute(a) || '') : '';
  const txt = el => el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  const within = (a, b) => { for (let n = b && b.parentNode; n; n = n.parentNode) if (n === a) return true; return false; };
  const root = doc.documentElement;
  if (!root || root.localName !== 'ClinicalDocument') { report.warnings.push('Not an HL7 CDA ClinicalDocument.'); addUnstructured(text.slice(0, 20000), file, { locator: 'whole file' }, report.defaultPatient || ensureUnknownPatient(file), report); return; }
  const ids = {}; all(root, '*').forEach(e => { const id = e.getAttribute && e.getAttribute('ID'); if (id && !ids[id]) ids[id] = e; });
  // narrative text with cell / paragraph separators ("Na" "140" must not become "Na140")
  const nodeText = el => { const out = []; const walk = n => { for (const c of Array.from(n.childNodes)) { if (c.nodeType === 3) out.push(c.nodeValue); else if (c.nodeType === 1) { const ln = c.localName; if (ln === 'br') out.push(' '); walk(c); if (/^(td|th|tr|paragraph|item|caption|footnote)$/.test(ln)) out.push(' '); } } }; walk(el); return out.join('').replace(/\s+/g, ' ').trim(); };
  // text of an element that may point at the section narrative: <text><reference value="#id"/></text> (Epic, Oracle Health, VA all do this)
  const tx = el => {
    if (!el) return '';
    const refs = all(el, 'reference').map(r => at(r, 'value').replace(/^#/, '')).filter(id => ids[id] && !within(ids[id], el));
    if (refs.length) return refs.map(id => nodeText(ids[id])).filter(Boolean).join(' ');
    return nodeText(el);
  };
  const code = el => {
    if (!el) return null;
    const cc = { coding: [] };
    const dn = e => { const d = at(e, 'displayName').trim(); return d && !/^(null|undefined)$/i.test(d) ? d : ''; };   // some EHRs print the literal string "null"
    const push = e => { if (at(e, 'code')) cc.coding.push({ system: OID[at(e, 'codeSystem')] || (at(e, 'codeSystem') ? 'urn:oid:' + at(e, 'codeSystem') : undefined), code: at(e, 'code'), display: dn(e) || undefined }); };
    push(el); kids(el, 'translation').forEach(push);
    cc.text = dn(el) || tx(kid(el, 'originalText')) || (cc.coding.find(c => c.display) || {}).display || undefined;
    if (!cc.coding.length) delete cc.coding;
    return (cc.coding || cc.text) ? cc : null;
  };
  const ts = el => { if (!el) return null; if (at(el, 'value')) return tsToFhir(at(el, 'value')); const l = kid(el, 'low'); if (l && at(l, 'value')) return tsToFhir(at(l, 'value')); const c = kid(el, 'center'); return c ? tsToFhir(at(c, 'value')) : null; };
  const tsHigh = el => { const h = el && kid(el, 'high'); return h && at(h, 'value') ? tsToFhir(at(h, 'value')) : null; };
  const xtype = el => el ? (el.getAttributeNS(XSI, 'type') || el.getAttribute('xsi:type') || '').replace(/^.*:/, '') : '';
  const personName = n => n ? [txt(kid(n, 'prefix')), ...kids(n, 'given').filter(g => at(g, 'qualifier') !== 'CL').map(txt), txt(kid(n, 'family')), txt(kid(n, 'suffix'))].filter(Boolean).join(' ') || txt(n) : '';
  const hasTpl = (el, roots) => kids(el, 'templateId').some(t => roots.includes(at(t, 'root')));
  const statusOf = el => at(kid(el, 'statusCode'), 'code').toLowerCase();
  const skipped = { nullified: 0, negatedMed: 0, planned: 0, none: 0 };

  // ---- header
  const pr = path(root, 'recordTarget', 'patientRole'); const pt = pr && kid(pr, 'patient');
  let pKey;
  if (pt) {
    const names = kids(pt, 'name').map(n => ({ use: { L: 'official', C: 'usual', P: 'nickname', A: 'anonymous' }[at(n, 'use')], family: txt(kid(n, 'family')) || undefined, given: kids(n, 'given').filter(g => at(g, 'qualifier') !== 'CL').map(txt).filter(Boolean), text: !kid(n, 'family') ? txt(n) || undefined : undefined })).filter(n => n.family || n.text);
    const p = { name: names.length ? names : [{ family: '', given: [] }], gender: { M: 'male', F: 'female', UN: 'other' }[at(kid(pt, 'administrativeGenderCode'), 'code')] };
    const bt = at(kid(pt, 'birthTime'), 'value'); if (bt) p.birthDate = tsToFhir(bt.slice(0, 8));
    p.identifier = kids(pr, 'id').filter(i => at(i, 'extension')).map(i => ({ system: 'urn:oid:' + at(i, 'root'), value: at(i, 'extension') }));
    const a = kid(pr, 'addr'); if (a) p.address = [{ line: kids(a, 'streetAddressLine').map(txt), city: txt(kid(a, 'city')), state: txt(kid(a, 'state')), postalCode: txt(kid(a, 'postalCode')) }];
    pKey = upsertPatient(p, file, { locator: 'ClinicalDocument/recordTarget' });
  } else pKey = report.defaultPatient || ensureUnknownPatient(file);
  report.patientKey = pKey; report.patientKeys = [pKey];
  const docCode = code(kid(root, 'code')) || {};
  const docLoinc = ((docCode.coding || [])[0] || {}).code;
  const docTitle = txt(kid(root, 'title')) || docCode.text || 'Clinical document';
  const docDate = ts(kid(root, 'effectiveTime'));
  const aa = path(root, 'author', 'assignedAuthor');
  const author = aa ? (personName(path(aa, 'assignedPerson', 'name')) || txt(path(aa, 'assignedAuthoringDevice', 'softwareName'))) : '';
  const custodian = txt(path(root, 'custodian', 'assignedCustodian', 'representedCustodianOrganization', 'name')) || txt(path(aa || root, 'representedOrganization', 'name'));
  file.system = file.system || custodian || undefined;

  const narrative = sec => {
    const t = kid(sec, 'text'); if (!t) return '';
    const out = []; const walk = (el, depth) => {
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 3) { const s = n.nodeValue.replace(/\s+/g, ' '); if (s.trim()) out.push(s); continue; }
        if (n.nodeType !== 1) continue;
        const ln = n.localName;
        if (ln === 'tr') { out.push('\n' + Array.from(n.childNodes).filter(c => c.nodeType === 1).map(c => txt(c)).join(' | ')); continue; }
        if (ln === 'br') { out.push('\n'); continue; }
        if (['paragraph', 'item', 'caption'].includes(ln)) { out.push('\n'); walk(n, depth + 1); out.push('\n'); continue; }
        walk(n, depth + 1);
      }
    };
    walk(t, 0);
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  // ---- values
  const unitOf = e => { const u = at(e, 'unit'); return u && u !== '1' ? u : undefined; };
  const pqOf = e => {                                     // PQ-like element -> Quantity; tolerates "<5" printed in value=
    const s = at(e, 'value').trim(); if (!s) return null; const u = unitOf(e);
    if (isNum(s)) return qty(s, u);
    const m = s.match(/^(<=|>=|<|>)\s*(.+)$/); if (m && isNum(m[2])) { const q = qty(m[2].trim(), u); q.comparator = m[1]; return q; }
    return null;
  };
  const setValue = (r, v, o) => {
    if (!v) return;
    const xt = xtype(v);
    if (xt === 'PQ' || (!xt && at(v, 'value') && at(v, 'unit'))) { const q = pqOf(v); if (q) r.valueQuantity = q; else if (at(v, 'value')) r.valueString = at(v, 'value'); }
    else if (/^IVL_(PQ|REAL|INT)$/.test(xt)) {
      const lo = kid(v, 'low'), hi = kid(v, 'high'), ce = kid(v, 'center');
      const lq = lo && pqOf(lo), hq = hi && pqOf(hi);
      if (lq && hq) r.valueRange = { low: lq, high: hq };
      else if (hq) { hq.comparator = hq.comparator || (at(hi, 'inclusive') === 'false' ? '<' : '<='); r.valueQuantity = hq; }
      else if (lq) { lq.comparator = lq.comparator || (at(lo, 'inclusive') === 'false' ? '>' : '>='); r.valueQuantity = lq; }
      else if (ce && pqOf(ce)) r.valueQuantity = pqOf(ce);
    }
    else if (/^RTO/.test(xt)) {
      const nq = pqOf(kid(v, 'numerator') || v), dq = pqOf(kid(v, 'denominator') || v);
      if (kid(v, 'numerator') && kid(v, 'denominator') && nq && dq) r.valueRatio = { numerator: nq, denominator: dq };
    }
    else if (xt === 'INT') { if (isNum(at(v, 'value'))) r.valueInteger = Number(at(v, 'value')); }
    else if (xt === 'REAL') { const q = pqOf(v); if (q) r.valueQuantity = q; }
    else if (['CD', 'CE', 'CO', 'CV'].includes(xt)) { const cc = code(v); if (cc) r.valueCodeableConcept = cc; }
    else if (xt === 'BL') { if (at(v, 'value')) r.valueBoolean = at(v, 'value') === 'true'; }
    else if (xt === 'TS') { const d = ts(v); if (d) r.valueDateTime = d; }
    if (!['valueQuantity', 'valueRange', 'valueRatio', 'valueInteger', 'valueCodeableConcept', 'valueBoolean', 'valueDateTime'].some(k => r[k] != null) && r.valueString == null) {
      const s = tx(v) || at(v, 'value'); if (s) r.valueString = s;
    }
  };

  const obsFrom = (o, cat, fallbackTime) => {
    const st = statusOf(o); if (st === 'nullified' || st === 'obsolete') { skipped.nullified++; return null; }
    const r = { resourceType: 'Observation', status: CDA_OBS_STATUS[st] || 'final', category: [{ coding: [{ system: OBSCAT, code: cat === 'functional' ? 'survey' : cat, display: { laboratory: 'Laboratory', 'vital-signs': 'Vital Signs', 'social-history': 'Social History', exam: 'Exam', survey: 'Survey', functional: 'Survey' }[cat] }] }], code: code(kid(o, 'code')) || { text: 'Observation' } };
    if (cat === 'functional') r.category.push({ coding: [{ system: CS_LOCAL, code: FUNC_CAT, display: 'Functional status' }] });
    const dt = ts(kid(o, 'effectiveTime')) || fallbackTime; if (dt) r.effectiveDateTime = dt;
    const v = kid(o, 'value'); setValue(r, v, o);
    const noCode = !(r.code.coding && r.code.coding.length) && (!r.code.text || r.code.text === 'Observation');
    if (!['valueQuantity', 'valueRange', 'valueRatio', 'valueInteger', 'valueCodeableConcept', 'valueBoolean', 'valueDateTime', 'valueString'].some(k => r[k] != null)) {
      const t = tx(kid(o, 'text')); if (t && t.length < 3000) r.valueString = t;   // value given only as narrative (empty <value>, imaging impressions, ...)
    }
    if (cat === 'functional' && !['valueQuantity', 'valueRange', 'valueRatio', 'valueInteger', 'valueCodeableConcept', 'valueBoolean', 'valueDateTime', 'valueString'].some(k => r[k] != null)) { skipped.none++; return null; }   // functional status with no finding recorded
    if (noCode && (at(o, 'negationInd') === 'true' || NONE_RE.test(r.valueString || '') || /\bexcluded\b/i.test(r.valueString || ''))) { skipped.none++; return null; }   // negated / "results excluded or not available" placeholder
    if (noCode && !['valueQuantity', 'valueRange', 'valueRatio', 'valueInteger', 'valueCodeableConcept', 'valueBoolean', 'valueDateTime', 'valueString'].some(k => r[k] != null)) { skipped.none++; return null; }   // "results not available" placeholder
    const ics = kids(o, 'interpretationCode').filter(ic => at(ic, 'code')); if (ics.length) r.interpretation = ics.map(ic => flagCode(at(ic, 'code')) || { text: at(ic, 'code') });
    const rr = path(o, 'referenceRange', 'observationRange');
    if (rr) {
      const rv = kid(rr, 'value'); const lo = rv && kid(rv, 'low'), hi = rv && kid(rv, 'high'); const unit = at(lo, 'unit') || at(hi, 'unit') || undefined;
      const range = { text: tx(kid(rr, 'text')) || undefined };
      if (lo && isNum(at(lo, 'value'))) range.low = qty(at(lo, 'value'), unit); if (hi && isNum(at(hi, 'value'))) range.high = qty(at(hi, 'value'), unit);
      if (!range.low && !range.high) { const rt = range.text || (rv && (tx(rv) || at(rv, 'value'))) || ''; if (rt) { range.text = range.text || rt; const pr = parseRange(rt, (r.valueQuantity || {}).unit); if (pr) { if (pr.low) range.low = pr.low; if (pr.high) range.high = pr.high; } } }
      if (range.text || range.low || range.high) r.referenceRange = [range];
    }
    const sp = path(o, 'specimen', 'specimenRole', 'specimenPlayingEntity', 'code'); if (sp) r.specimen = { display: at(sp, 'displayName') || tx(kid(sp, 'originalText')) || txt(sp) };
    const perf = path(o, 'performer', 'assignedEntity', 'representedOrganization', 'name') || path(o, 'author', 'assignedAuthor', 'representedOrganization', 'name');
    if (perf) r.performer = [{ display: txt(perf) }];
    kids(o, 'entryRelationship').forEach(er => { const a = kid(er, 'act'); if (a && at(kid(a, 'code'), 'code') === '48767-8') { const t = tx(kid(a, 'text')); if (t) (r.note = r.note || []).push({ text: t }); } });
    return r;
  };

  const isNoteDoc = docLoinc && !SUMMARY_DOC_CODES.has(docLoinc);
  const noteParts = [];
  const sections = all(root, 'section');
  sections.forEach((sec, si) => {
    const stitle = txt(kid(sec, 'title')) || (code(kid(sec, 'code')) || {}).text || 'Section ' + (si + 1);
    const scode = at(kid(sec, 'code'), 'code');
    let type = null; for (const [t, tpl, codes] of SEC) if (hasTpl(sec, tpl) || codes.includes(scode)) { type = t; break; }
    if (!type && SEC_TITLE_RESULTS.test(stitle)) type = 'results';
    const entries = kids(sec, 'entry');
    const locBase = 'section "' + stitle + '"';
    let made = 0;
    const add = (r, i) => { addResource(r, file, { locator: locBase + ' › entry ' + (i + 1) }, pKey, report); made++; return r; };

    // results / vitals: an organizer may hold observations or further organizers
    const doOrganizer = (org, cat, i, parentTime, isResults) => {
      const orgTime = ts(kid(org, 'effectiveTime')) || parentTime;
      const obs = [];
      kids(org, 'component').forEach(c => {
        const sub = kid(c, 'organizer'); if (sub) { doOrganizer(sub, cat, i, orgTime, isResults); return; }
        const oe = kid(c, 'observation') || (kid(c, 'act') && null); if (!oe) return;
        const ob = obsFrom(oe, cat, orgTime); if (ob) obs.push(ob);
      });
      if (cat === 'vital-signs') {                          // combine systolic/diastolic into a FHIR BP panel
        const has = (o, c) => (o.code.coding || []).some(x => x.code === c);
        const sys = obs.find(o => has(o, '8480-6') && o.valueQuantity), dia = obs.find(o => has(o, '8462-4') && o.valueQuantity);
        if (sys && dia) {
          const bp = { resourceType: 'Observation', status: sys.status, category: sys.category, code: { coding: [{ system: LOINC, code: '85354-9', display: 'Blood pressure panel with all children optional' }], text: 'Blood pressure' }, effectiveDateTime: sys.effectiveDateTime || dia.effectiveDateTime,
            component: [{ code: sys.code, valueQuantity: sys.valueQuantity }, { code: dia.code, valueQuantity: dia.valueQuantity }] };
          obs.splice(obs.indexOf(sys), 1); obs.splice(obs.indexOf(dia), 1); obs.push(bp);
        }
      }
      const refs = obs.map(o => add(o, i));
      if (isResults && refs.length) {
        const dr = { resourceType: 'DiagnosticReport', status: CDA_OBS_STATUS[statusOf(org)] === 'cancelled' ? 'cancelled' : 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB', display: 'Laboratory' }] }], code: code(kid(org, 'code')) || { text: 'Lab panel' }, effectiveDateTime: orgTime || refs[0].effectiveDateTime, result: refs.map(o => ({ reference: 'urn:uuid:' + o.id, display: codeText(o.code) })) };
        add(dr, i);
      }
    };

    const handle = (el, i) => {
      const planned = at(el, 'moodCode') && at(el, 'moodCode') !== 'EVN';          // orders / plans are not results
      if (type === 'results' || type === 'vitals' || type === 'social' || type === 'survey' || type === 'functional' || (!type && !planned && (el.localName === 'organizer' || el.localName === 'observation'))) {
        const cat = type === 'vitals' ? 'vital-signs' : type === 'social' ? 'social-history' : type === 'survey' ? 'survey' : type === 'functional' ? 'functional' : !type ? 'exam' : 'laboratory';
        const made0 = made;
        if (el.localName === 'organizer') doOrganizer(el, cat, i, null, type === 'results');
        else if (el.localName === 'observation') { const ob = obsFrom(el, cat, null); if (ob) add(ob, i); }
        else all(el, 'observation').forEach(o => { const ob = obsFrom(o, cat, ts(kid(el, 'effectiveTime'))); if (ob) add(ob, i); });
        if (made === made0 && !skipped.nullified) addUnstructured(txt(el), file, { locator: locBase + ' › entry ' + (i + 1) }, pKey, report);
        return;
      }
      if (type === 'problems') {
        const obsAll = (el.localName === 'observation' ? [el] : []).concat(all(el, 'observation'));
        const isMeta = o => hasTpl(o, [T.PROBLEM_STATUS, T.HEALTH_STATUS, T.AGE_OBS]) || ['33999-4', '445518008', '11323-3'].includes(at(kid(o, 'code'), 'code'));
        let cands = obsAll.filter(o => hasTpl(o, [T.PROBLEM_OBS]));
        if (!cands.length) cands = obsAll.filter(o => !isMeta(o) && kid(o, 'value')).filter((o, _, a) => !a.some(p => p !== o && within(p, o)));
        const actFlag = el.localName === 'act' ? statusOf(el) : '';
        cands.forEach(o => {
          const v = kid(o, 'value'); let cc = code(v);
          if (!cc) { const t = tx(kid(o, 'text')); cc = t ? { text: t } : null; }
          if (!cc) return;
          const GENERIC_PROBLEM = ['55607006', '64572001', '404684003', '282291009', '418799008', '75326-9', '29308-4'];       // "problem", "condition", "finding", "diagnosis" ...
          if (isNoneStatement(cc) || (at(o, 'negationInd') === 'true' && ((cc.coding || []).some(c => GENERIC_PROBLEM.includes(c.code)) || /^(problem|condition|diagnos[ie]s|finding)s?$/i.test(cc.text || '') || NONE_RE.test(tx(kid(o, 'text')))))) { skipped.none++; return; }
          const r = { resourceType: 'Condition', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item', display: 'Problem List Item' }] }], code: cc };
          const eff = kid(o, 'effectiveTime') || kid(el, 'effectiveTime'); const on = ts(eff), ab = tsHigh(eff); if (on) r.onsetDateTime = on; if (ab) r.abatementDateTime = ab;
          const so = obsAll.find(x => x !== o && within(o, x) && isMeta(x) && at(kid(x, 'code'), 'code') === '33999-4');
          const sv = so && kid(so, 'value'); const sname = sv ? (at(sv, 'displayName') || tx(kid(sv, 'originalText'))) : '';
          let cs = (sv && CDA_STATUS_CODE[at(sv, 'code')]) || (sname && (/resolv/i.test(sname) ? 'resolved' : /inactive/i.test(sname) ? 'inactive' : /active/i.test(sname) ? 'active' : null)) || null;
          if (!cs) cs = ab ? 'resolved' : actFlag === 'completed' ? 'resolved' : (actFlag === 'aborted' || actFlag === 'cancelled') ? 'inactive' : 'active';
          if (at(o, 'negationInd') === 'true') { r.verificationStatus = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'refuted' }] }; cs = 'inactive'; }
          r.clinicalStatus = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: cs }] };
          add(r, i);
        });
        return;
      }
      if (type === 'meds' && el.localName === 'substanceAdministration') {
        const st = statusOf(el);
        if (st === 'nullified') { skipped.nullified++; return; }
        const mm = path(el, 'consumable', 'manufacturedProduct', 'manufacturedMaterial');
        const insEl = all(el, 'substanceAdministration').find(a => a !== el && hasTpl(a, ['2.16.840.1.113883.10.20.22.4.147'])); const insTxt = insEl ? tx(kid(insEl, 'text')) : '';
        const cc = code(kid(mm, 'code')) || {}; if (!cc.text) cc.text = txt(kid(mm, 'name')) || tx(path(el, 'consumable', 'manufacturedProduct', 'text')) || undefined;
        if (!cc.coding && !cc.text) { const free = insTxt || tx(kid(el, 'text')); if (free && !NONE_RE.test(free)) cc.text = free.length > 160 ? free.slice(0, 157) + '...' : free; }   // free-text medication, no product coded
        if ((!cc.coding && !cc.text) || isNoneStatement(cc)) { skipped.negatedMed++; return; }          // "no known medications"
        const notTaken = at(el, 'negationInd') === 'true';                                              // a real drug that the patient is NOT taking / refused
        const mood = at(el, 'moodCode'); const intent = mood === 'INT' || mood === 'RQO' || mood === 'PRP';
        const ets = kids(el, 'effectiveTime'); const isFreq = e => /^(PIVL|EIVL)/.test(xtype(e)) || !!kid(e, 'period') || !!kid(e, 'phase');
        const periodEl = ets.find(e => !isFreq(e)), freqEl = ets.find(isFreq);
        const start = periodEl ? ts(periodEl) : null, end = periodEl ? tsHigh(periodEl) : null;
        let sig = insTxt || tx(kid(el, 'text'));
        if (!sig) {
          const dq = kid(el, 'doseQuantity'); const unitName = at(kid(el, 'administrationUnitCode'), 'displayName');
          const dose = dq && at(dq, 'value') ? at(dq, 'value') + ' ' + (unitOf(dq) || unitName || '') : '';
          const per = freqEl && kid(freqEl, 'period'); const freq = per && at(per, 'value') ? (at(per, 'value') === '1' && at(per, 'unit') === 'd' ? 'daily' : 'every ' + at(per, 'value') + ' ' + at(per, 'unit')) : '';
          const ins = kids(el, 'entryRelationship').map(er => kid(er, 'act')).find(a => a && hasTpl(a, [T.INSTRUCTIONS])); const insT = ins ? tx(kid(ins, 'text')) : '';
          sig = [dose.trim(), at(kid(el, 'routeCode'), 'displayName'), freq, insT].filter(Boolean).join(', ');
        }
        const stopped = st === 'aborted' || st === 'cancelled', hold = st === 'suspended' || st === 'held';
        const past = end && Date.parse(end) < Date.now();
        const status = notTaken ? 'not-taken' : stopped ? 'stopped' : hold ? 'on-hold' : (st === 'completed' || past) ? 'completed' : 'active';
        const r = intent && !notTaken ? { resourceType: 'MedicationRequest', status: stopped ? 'stopped' : hold ? 'on-hold' : st === 'completed' ? 'completed' : 'active', intent: 'plan', medicationCodeableConcept: cc, authoredOn: start || undefined }
          : { resourceType: 'MedicationStatement', status, medicationCodeableConcept: cc, effectivePeriod: start || end ? { start: start || undefined, end: end || undefined } : undefined };
        if (sig) { if (r.resourceType === 'MedicationRequest') r.dosageInstruction = [{ text: sig }]; else r.dosage = [{ text: sig }]; }
        add(r, i); return;
      }
      if (type === 'allergies') {
        const act = el.localName === 'act' ? el : null; const actSt = act ? statusOf(act) : '';
        let obsList = all(el, 'observation').filter(o => hasTpl(o, [T.ALLERGY_OBS])); if (!obsList.length && el.localName === 'observation') obsList = [el];
        if (!obsList.length) obsList = all(el, 'observation').filter(o => kid(o, 'participant'));
        const CLIN = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
        let nka = false;
        obsList.forEach(o => {
          if (at(o, 'negationInd') === 'true') { nka = true; return; }
          const pe = path(o, 'participant', 'participantRole', 'playingEntity');
          const cc = (pe && (code(kid(pe, 'code')) || (tx(kid(pe, 'name')) ? { text: tx(kid(pe, 'name')) } : null))) || code(kid(o, 'value')) || { text: 'Allergy' };
          if (pe && !cc.text) cc.text = tx(kid(pe, 'name')) || undefined;
          const kidsObs = all(o, 'observation').filter(x => x !== o);
          const so = kidsObs.find(x => at(kid(x, 'code'), 'code') === '33999-4'); const sv = so && kid(so, 'value');
          const eff = kid(o, 'effectiveTime'); const high = tsHigh(eff);
          const cs = (sv && CDA_STATUS_CODE[at(sv, 'code')]) || (sv && /resolv/i.test(at(sv, 'displayName')) ? 'resolved' : sv && /inactive/i.test(at(sv, 'displayName')) ? 'inactive' : null) || (high ? 'resolved' : (actSt === 'completed' || actSt === 'aborted' || actSt === 'cancelled') ? 'inactive' : 'active');
          const r = { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ system: CLIN, code: cs }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] }, code: cc };
          const on = ts(eff); if (on) r.onsetDateTime = on;
          const vt = code(kid(o, 'value')); const vcode = ((vt && vt.coding) || [])[0]; const vtxt = (vt && vt.text) || '';
          let cat = vcode && Object.prototype.hasOwnProperty.call(CDA_ALLERGY_CAT, vcode.code) ? CDA_ALLERGY_CAT[vcode.code] : null;
          if (!cat) cat = /food/i.test(vtxt) ? 'food' : /drug|medication/i.test(vtxt) ? 'medication' : /environment/i.test(vtxt) ? 'environment' : null;
          if (!cat && pe && ((code(kid(pe, 'code')) || {}).coding || []).some(c => /rxnorm|ndfrt|nui|ndc/i.test(String(c.system)) || /\.6\.88$|\.6\.209$/.test(String(c.system)))) cat = 'medication';
          if (cat) r.category = [cat];
          if (vcode && CDA_ALLERGY_TYPE[vcode.code]) r.type = CDA_ALLERGY_TYPE[vcode.code];
          const reacts = kidsObs.filter(x => hasTpl(x, [T.REACTION]));
          const sevs = kidsObs.filter(x => hasTpl(x, [T.SEVERITY]));
          const sevOf = x => { const s = kid(x, 'value'); const t = ((s && (at(s, 'displayName') || tx(kid(s, 'originalText')))) || '').toLowerCase(); const m = t.match(/mild|moderate|severe/); return m ? m[0] : ({ '255604002': 'mild', '6736007': 'moderate', '24484000': 'severe' }[at(s, 'code')] || undefined); };
          if (reacts.length) {
            const rx = reacts.map(x => ({ manifestation: [code(kid(x, 'value')) || { text: tx(kid(x, 'text')) || 'Reaction' }], severity: (() => { const sx = kidsObs.find(y => hasTpl(y, [T.SEVERITY]) && within(x, y)); return sx ? sevOf(sx) : undefined; })() }));
            const topSev = sevs.find(y => !reacts.some(x => within(x, y))); if (topSev) rx.forEach(x => { x.severity = x.severity || sevOf(topSev); });
            r.reaction = rx.length > 1 && rx.every(x => x.severity === rx[0].severity) ? [{ manifestation: rx.map(x => x.manifestation[0]), severity: rx[0].severity }] : rx;
          } else if (sevs.length) r.reaction = [{ manifestation: [{ text: 'Reaction' }], severity: sevOf(sevs[0]) }];
          add(r, i);
        });
        if (nka && !obsList.some(o => at(o, 'negationInd') !== 'true')) add({ resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ system: CLIN, code: 'active' }] }, code: { coding: [{ system: SCT, code: '716186003', display: 'No known allergy' }], text: 'No known allergies' } }, i);
        return;
      }
      if (type === 'imms' && el.localName === 'substanceAdministration') {
        const st = statusOf(el); if (st === 'nullified') { skipped.nullified++; return; }
        if (/^(INT|RQO|PRP|PRMS)$/.test(at(el, 'moodCode'))) { skipped.planned++; return; }
        const mm = path(el, 'consumable', 'manufacturedProduct', 'manufacturedMaterial');
        const vc = code(kid(mm, 'code'));
        if (!vc && !txt(kid(mm, 'name'))) { skipped.none++; return; }                        // empty placeholder entry
        const generic = !vc || isNoneStatement(vc) || !(vc.coding || []).some(c => c.code && c.code !== '71181003');
        if (at(el, 'negationInd') === 'true' && generic) { skipped.none++; return; }      // "no immunizations on record"
        const notDone = at(el, 'negationInd') === 'true' || st === 'aborted' || st === 'cancelled';
        const r = { resourceType: 'Immunization', status: notDone ? 'not-done' : 'completed', vaccineCode: code(kid(mm, 'code')) || { text: txt(kid(mm, 'name')) || 'Vaccine' }, occurrenceDateTime: ts(kid(el, 'effectiveTime')) || undefined };
        if (!r.occurrenceDateTime) r.occurrenceString = 'unknown';
        const lot = txt(kid(mm, 'lotNumberText')); if (lot) r.lotNumber = lot;
        const mf = txt(path(el, 'consumable', 'manufacturedProduct', 'manufacturerOrganization', 'name')); if (mf) r.manufacturer = { display: mf };
        const dq = kid(el, 'doseQuantity'); if (dq && at(dq, 'value') && isNum(at(dq, 'value'))) r.doseQuantity = qty(at(dq, 'value'), unitOf(dq));
        add(r, i); return;
      }
      if (type === 'procs') {
        const st = statusOf(el); if (st === 'nullified') { skipped.nullified++; return; }
        const mood = at(el, 'moodCode');
        { const pc = code(kid(el, 'code')) || { text: tx(kid(el, 'text')) }; if (isNoneStatement(pc)) { skipped.none++; return; } }
        const r = { resourceType: 'Procedure', status: at(el, 'negationInd') === 'true' || st === 'aborted' || st === 'cancelled' ? 'not-done' : st === 'active' ? 'in-progress' : /^(INT|RQO|PRP)$/.test(mood) ? 'preparation' : 'completed', code: code(kid(el, 'code')) || { text: tx(kid(el, 'text')) || 'Procedure' } };
        const eff = kid(el, 'effectiveTime'); const s = ts(eff), e = tsHigh(eff); if (s && e && e !== s) r.performedPeriod = { start: s, end: e }; else if (s) r.performedDateTime = s;
        const bs = code(kid(el, 'targetSiteCode')); if (bs) r.bodySite = [bs];
        add(r, i); return;
      }
      if (type === 'encs' && el.localName === 'encounter') {
        const eff = kid(el, 'effectiveTime'); const st = statusOf(el); const tc = code(kid(el, 'code')) || { text: 'Encounter' };
        const ac = (tc.coding || []).find(c => /v3-ActCode/.test(String(c.system)) && CDA_ACT_CLASS.test(c.code));
        const r = { resourceType: 'Encounter', status: st === 'active' ? 'in-progress' : (st === 'cancelled' || st === 'aborted') ? 'cancelled' : 'finished', class: ac ? { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: ac.code, display: ac.display } : { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' }, type: [tc], period: { start: ts(eff) || undefined, end: tsHigh(eff) || undefined } };
        const loc = path(el, 'participant', 'participantRole', 'playingEntity', 'name'); if (loc) r.location = [{ location: { display: txt(loc) } }];
        const dx = all(el, 'observation').map(o => code(kid(o, 'value'))).filter(Boolean); if (dx.length) r.reasonCode = dx;
        add(r, i); return;
      }
      if (type === 'notes' || hasTpl(el, [T.NOTE_ACT])) {
        const nc = code(kid(el, 'code')) || {};
        let body = tx(kid(el, 'text')); if (!body && entries.length === 1) body = narrative(sec);
        const r = makeDoc({ title: nc.text || stitle, date: ts(kid(el, 'effectiveTime')), author: personName(path(el, 'author', 'assignedAuthor', 'assignedPerson', 'name')), custodian, body });
        add(r, i); return;
      }
    };
    entries.forEach((en, i) => {
      const el0 = Array.from(en.childNodes).find(n => n.nodeType === 1); if (!el0) return;
      // medications / immunizations are sometimes wrapped in an organizer or act (varied dosing, grouped doses): handle each administration itself
      if ((type === 'meds' || type === 'imms') && el0.localName !== 'substanceAdministration') { const sas = all(el0, 'substanceAdministration').filter(a => !all(el0, 'substanceAdministration').some(o => o !== a && within(o, a))); if (sas.length) { sas.forEach(a => handle(a, i)); return; } }
      handle(el0, i);
    });
    const narr = narrative(sec);
    if (isNoteDoc) { if (narr) noteParts.push(stitle.toUpperCase() + ':\n' + narr); }
    else if (made === 0 && narr && !kids(sec, 'component').length) {
      addUnstructured(stitle.toUpperCase() + '\n' + narr, file, { locator: locBase + ' (narrative only)' }, pKey, report, { label: 'Narrative-only section: ' + stitle, date: null });
    }
  });
  if (isNoteDoc) {
    const kind = docKind({ resourceType: 'DocumentReference', type: docCode, description: docTitle });
    const body = [docTitle.toUpperCase(), 'Date: ' + (docDate || 'unknown') + (author ? '    Author: ' + author : '') + (custodian ? '    Facility: ' + custodian : ''), ''].concat(noteParts.join('\n\n')).join('\n');
    const r = makeDoc({ title: docTitle, date: docDate, author, custodian, body, loincCode: docLoinc, loincDisplay: docCode.text });
    if (kind === 'unstructured') return;
    addResource(r, file, { locator: 'ClinicalDocument (whole document narrative)' }, pKey, report);
  }
  const nb = path(root, 'component', 'nonXMLBody', 'text');
  if (nb) { const mt = at(nb, 'mediaType'); let body = txt(nb); if (at(nb, 'representation') === 'B64') { try { body = b64ToUtf8(body.replace(/\s/g, '')); } catch (e) { } }
    if (/text|html/.test(mt) || !mt) addResource(makeDoc({ title: docTitle, date: docDate, author, custodian, body: /html/.test(mt) ? htmlToText(body) : body, loincCode: docLoinc, loincDisplay: docCode.text }), file, { locator: 'nonXMLBody' }, pKey, report);
    else addUnstructured('Embedded ' + mt + ' document body (not text) in ' + docTitle, file, { locator: 'nonXMLBody' }, pKey, report, { date: docDate }); }
  if (skipped.nullified) report.warnings.push(skipped.nullified + ' entr' + (skipped.nullified === 1 ? 'y' : 'ies') + ' with status "nullified" (entered in error) were not imported.');
  if (skipped.none) report.skipped = Object.assign(report.skipped || {}, { noneStatements: skipped.none });
  if (skipped.planned) report.warnings.push(skipped.planned + ' planned or proposed immunization(s) were not imported.');
  if (skipped.negatedMed) report.skipped = Object.assign(report.skipped || {}, { negatedOrEmptyMedications: skipped.negatedMed });
}

/* ================= printed / exported text (PDF, TXT, HTML) ================= */
const HEADINGS = [
  ['labs', /^(LABORATORY RESULTS|LABORATORY|LAB RESULTS|LABS|TEST RESULTS|CHEMISTRY ?\/ ?HEMATOLOGY|CHEMISTRY|HEMATOLOGY|LAB(ORATORY)? DATA|RESULTS)$/],
  ['vitals', /^(VITAL SIGNS|VITALS)\b/],
  ['func', /^(FUNCTIONAL STATUS|FUNCTIONAL ASSESSMENT|PERFORMANCE STATUS|FUNCTIONAL STATUS ASSESSMENT)$/],
  ['notes', /^(PROGRESS NOTES|CLINICAL NOTES|VISIT NOTES|NOTES|CONSULTS?|CONSULT NOTES|DISCHARGE SUMMAR(Y|IES)|ADMISSION NOTES)$/],
  ['radiology', /^(RADIOLOGY|RADIOLOGY REPORTS?|IMAGING|IMAGING REPORTS?|IMAGING RESULTS)$/],
  ['pathology', /^(SURGICAL PATHOLOGY|PATHOLOGY|PATHOLOGY REPORTS?|ANATOMIC PATHOLOGY|CYTOLOGY)$/],
  ['allergies', /^(ALLERGIES|ALLERGY|ALLERGIES AND ADVERSE REACTIONS|ADVERSE REACTIONS|ALLERGIES AS OF .*)$/],
  ['problems', /^(PROBLEM LIST|PROBLEMS|ACTIVE PROBLEMS|DIAGNOSES)$/],
  ['meds', /^(MEDICATIONS|CURRENT MEDICATIONS|MEDICATION HISTORY|ACTIVE MEDICATIONS|MEDICATION LIST|OUTPATIENT MEDICATIONS|PRESCRIPTIONS)$/],
  ['imms', /^(IMMUNIZATIONS|VACCINATIONS|IMMUNIZATION HISTORY)$/],
  ['appts', /^(APPOINTMENTS|UPCOMING APPOINTMENTS|APPOINTMENTS \(FUTURE\)|FUTURE APPOINTMENTS)$/],
];
function headingOf(t) {
  let s = t.trim().replace(/^[=\-*#\s]+|[=\-*#\s]+$/g, '').replace(/^VA\s+/i, '');
  if (!s || s.length > 60 || /:\s*\S/.test(s.replace(/\([^)]*\)/g, ""))) return null;
  const S = s.toUpperCase().replace(/\s+/g, ' ');
  const SV = S.replace(/\s*\(.*\)$/, '');
  for (const [type, re] of HEADINGS) if (re.test(S) || re.test(SV)) return { type, date: parseDT(s) };
  return null;
}
const VITAL_RES = [
  ['bp', /\b(?:BP|Blood Pressure)\b[:\s]+(\d{2,3})\s*\/\s*(\d{2,3})/i],
  ['spo2', /\b(?:SpO2|Pulse Ox(?:imetry)?|O2 Sat(?:uration)?)\b[:\s]+(\d{2,3})\s*%?/i],
  ['hr', /\b(?:Pulse(?!\s*Ox)|HR|Heart Rate)\b[:\s]+(\d{2,3})\b/i],
  ['rr', /\b(?:Resp(?:iratory)?(?: Rate)?|RR)\b[:\s]+(\d{1,2})\b/i],
  ['temp', /\b(?:Temp(?:erature)?)\b[:\s]+(\d{2,3}(?:\.\d+)?)\s*(?:°|deg)?\s*([FC])?\b/i],
  ['wt', /\b(?:Wt|Weight)\b[:\s]+(\d{2,3}(?:\.\d+)?)\s*(lbs?|kg)?\b/i],
  ['ht', /\b(?:Ht|Height)\b[:\s]+(\d{2,3}(?:\.\d+)?)\s*(in|cm)\b/i],
  ['bmi', /\bBMI\b[:\s]+(\d{2}(?:\.\d+)?)/i],
  ['pain', /\bPain(?: Score)?\b[:\s]+(\d{1,2})\b/i],
];
/* performance-scale scores in printed text: "ECOG: 1", "ECOG Performance Status 2", "Karnofsky 80%", "KPS: 70", "Lansky 90", "PPS 60%" */
const FUNC_RES = [
  ['ecog', /\b(?:ECOG|Zubrod|WHO)(?:\s+performance)?(?:\s+(?:status|score|grade|PS))?\s*(?:[:=\-–]|is|of)?\s*(?:grade\s*)?([0-5])\b(?!\s*[\/.]\s*\d)/i],
  ['karnofsky', /\b(?:Karnofsky(?:\s+performance)?(?:\s+(?:status|score|scale|index))?|KPS)\s*(?:[:=\-–]|is|of)?\s*(\d{1,3})\s*%?(?![\d.])/i],
  ['lansky', /\bLansky(?:\s+(?:play[\s-]*performance|performance))?(?:\s+(?:status|score|scale))?\s*(?:[:=\-–]|is|of)?\s*(\d{1,3})\s*%?(?![\d.])/i],
  ['pps', /\b(?:Palliative Performance(?:\s+(?:Scale|Status|Score))?|PPS)\s*(?:[:=\-–]|is|of)?\s*(\d{1,3})\s*%?(?![\d.])/i],
];
function makeFunc(scale, m, date) {
  const sc = FUNC_SCALES[scale]; const v = +m[1]; if (isNaN(v) || v > sc.max || (sc.step > 1 && v % 5)) return null;
  const code = { ecog: ['89247-1', 'ECOG Performance Status score'], karnofsky: ['89243-0', 'Karnofsky Performance Status score'] }[scale];
  const r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: 'survey', display: 'Survey' }] }, { coding: [{ system: CS_LOCAL, code: FUNC_CAT, display: 'Functional status' }] }],
    code: code ? { coding: [{ system: LOINC, code: code[0], display: code[1] }], text: sc.name } : { text: sc.name }, valueQuantity: { value: v, unit: 'score', system: UCUM, code: '{score}' } };
  if (date) r.effectiveDateTime = date; return r;
}
function funcInLine(t, date, file, L, pKey, report, strict) {   // returns the number of scores found on the line
  let n = 0;
  for (const [k, re] of FUNC_RES) { if (strict && !new RegExp('^\\s*' + re.source, 'i').test(t)) continue; const m = t.match(re); if (!m) continue; const r = makeFunc(k, m, date); if (r) { addResource(r, file, L, pKey, report); n++; } }
  return n;
}
function makeVital(kind, m, date) {
  const [code, display] = VITAL[kind];
  const r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: 'vital-signs', display: 'Vital Signs' }] }], code: { coding: [{ system: LOINC, code, display }], text: display } };
  if (date) r.effectiveDateTime = date;
  if (kind === 'bp') r.component = [
    { code: { coding: [{ system: LOINC, code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: qty(m[1], 'mmHg') },
    { code: { coding: [{ system: LOINC, code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: qty(m[2], 'mmHg') }];
  else if (kind === 'temp') { const u = (m[2] || (+m[1] > 45 ? 'F' : 'C')).toUpperCase(); r.valueQuantity = qty(m[1], u === 'F' ? '°F' : '°C'); }
  else if (kind === 'wt') r.valueQuantity = qty(m[1], m[2] ? (/kg/i.test(m[2]) ? 'kg' : 'lb') : 'lb');
  else if (kind === 'ht') r.valueQuantity = qty(m[1], m[2]);
  else if (kind === 'hr') r.valueQuantity = qty(m[1], 'bpm');
  else if (kind === 'rr') r.valueQuantity = qty(m[1], 'breaths/min');
  else r.valueQuantity = qty(m[1], VITAL[kind][2]);
  return r;
}
/* ---- lab rows in printed / PDF text ----
   A row is: name, result (number, comparator, or a qualitative word), and optionally unit, flag, range in any order.
   Cells are normally separated by 2+ spaces; single-space layouts ("Sodium 141 mmol/L [136-145]") are read too. */
const QUAL = /^(?:POS(?:ITIVE)?|NEG(?:ATIVE)?|TRACE|NORMAL|ABNORMAL|PRESENT|ABSENT|(?:NOT[ -]|NON-?)DETECTED|DETECTED|NONE(?: SEEN| DETECTED)?|FEW|MODERATE|MANY|RARE|OCCASIONAL|SMALL|LARGE|(?:NON-?)?REACTIVE|INDETERMINATE|EQUIVOCAL|BORDERLINE|CLEAR|CLOUDY|SLIGHTLY CLOUDY|HAZY|TURBID|(?:PALE |LIGHT |DARK )?(?:YELLOW|AMBER|STRAW|RED|ORANGE|BROWN|GREEN)|COLORLESS|ADEQUATE|INADEQUATE|(?:NON-?)?IMMUNE|NOT DONE|[1-4]\+|\+{1,4})$/i;
const FLAG_TAIL1 = /\s*[(\[]\s*(HH|LL|AA|H|L|A|\*)\s*[)\]]\s*$/i, FLAG_TAIL2 = /\s+(HH|LL|AA|H\*?|L\*?|A|\*)\s*$/i;
const isUnitTok = u => /^[A-Za-z%µμ‰\/*^\[\]\d.()-]+$/.test(u) && /[A-Za-z%µμ\/‰]/.test(u) && !FLAG_RE.test(u) && !QUAL.test(u) && !/^(?:and|or|the|of|to|on|at|in|is|by|for|with|from|today|normal|final|pending)$/i.test(u);
const isUnitStrict = u => isUnitTok(u) && (UCUM_MAP[u.toLowerCase()] != null || /\/|%|‰|^x?10[*^E]/i.test(u) || /^(?:mg|g|ug|mcg|ng|pg|kg|ml|l|dl|fl|mmol|umol|nmol|meq|iu|miu|uiu|u|sec|min|mm|cm|lb|lbs|ppm)$/i.test(u));
function parseResultCell(cell, strictUnit) {                  // "5.4", "<0.10", "212 mg/dL (H)", "5.4 H", "Negative", "1+", "Not Detected"
  let s = String(cell == null ? '' : cell).replace(/\s+/g, ' ').trim(); if (!s) return null;
  let flag = '', m = s.match(FLAG_TAIL1) || s.match(FLAG_TAIL2);
  if (m && m.index > 0) { flag = m[1]; s = s.slice(0, m.index).trim(); }
  if (QUAL.test(s)) return { comparator: '', value: s, numeric: false, flag, unit: '' };
  m = s.match(/^([<>]=?|≤|≥)?\s*(-?\d+(?:\.\d+)?)(?:\s*(\S.*))?$/); if (!m) return null;
  const out = { comparator: (m[1] || '').replace('≤', '<=').replace('≥', '>='), value: m[2], numeric: true, flag, unit: '' };
  if (m[3]) {
    const toks = m[3].trim().split(' '); const ok = strictUnit ? isUnitStrict : isUnitTok;
    if (toks.length === 1 && ok(toks[0])) out.unit = toks[0];
    else if (toks.length === 2 && FLAG_RE.test(toks[0]) && ok(toks[1])) { out.flag = out.flag || toks[0]; out.unit = toks[1]; }
    else return null;
  }
  return out;
}
const RANGE_TAIL = /^(.*?)\s+((?:[\[(]\s*)?(?:(?:[<>]=?|≤|≥)\s*-?\d+(?:\.\d+)?|-?\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*-?\d+(?:\.\d+)?)(?:\s*[\])])?)$/;
const cleanRange = c => String(c).trim().replace(/^[\[(]\s*/, '').replace(/\s*[\])]$/, '');
const isNameCell = c => /^[A-Za-z]/.test(c) && c.length <= 60 && !/:$/.test(c) && !FLAG_RE.test(c);
function splitNameValue(cell, onlyCell) {                    // "Specific Gravity 1.020", "Hemoglobin A1c 8.4 H", "Sodium 141 mmol/L [136-145]"
  const bounds = []; for (let i = 0; i < cell.length; i++) if (cell[i] === ' ' && cell[i + 1] !== ' ') bounds.push(i);
  for (const b of bounds) {
    const name = cell.slice(0, b).trim(), tail = cell.slice(b + 1).trim();
    if (!/^[A-Za-z]/.test(name) || !/[A-Za-z0-9)\]%.]$/.test(name) || name.length > 45 || name.split(' ').length > 6 || QUAL.test(name)) continue;
    let valuePart = tail, range = '';
    const rm = tail.match(RANGE_TAIL); if (rm && isRange(rm[2])) { valuePart = rm[1]; range = rm[2]; }
    const res = parseResultCell(valuePart, onlyCell); if (!res) continue;
    if (onlyCell) { if (!res.numeric && (range || res.unit)) continue; if (!res.numeric && name.split(' ').length > 3) continue; if (res.numeric && !range && !res.unit && !res.flag) continue; }
    return { name, res, range };
  }
  return null;
}
const PANEL_SMALL = /^(?:with|and|of|for|in|by|w\/|w\/o|without|panel|profile|test|tests|reflex|differential|diff|auto|manual|fasting|random|screen|total|serum|plasma|urine|blood)$/i;
const isPanelTitle = t => t.length <= 50 && !/\d/.test(t) && !/\s{2,}/.test(t) && !KV_RE.test(t) && /^[A-Za-z]/.test(t) && !/[.!?]$/.test(t) && t.split(/\s+/).length <= 6 && !t.split(/\s+/).some(w => /^[a-z]/.test(w) && !PANEL_SMALL.test(w));   // a title, not a sentence
function parseLabRow(line) {
  const cells = line.replace(/\t/g, '  ').trim().split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (!cells.length) return null;
  let name, res, rest = cells.slice(1), range = '';
  if (cells.length >= 2 && isNameCell(cells[0]) && (res = parseResultCell(cells[1]))) name = cells[0], rest = cells.slice(2);
  else { res = null; const sp = splitNameValue(cells[0], cells.length === 1); if (!sp) return null; name = sp.name; res = sp.res; range = sp.range; }
  if (!isNameCell(name) || name.length > 60) return null;
  let flag = res.flag; const units = [], ranges = range ? [cleanRange(range)] : [];
  if (res.unit) units.push(res.unit);
  for (const c of rest) { if (isRange(c)) { ranges.push(cleanRange(c)); const ru = rangeUnit(c); if (ru && !units.length) units.push(ru); } else if (FLAG_RE.test(c) || /^[(\[](HH|LL|AA|H|L|A)[)\]]$/i.test(c)) flag = c.replace(/[()\[\]]/g, ''); else units.push(c); }
  return { name, comparator: res.comparator, value: res.value, numeric: res.numeric, flag: flag || '', unit: res.numeric ? (units[0] || '') : '', range: ranges[0] || '', extra: units.slice(1) };
}
/* tables with one column per collection date: header "Test   09/14/2026 08:12   06/03/2026 09:00   Units   Ref Range" */
const DATE_CELL = /^(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})(?:[ T@]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?)?$/i;
function cellsPos(line) { const out = []; const re = /\S+(?: \S+)*/g; const t = line.replace(/\t/g, '    '); let m; while ((m = re.exec(t))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length }); return out; }
function dateHeader(line) {
  const dc = [], other = [];
  for (const c of cellsPos(line)) { if (DATE_CELL.test(c.text)) { const iso = parseDT(c.text); if (iso) { dc.push({ start: c.start, end: c.end, iso }); continue; } } other.push(c); }
  if (dc.length < 2 || other.some(c => /\d/.test(c.text))) return null;
  const last = dc[dc.length - 1], after = other.filter(c => c.start >= last.start);
  return { cols: dc, limit: after.length ? Math.min(...after.map(c => c.start)) - 3 : last.end + 4 };
}
function parseMultiRow(line, hdr) {                          // -> { name, range, unit, flag, values: [{ iso, res }] } using character positions
  const cells = cellsPos(line); if (cells.length < 2) return null;
  const first = hdr.cols[0];
  const nameCells = cells.filter(c => c.start < first.start - 2); if (!nameCells.length) return null;
  const name = nameCells.map(c => c.text).join(' '); if (!isNameCell(name) || name.length > 60) return null;
  const used = new Set(), values = [], other = [];
  for (const c of cells) {
    if (nameCells.includes(c)) continue;
    const res = c.start >= first.start - 6 && c.start < hdr.limit ? parseResultCell(c.text) : null;
    if (!res) { other.push(c); continue; }
    const mid = (c.start + c.end) / 2; let best = null, bd = 1e9;
    for (const col of hdr.cols) { const d = Math.abs(mid - (col.start + col.end) / 2); if (d < bd) { bd = d; best = col; } }
    if (!best || bd > Math.max(8, (best.end - best.start) / 2 + 4) || used.has(best)) return null;
    used.add(best); values.push({ iso: best.iso, res });
  }
  if (!values.length) return null;
  let unit = '', range = '', flag = ''; const extra = [];
  for (const c of other) { const t = c.text; if (isRange(t)) { range = range || cleanRange(t); const ru = rangeUnit(t); if (ru && !unit) unit = ru; } else if (FLAG_RE.test(t)) flag = t; else if (!unit) unit = t; else extra.push(t); }
  return { name, range, unit, flag, extra, values };
}
const KV_RE = /^([A-Za-z][A-Za-z0-9 #\/().'&-]{0,40}?):\s*(.*)$/;


/* ---- patient identity in printed / text records ---- */
const NAME_STOP = /^(UNKNOWN|PATIENT|N\/?A|NONE|PROVIDER|PHYSICIAN|DOCTOR|CLINIC|HOSPITAL|DEPARTMENT|LOCATION|DATE|DOB|MRN|SEX|AGE|ADDRESS|PHONE|SIGNATURE|REPORT|RESULTS?|PAGE|PRINTED|CONFIDENTIAL|MEDICAL RECORD|HEALTH|VA|TEST|NOTE|SUMMARY|VISIT)$/;
const NAME_BAD_WORD = /\b(HOSPITAL|CLINIC|MEDICAL|CENTER|HEALTH|SYSTEM|LAB|LABORATORY|DEPARTMENT|SERVICES?|REPORT|RESULTS?|PROVIDER|PHYSICIAN|INSURANCE|PHARMACY|RADIOLOGY|PATHOLOGY|PAGE|PRINTED|FAX|PHONE|ADDRESS|STREET|AVENUE|ROAD|SUITE|MRN|DOB|SEX|AGE)\b/i;
const SUFFIX = /^(JR|SR|II|III|IV|V|MD|DO|PHD|RN|NP|PA|DDS)\.?$/i;
function parseNameValue(v) {
  let t = String(v || '').replace(/\(.*?\)/g, ' ').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim().replace(/^[:#\-\s]+|[,;:.\-\s]+$/g, '');
  t = t.replace(/^(MR|MRS|MS|MISS|DR|MX)\.?\s+/i, '');
  if (!t || t.length < 2 || t.length > 60 || /\d/.test(t) || /[@\/\\<>=_*]/.test(t) || NAME_BAD_WORD.test(t)) return null;
  let family, given;
  if (t.includes(',')) { const [a, b] = t.split(',', 2); family = a.trim(); given = (b || '').trim().split(/\s+/).filter(x => x && !SUFFIX.test(x)); }
  else { const tok = t.split(/\s+/).filter(x => !SUFFIX.test(x)); if (tok.length < 2) { if (tok.length === 1) { family = tok[0]; given = []; } else return null; } else { family = tok.pop(); given = tok; } }
  const ok = w => /^\p{Lu}[\p{L}'.\-]*$/u.test(w);
  if (!family || !ok(family.replace(/\s+/g, '')) || !given.every(ok)) return null;
  if (NAME_STOP.test(family.toUpperCase()) || given.some(g => NAME_STOP.test(g.toUpperCase()))) return null;
  if (family.replace(/[^\p{L}]/gu, '').length < 2) return null;
  if (given.length > 4) return null;
  return { family, given };
}
const ID_KEYS = [
  ['name', 5, /Patient(?:'s)?\s+(?:Full\s+|Legal\s+)?Name/i], ['name', 4, /(?:Pt\.?|Member|Client|Veteran)\s+Name/i], ['name', 4, /Patient|Veteran|Member/i], ['name', 3, /Name|Pt\.?/i], ['name', 1, /RE|Regarding/i],
  ['dob', 5, /D\.?\s?O\.?\s?B\.?(?:\s*\/\s*Age)?|Date\s+of\s+Birth|Birth\s*date|Birth\s+Date|Born/i],
  ['sex', 5, /Sex|Gender|Legal\s+Sex|Sex\s+Assigned\s+at\s+Birth/i],
  ['mrn', 5, /MRN|Med(?:ical)?\.?\s*Rec(?:ord)?\.?\s*(?:#|No\.?|Number)?|Patient\s+ID|Pt\.?\s*ID|ICN|Chart\s*(?:#|No\.?)/i],
];
const ID_LABEL_RE = new RegExp('(?:^|[\\s|;,(])(' + ID_KEYS.map(k => k[2].source).join('|') + ')\\s*(?:[:#]|(?=\\s+\\d))\\s*', 'gi');
const ID_LABEL_TEST = new RegExp(ID_LABEL_RE.source, 'i');
function classifyLabel(lbl) { for (const [k, w, re] of ID_KEYS) { if (new RegExp('^(?:' + re.source + ')$', 'i').test(lbl.trim())) return { k, w }; } return null; }
function sexOf(v) { const s = String(v || '').trim().toUpperCase(); if (/^(M|MALE|MAN)\b/.test(s)) return 'male'; if (/^(F|FEMALE|WOMAN)\b/.test(s)) return 'female'; if (/^(O|OTHER|X|NON-?BINARY)\b/.test(s)) return 'other'; if (/^(U|UNK|UNKNOWN)\b/.test(s)) return 'unknown'; return null; }
function dobOf(v) { const d = findDate(String(v || '').slice(0, 40)); if (!d || d.index > 3) return null; const y = d.iso.slice(0, 10); if (y.length < 10 || y < '1890-01-01' || y > new Date().toISOString().slice(0, 10)) return null; return y; }
function findIdentity(lines, skip) {
  const names = new Map(); const dobs = []; let gender = null, mrn = null; const consume = new Set();
  const addName = (nm, w, i, how) => { if (!nm) return; const k = norm(nm.family) + '|' + (norm(nm.given[0] || '')[0] || ''); const c = names.get(k) || { nm, score: 0, line: i, how, n: 0 }; c.score += w; c.n++; if (!c.nm.given.length && nm.given.length) c.nm = nm; names.set(k, c); };
  const fieldsOf = t => t.split(/\s{2,}|\s*\|\s*|\t/).map(x => x.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].text; const t = raw.trim(); if (!t || t.length > 220) continue;
    // a) "Label: value" pairs anywhere on the line
    const found = []; let m; ID_LABEL_RE.lastIndex = 0;
    while ((m = ID_LABEL_RE.exec(raw))) {
      const c = classifyLabel(m[1]); if (!c) continue; const start = m.index + m[0].indexOf(m[1]);
      // the label must open a field, or follow another identity field ("Name: X  DOB: Y"); this rejects "Allergy Name:", "Provider Name:" and similar
      const before = raw.slice(0, start);
      const fieldStart = (() => { let k = -1; const re = /\s{2,}|\||\t|;|\(/g; let mm; while ((mm = re.exec(before))) k = mm.index + mm[0].length; return k < 0 ? 0 : k; })();
      if (before.slice(fieldStart).trim() && !found.some(f => f.start >= fieldStart)) continue;
      found.push({ c, lbl: m[1], start, vstart: ID_LABEL_RE.lastIndex });
    }
    let lineIds = 0, lineName = null, lineDob = null;
    found.forEach((f, j) => {
      let v = raw.slice(f.vstart, j + 1 < found.length ? found[j + 1].start : raw.length);
      v = v.split(/\s{2,}|\s*\|\s*|\t/)[0].trim();
      if (!v && i + 1 < lines.length && j === found.length - 1 && raw.slice(f.vstart).trim() === '') { const nx = lines.slice(i + 1, i + 3).find(l => l.text.trim()); if (nx) v = fieldsOf(nx.text)[0] || ''; }
      if (f.c.k === 'name') { const nm = parseNameValue(v); if (nm) { lineName = nm; addName(nm, f.c.w, i, 'labelled "' + f.lbl.trim() + '"'); lineIds++; } }
      else if (f.c.k === 'dob') { const d = dobOf(v); if (d) { lineDob = d; dobs.push({ d, i }); lineIds++; } }
      else if (f.c.k === 'sex') { const g = sexOf(v); if (g) { gender = gender || g; lineIds++; } }
      else if (f.c.k === 'mrn') { const mv = (v.match(/^[A-Za-z0-9\-]{3,20}/) || [])[0]; if (mv && /\d/.test(mv)) { mrn = mrn || { label: f.lbl.trim().replace(/\s+/g, ' '), value: mv }; lineIds++; } }
    });
    if (lineName && lineDob) { const k = norm(lineName.family) + '|' + (norm(lineName.given[0] || '')[0] || ''); names.get(k).score += 3; }
    // b) header row of labels with a value row underneath (table layout)
    const hf = fieldsOf(t);
    if (hf.length >= 2 && hf.every(h => /^[A-Za-z .#'\/]+:?$/.test(h)) && hf.some(h => { const c = classifyLabel(h.replace(/:$/, '')); return c && c.k === 'name'; })) {
      const nx = lines.slice(i + 1, i + 3).find(l => l.text.trim());
      if (nx) { const vf = fieldsOf(nx.text); if (vf.length === hf.length) { consume.add(i); consume.add(lines.indexOf(nx)); } if (vf.length === hf.length) hf.forEach((h, j) => { const c = classifyLabel(h.replace(/:$/, '')); if (!c) return; if (c.k === 'name') addName(parseNameValue(vf[j]), c.w + 2, i, 'table column "' + h + '"'); if (c.k === 'dob') { const d = dobOf(vf[j]); if (d) dobs.push({ d, i }); } if (c.k === 'sex') gender = gender || sexOf(vf[j]); if (c.k === 'mrn' && /\d/.test(vf[j])) mrn = mrn || { label: h, value: vf[j] }; }); }
    }
    // c) unlabelled banner lines: "LAST,FIRST M   xxx-xx-1234   DOB ..." or "First M Last | MRN ... | DOB ..."
    if (!found.some(f => f.c.k === 'name')) {
      const f0 = fieldsOf(t)[0] || ''; const hasDob = found.some(f => f.c.k === 'dob') || /\bDOB\b/i.test(t);
      if (hasDob && f0 && !ID_LABEL_TEST.test(f0)) { const nm = parseNameValue(f0); if (nm && (nm.given.length || /,/.test(f0))) { addName(nm, 6, i, 'banner line with DOB'); lineName = nm; } }
      ID_LABEL_RE.lastIndex = 0;
    }
    // d) lines made only of identity fields can be consumed (they are not clinical content)
    if (lineIds || lineName) { const rest = fieldsOf(t).filter(x => !ID_LABEL_TEST.test(x) && !(lineName && parseNameValue(x)) && !dobOf(x)); ID_LABEL_RE.lastIndex = 0; if (!rest.length && !(skip && skip.has(i))) consume.add(i); }
  }
  if (!names.size && !dobs.length) return null;
  const best = [...names.values()].sort((a, b) => b.score - a.score || a.line - b.line)[0] || null;
  let dob = null;
  if (dobs.length) { const near = best ? dobs.filter(x => Math.abs(x.i - best.line) <= 4) : []; const pool = near.length ? near : dobs; const cnt = {}; pool.forEach(x => cnt[x.d] = (cnt[x.d] || 0) + 1); dob = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0]; }
  return { name: best ? best.nm : null, line: best ? best.line : dobs[0].i, how: best ? best.how : 'DOB only', dob, gender, mrn, consume };
}
function importTextLines(lines, file, report, paged) {
  const nPages = paged ? Math.max(...lines.map(l => l.page)) : 1;
  const removed = new Set(); const headerTexts = [];
  // 1. repeated page headers/footers (boilerplate on most pages)
  if (paged && nPages >= 2) {
    const byPage = {}; lines.forEach((l, i) => { if (l.text.trim()) (byPage[l.page] = byPage[l.page] || []).push(i); });
    const cand = new Map();
    for (const p of Object.keys(byPage)) { const idx = byPage[p]; for (const i of idx.slice(0, 3).concat(idx.slice(-2))) { const k = lines[i].text.trim().replace(/\d+/g, '#').replace(/\s+/g, ' '); if (!cand.has(k)) cand.set(k, new Map()); cand.get(k).set(+p, i); } }
    for (const [k, pm] of cand) if (pm.size >= Math.max(2, Math.ceil(nPages * 0.6))) { for (const i of pm.values()) removed.add(i); headerTexts.push({ text: lines[[...pm.values()][0]].text.trim(), pages: pagesStr(new Set(pm.keys())) }); }
  }
  // 1b. join pages: blank lines at the bottom of one page and the top of the next are layout gaps, not breaks,
  //     so lab tables, notes, key/value blocks and loose text continue onto the following page
  const CONT_RE = /^[(\[]?\s*(?:cont(?:inued|'d|\.)?|continued\s+(?:on|from)\s+(?:next|previous|prior)\s+page.*|\(?continued\)?|page\s+\d+(?:\s+of\s+\d+)?)\s*[)\]]?$/i;
  if (paged) {
    lines.forEach((l, i) => { if (CONT_RE.test(l.text.trim())) removed.add(i); });
    for (let p = 1; p <= nPages; p++) {
      const idx = []; lines.forEach((l, i) => { if (l.page === p && !removed.has(i)) idx.push(i); });
      for (let k = idx.length - 1; k >= 0 && !lines[idx[k]].text.trim(); k--) removed.add(idx[k]);
      if (p > 1) for (let k = 0; k < idx.length && !lines[idx[k]].text.trim(); k++) removed.add(idx[k]);
    }
  }
  let org = null;
  for (const h of headerTexts) { const m = h.text.match(/([A-Z][A-Za-z.&' ]*?(?:HEALTH CARE SYSTEM|HEALTHCARE SYSTEM|HEALTH SYSTEM|MEDICAL CENTER|HOSPITAL|CLINIC|HCS|Health)(?: \((?:fictional|FICTIONAL)\))?)/); if (m) { org = m[1].replace(/^.*?-\s*/, '').trim(); break; } }
  // 2. patient identity (labelled fields, headers, table rows and banner lines anywhere in the file)
  const ident = findIdentity(lines, removed);
  let pKey = null; const idLines = ident ? ident.consume : new Set();
  if (ident && ident.name) {
    const p = { name: [{ family: ident.name.family || undefined, given: ident.name.given.length ? ident.name.given : undefined }] };
    if (ident.dob) p.birthDate = ident.dob; if (ident.gender) p.gender = ident.gender;
    if (ident.mrn) p.identifier = [{ type: { text: ident.mrn.label }, value: ident.mrn.value }];
    const at = lines[ident.line];
    pKey = upsertPatient(p, file, { pages: paged ? at.page : null, locator: (paged ? 'p.' + at.page + ' ' : '') + 'line ' + at.line + ' (' + ident.how + ')' });
    report.identity = (p.name[0].family || '').toUpperCase() + ',' + (p.name[0].given || []).join(' ').toUpperCase() + (ident.dob ? '  DOB ' + ident.dob : '') + (ident.gender ? '  ' + ident.gender : '') + ' — found ' + (paged ? 'on p.' + at.page + ' ' : 'at ') + 'line ' + at.line + ' (' + ident.how + ')';
    if (!ident.dob) report.warnings.push('Patient name found but no date of birth; matched to other records by name only.');
  }
  if (!pKey) { pKey = report.defaultPatient || ensureUnknownPatient(file); report.warnings.push('No patient name found in the file' + (ident && ident.dob ? ' (a date of birth ' + ident.dob + ' was found)' : '') + '; items were assigned to ' + ((state.patients.find(p => p.key === pKey) || {}).resource.name[0].family) + '.'); }
  report.patientKey = pKey;
  if (headerTexts.length) addUnstructured(headerTexts.map(h => h.text + '   [pages ' + h.pages + ']').join('\n'), file, { pages: '1-' + nPages, locator: 'repeated page header/footer' }, pKey, report, { label: 'Repeated page header/footer', date: null });

  const loc = (from, to) => { const a = lines[from], b = lines[to == null ? from : to]; const ps = new Set(); for (let k = from; k <= (to == null ? from : to); k++) ps.add(lines[k].page);
    return { pages: paged ? pagesStr(ps) : null, locator: paged ? (from === (to == null ? from : to) ? 'p.' + a.page + ' line ' + a.line : 'p.' + a.page + ' line ' + a.line + ' – p.' + b.page + ' line ' + b.line) : (from === (to == null ? from : to) ? 'line ' + a.line : 'lines ' + a.line + '-' + b.line) }; };

  let section = 'unknown', sectionDate = null;
  let left = null, doc = null, kv = null, lastObs = null, pendingPanel = null;
  let block = null, carry = null, dateCols = null;
  const flushLeft = () => { if (!left) return; const txt = left.idx.map(i => lines[i].text).join('\n'); if (txt.trim()) addUnstructured(txt, file, loc(left.idx[0], left.idx[left.idx.length - 1]), pKey, report); left = null; };
  const pushLeft = i => { if (!lines[i].text.trim() && !left) return; if (!left) left = { idx: [] }; left.idx.push(i); };
  const consumed = () => flushLeft();
  const endBlock = () => {
    if (block && (block.date || block.specimen || block.performer)) carry = { date: block.date, specimen: block.specimen, performer: block.performer, issued: block.issued };
    if (block && block.rows.length && block.panel && !block.multi) {
      const dr = { resourceType: 'DiagnosticReport', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB', display: 'Laboratory' }] }], code: labCode(block.panel), effectiveDateTime: block.date || undefined, result: block.rows.map(o => ({ reference: 'urn:uuid:' + o.id, display: codeText(o.code) })) };
      if (block.performer) dr.performer = [{ display: block.performer }];
      addResource(dr, file, loc(block.from, block.to), pKey, report);
    }
    block = null;
  };
  const newBlock = (i, inherit) => { endBlock(); const c = inherit && carry ? carry : {}; block = { date: c.date || null, specimen: c.specimen || null, performer: c.performer || null, issued: c.issued || null, panel: pendingPanel, rows: [], from: i, to: i, multi: false }; pendingPanel = null; };
  const closeDoc = () => {
    if (!doc) return;
    let end = doc.idx.length; while (end > 0 && !lines[doc.idx[end - 1]].text.trim()) end--;
    const idx = doc.idx.slice(0, end); const body = idx.map(i => lines[i].text.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n');
    const title = doc.std || doc.title || 'Document';
    let kind = doc.kind || docKind({ resourceType: 'DocumentReference', type: { text: title }, description: title });
    if (kind === 'unstructured') kind = 'note';
    const L = DOC_LOINC[kind] || DOC_LOINC.note;
    const r = makeDoc({ title, date: doc.date, author: doc.author, custodian: org || file.system, body, loincCode: L[0], loincDisplay: L[1] });
    addResource(r, file, loc(idx[0], idx[idx.length - 1]), pKey, report);
    doc = null;
  };
  const flushKV = () => {
    if (!kv) return; const f = kv.f; const g = (...ks) => { for (const k of ks) if (f[k] != null && f[k] !== '') { const v = f[k]; delete f[k]; return v; } return null; };
    const range = loc(kv.idx[0], kv.idx[kv.idx.length - 1]); let r = null;
    if (section === 'labs') {
      const name = g('lab test', 'test name', 'test', 'component', 'analyte', 'observation', 'result name'), val = g('result', 'value', 'result value', 'observed value');
      if (name && val != null) {
        const res = parseResultCell(val); const unit = g('units', 'unit', 'uom') || (res && res.unit) || '';
        const spec = f['specimen'] || f['sample type'] || (block && block.specimen) || '';
        r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: 'laboratory', display: 'Laboratory' }] }], code: labCode(name, spec + ' ' + name, !!(res && res.numeric)) };
        const dt = parseDT(g('collected date/time', 'collection date/time', 'collection date', 'date collected', 'collected', 'date/time', 'date') || '') || (block && block.date) || (carry && carry.date) || sectionDate; if (dt) r.effectiveDateTime = dt; else report.warnings.push('Lab "' + name + '" has no collection date (line ' + lines[kv.idx[0]].line + ').');
        if (res && res.numeric) { r.valueQuantity = qty(res.value, unit); if (res.comparator) r.valueQuantity.comparator = res.comparator; } else r.valueString = String(val).trim();
        const rr = parseRange(g('reference range', 'ref range', 'ref. range', 'normal range', 'reference interval', 'ref interval', 'range'), unit); if (rr) r.referenceRange = [rr];
        const fl = flagCode(g('interpretation', 'flag', 'abnormal flag', 'abnormal') || (res && res.flag)); if (fl) r.interpretation = [fl];
        const sp = g('specimen', 'sample type') || (block && block.specimen); if (sp) r.specimen = { display: sp };
        const pl = g('performing lab', 'performing laboratory', 'lab') || (block && block.performer); if (pl) r.performer = [{ display: pl }];
        const cm = g('comment', 'comments', 'note'); if (cm) r.note = [{ text: cm }];
      }
    } else if (section === 'allergies') {
      const sub = g('allergy name', 'allergen', 'substance', 'allergy', 'agent');
      if (sub) { r = { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, code: { text: sub } };
        const re = g('reaction', 'reactions', 'signs/symptoms'); if (re) r.reaction = [{ manifestation: re.split(/[,;]\s*/).map(t => ({ text: t })) }];
        const ty = g('allergy type', 'type'); if (ty) r.category = /drug|medic/i.test(ty) ? ['medication'] : /food/i.test(ty) ? ['food'] : /environ/i.test(ty) ? ['environment'] : undefined;
        const de = parseDT(g('date entered', 'entered', 'date') || ''); if (de) r.recordedDate = de;
        const oh = g('observed/historical'); if (oh) r.verificationStatus = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }], text: oh }; }
    } else if (section === 'problems') {
      const pr = g('problem', 'diagnosis', 'condition');
      if (pr) { const cc = { text: pr.replace(/\s*\((ICD-?10(?:-CM)?|ICD-?9(?:-CM)?|SNOMED(?: CT)?)\s+([A-Z0-9.]+)\)\s*$/i, '') }; const mc = pr.match(/\((ICD-?10(?:-CM)?|ICD-?9(?:-CM)?|SNOMED(?: CT)?)\s+([A-Z0-9.]+)\)/i);
        if (mc) cc.coding = [{ system: /SNOMED/i.test(mc[1]) ? SCT : /9/.test(mc[1]) ? 'http://hl7.org/fhir/sid/icd-9-cm' : 'http://hl7.org/fhir/sid/icd-10-cm', code: mc[2], display: cc.text }];
        r = { resourceType: 'Condition', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }], code: cc };
        const st = g('status'); r.clinicalStatus = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: /inactive|resolved/i.test(st || '') ? 'resolved' : 'active' }], text: st || undefined };
        const de = parseDT(g('date entered', 'entered', 'onset', 'date of onset', 'date') || ''); if (de) r.recordedDate = de;
        const pv = g('provider', 'entered by'); if (pv) r.recorder = { display: pv }; }
    } else if (section === 'meds') {
      const med = g('medication', 'drug', 'medication name');
      if (med) { r = { resourceType: 'MedicationRequest', intent: 'order', status: /discontinued|expired|inactive/i.test(f.status || '') ? 'stopped' : 'active', medicationCodeableConcept: { text: med } };
        const st = g('status'); if (st) r.statusReason = { text: st };
        const sig = g('instructions', 'sig', 'directions'); if (sig) r.dosageInstruction = [{ text: sig }];
        const rx = g('rx #', 'rx number', 'prescription number'); if (rx) r.identifier = [{ type: { text: 'Rx #' }, value: rx }];
        const lf = g('last filled on', 'last filled', 'fill date'); if (lf) r.dispenseRequest = { validityPeriod: { start: parseDT(lf) || undefined } }, r.note = [{ text: 'Last filled: ' + lf }];
        const od = parseDT(g('date ordered', 'ordered', 'start date', 'issued') || ''); if (od) r.authoredOn = od; }
    } else if (section === 'appts') {
      const dt = parseDT(g('date/time', 'date', 'appointment date') || '');
      if (dt) { r = { resourceType: 'Appointment', status: /cancel/i.test(f.status || '') ? 'cancelled' : 'booked', start: dt }; const cl = g('clinic', 'location', 'department'); if (cl) r.description = cl; g('status'); }
    } else if (section === 'imms') {
      const v = g('immunization', 'vaccine', 'name'); const dt = parseDT(g('date', 'date given', 'administered') || '');
      if (v) r = { resourceType: 'Immunization', status: 'completed', vaccineCode: { text: v }, occurrenceDateTime: dt || undefined, occurrenceString: dt ? undefined : 'unknown' };
    }
    if (r) {
      const rest = Object.keys(f).filter(k => f[k]).map(k => kv.keys[k] + ': ' + f[k]);
      if (rest.length) { if (r.resourceType === 'Appointment') r.comment = rest.join('; '); else (r.note = r.note || []).push({ text: 'Other source fields: ' + rest.join('; ') }); }
      consumed(); lastObs = addResource(r, file, range, pKey, report);
    } else { kv.idx.forEach(pushLeft); }
    kv = null;
  };
  const splitDash = x => { const m = x.match(/\s+[-–—]\s+/); return m ? [x.slice(0, m.index), x.slice(m.index + m[0].length)] : [x, '']; };
  const listItem = (t, i) => {
    const s = t.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim(); let r = null;
    if (section === 'allergies') {
      if (/^(NKA|NKDA|No Known)/i.test(s)) r = { resourceType: 'AllergyIntolerance', code: { coding: [{ system: SCT, code: '716186003', display: 'No known allergy' }], text: s } };
      else { const [sub, rest] = splitDash(s); const sev = (rest || '').match(/\((mild|moderate|severe)\)/i);
        r = { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, code: { text: sub.trim() } };
        if (rest) r.reaction = [{ manifestation: rest.replace(/\((mild|moderate|severe)\)/i, '').split(/[,;]\s*/).filter(x => x.trim()).map(x => ({ text: x.trim() })), severity: sev ? sev[1].toLowerCase() : undefined }]; }
    } else if (section === 'meds') { const [nm, sig] = splitDash(s); r = { resourceType: 'MedicationStatement', status: 'active', medicationCodeableConcept: { text: nm.trim() } }; if (sig) r.dosage = [{ text: sig.trim() }]; }
    else if (section === 'problems') { const d = findDate(s); r = { resourceType: 'Condition', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { text: d ? s.replace(d.raw, '').replace(/[\s,;-]+$/, '').trim() : s } }; if (d) r.onsetDateTime = d.iso; }
    else if (section === 'imms') { const d = findDate(s); if (d) r = { resourceType: 'Immunization', status: 'completed', vaccineCode: { text: s.replace(d.raw, '').replace(/[\s,;-]+$/, '').trim() }, occurrenceDateTime: d.iso }; }
    else if (section === 'appts') { const d = findDate(s); if (d) r = { resourceType: 'Appointment', status: 'booked', start: d.iso, description: s.replace(d.raw, '').trim() }; }
    if (!r) return false;
    consumed(); addResource(r, file, loc(i), pKey, report); return true;
  };
  const emitLab = (i, row, dt) => {
    const r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: 'laboratory', display: 'Laboratory' }] }], code: labCode(row.name, (block.specimen || '') + ' ' + (block.panel || ''), row.numeric) };
    if (dt) r.effectiveDateTime = dt; else report.warnings.push('Lab "' + row.name + '" has no collection date (line ' + lines[i].line + ').');
    if (block.issued) r.issued = block.issued;
    if (row.numeric) { r.valueQuantity = qty(row.value, row.unit); if (row.comparator) r.valueQuantity.comparator = row.comparator; } else { r.valueString = row.value; }
    const rr = parseRange(row.range, row.unit); if (rr) r.referenceRange = [rr];
    const fl = flagCode(row.flag); if (fl) r.interpretation = [fl];
    if (block.specimen) r.specimen = { display: block.specimen.replace(/\b\w/g, c => c.toUpperCase()).replace(/\B\w+/g, w => w.toLowerCase()) };
    if (block.performer) r.performer = [{ display: block.performer }];
    if (row.extra && row.extra.length) r.note = [{ text: 'Additional printed columns: ' + row.extra.join(' | ') }];
    lastObs = addResource(r, file, loc(i), pKey, report); block.rows.push(lastObs);
  };
  const docStart = (i, t) => {
    let m;
    if ((m = t.match(/^\s*LOCAL TITLE:\s*(.+?)\s*$/))) return { title: m[1].split(/\s{2,}/)[0] };
    if ((m = t.match(/^\s*Exm Date:\s*(.+)$/i))) return { title: 'Radiology report', kind: 'radiology', date: parseDT(m[1]) };
    if ((m = t.match(/^\s*Date Spec(?:imen)? taken:\s*(.+)$/i))) return { title: section === 'pathology' ? 'SURGICAL PATHOLOGY' : 'Pathology report', kind: 'pathology', date: parseDT(m[1]) };
    if (['notes', 'radiology', 'pathology'].includes(section) && t.trim().length < 80 && !/:\s*\S/.test(t) && /\b(Note|Summary|Report|Consult(?:ation)?|H&P|History and Physical)\b/i.test(t)) {
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) if (/^\s*(Author|Date of Service|Provider|Signed|Service Date|Date)\b/i.test(lines[j].text)) return { title: t.trim() };
    }
    return null;
  };
  const docHeader = (t, i) => {
    let m;
    if ((m = t.match(/^\s*STANDARD TITLE:\s*(.+?)\s*$/))) doc.std = m[1];
    if ((m = t.match(/DATE OF NOTE:\s*(.+?)(?:\s{2,}|$)/)) && !doc.date) doc.date = parseDT(m[1]);
    if ((m = t.match(/Date of Service:\s*(.+?)(?:\s{2,}|$)/i)) && !doc.date) doc.date = parseDT(m[1]);
    if ((m = t.match(/^\s*AUTHOR:\s*(.+?)(?:\s{2,}|$)/i)) && m[1].trim()) doc.author = m[1].trim();
    if ((m = t.match(/^\s*Pathologist:\s*(.+?)(?:\s{2,}|$)/i))) doc.author = m[1].trim();
    if ((m = t.match(/^\s*Procedure:\s*(.+?)(?:\s{2,}|$)/i)) && doc.kind === 'radiology') doc.title = m[1].trim();
    if ((m = t.match(/^\s*Specimen:\s*(.+?)\s*$/i)) && doc.kind === 'pathology') doc.title = 'SURGICAL PATHOLOGY - ' + m[1];
    if (doc.wantAuthor && t.trim()) { doc.author = doc.author || t.trim().replace(/,\s*Radiologist$/i, ''); doc.wantAuthor = false; }
    if (/Primary Interpreting Staff:\s*$/i.test(t)) doc.wantAuthor = true;
    if ((m = t.match(/\/ESIGNED BY:\s*(.+?)(?:\s{2,}|$)/i)) && !doc.author) doc.author = m[1].trim();
    if ((m = t.match(/^\s*\/es\/\s*(.+?)\s*$/i)) && !doc.author) doc.author = m[1];
    if ((m = t.match(/Electronically signed by\s+(.+?)\s+on\b/i)) && !doc.author) doc.author = m[1];
    if (/^\s*(\/es\/|\/ESIGNED BY|Electronically signed by|Signed electronically by)/i.test(t)) doc.closing = true;
  };

  for (let i = 0; i < lines.length; i++) {
    if (removed.has(i) || idLines.has(i)) continue;
    const raw = lines[i].text, t = raw.trim();
    if (/^[=\-_*~]{5,}$/.test(t)) { if (doc) doc.idx.push(i); else flushKV(); continue; }
    const h = headingOf(t);
    if (h && h.type === section && /\bcont(?:inued|'d|\.)?\b/i.test(t)) continue; // "LABORATORY RESULTS (continued)" on a following page
    if (h) { closeDoc(); flushKV(); flushLeft(); endBlock(); section = h.type; sectionDate = h.date; lastObs = null; carry = null; dateCols = null; continue; }
    const ds = docStart(i, raw);
    if (ds) { closeDoc(); flushKV(); flushLeft(); endBlock(); carry = null; dateCols = null; doc = Object.assign({ idx: [] }, ds); doc.idx.push(i); continue; }
    if (doc) { doc.idx.push(i); docHeader(raw, i); if (doc.closing && !t) closeDoc(); continue; }
    if (!t) { flushKV(); if (left) left.idx.push(i); continue; }
    let m;
    if (section === 'labs') {
      if (kv) { const km = t.match(KV_RE); if (km) { const k = km[1].toLowerCase(); if (kv.f[k] == null) { kv.f[k] = km[2]; kv.keys[k] = km[1]; kv.idx.push(i); continue; } flushKV(); } else flushKV(); }
      if ((m = t.match(/^(Lab Test|Test Name|Test|Component|Analyte|Observation|Result Name)\s*:\s*(.+)$/i))) { dateCols = null; kv = { f: { [m[1].toLowerCase()]: m[2] }, keys: { [m[1].toLowerCase()]: m[1] }, idx: [i] }; continue; }
      if (/^(Collection DT|Collection Date(?:\/Time)?|Collected(?: on| Date(?:\/Time)?)?|Date Collected|Specimen Collected)\b/i.test(t)) {
        consumed(); dateCols = null; newBlock(i, false); block.date = parseDT(t);
        const sp = t.match(/Specimen:\s*(.+?)(?:\s{2,}|$)/i); if (sp) block.specimen = sp[1].trim();
        const rs = t.match(/Resulted:?\s*(.+?)(?:\s{2,}|$)/i); if (rs) block.issued = parseDT(rs[1]); continue;
      }
      if ((m = t.match(/^Specimen:\s*(.+)$/i))) { consumed(); if (!block) newBlock(i, true); block.specimen = m[1].trim(); continue; }
      if ((m = t.match(/^(?:Performing Lab(?:oratory)?|Performed (?:by|at)|Testing Lab)\s*:\s*(.+)$/i))) {
        consumed(); if (!block) newBlock(i, true); block.performer = m[1].trim(); block.to = i;
        for (const o of block.rows) if (!o.performer) o.performer = [{ display: block.performer }];
        continue;
      }
      if (/^(Test name|Test|Component|Analyte)\b.*\b(Result|Value|Your Value)\b/i.test(t)) { consumed(); continue; }
      if ((m = t.match(/^(?:Comment|Comments|Note)\s*:\s*(.+)$/i)) && lastObs) { (lastObs.note = lastObs.note || []).push({ text: m[1] }); lastObs.extension.find(e => e.url === EXT_SRC).extension.find(x => x.url === 'locator').valueString += ' (+ comment line ' + lines[i].line + ')'; continue; }
      const dh = dateHeader(raw);
      if (dh) { consumed(); endBlock(); dateCols = dh; continue; }
      if (dateCols) {
        const mr = parseMultiRow(raw, dateCols);
        if (mr) {
          consumed(); if (!block) { newBlock(i, true); block.multi = true; } block.to = i;
          for (const v of mr.values) emitLab(i, { name: mr.name, comparator: v.res.comparator, value: v.res.value, numeric: v.res.numeric, flag: v.res.flag || mr.flag, unit: v.res.numeric ? (v.res.unit || mr.unit) : '', range: mr.range, extra: mr.extra }, v.iso);
          continue;
        }
      }
      const row = parseLabRow(t);
      if (row) {
        consumed(); if (!block) newBlock(i, true); block.to = i;
        emitLab(i, row, block.date || sectionDate); continue;
      }
      if (isPanelTitle(t)) { consumed(); endBlock(); pendingPanel = t; continue; }
      pushLeft(i); continue;
    }
    if (section === 'func') {
      const d = findDate(t); const date = (d && d.index < 3) ? d.iso : sectionDate;
      if (funcInLine(t, date, file, loc(i), pKey, report, false)) { consumed(); continue; }
      pushLeft(i); continue;
    }
    if (section === 'vitals') {
      if (/^Date\s*\/?\s*Time\b/i.test(t)) { consumed(); continue; }
      const d = findDate(t); const date = (d && d.index < 3) ? d.iso : sectionDate;
      let hit = 0; const L = loc(i);
      { const fn = funcInLine(t, date, file, L, pKey, report, false); if (fn) { consumed(); hit += fn; } }
      for (const [k, re] of VITAL_RES) { const vm = t.match(re); if (vm) { if (!hit) consumed(); hit++; addResource(makeVital(k, vm, date), file, L, pKey, report); } }
      if (!hit) pushLeft(i);
      continue;
    }
    if (['allergies', 'problems', 'meds', 'appts', 'imms'].includes(section)) {
      const km = t.match(KV_RE);
      if (km && !/^https?$/i.test(km[1])) { const k = km[1].toLowerCase(); if (!kv) kv = { f: {}, keys: {}, idx: [] }; if (kv.f[k] != null) { flushKV(); kv = { f: {}, keys: {}, idx: [] }; } kv.f[k] = km[2]; kv.keys[k] = km[1]; kv.idx.push(i); continue; }
      flushKV(); if (listItem(t, i)) continue; pushLeft(i); continue;
    }
    if (!section) { const d = findDate(t); if (funcInLine(t, (d && d.index < 3) ? d.iso : sectionDate, file, loc(i), pKey, report, true)) { consumed(); continue; } }   // a line that begins with a scale score outside any section
    pushLeft(i);
  }
  closeDoc(); flushKV(); endBlock(); flushLeft();
}

async function pdfToLines(buf, file, report) {
  if (!deps.pdfjs) throw new Error('PDF library not loaded');
  const pdf = await deps.pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const lines = []; const empty = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p); const tc = await page.getTextContent();
    const items = tc.items.filter(it => it.str && it.str.trim());
    if (!items.length) { empty.push(p); continue; }
    items.sort((a, b) => (b.transform[5] - a.transform[5]) || (a.transform[4] - b.transform[4]));
    const rows = [];
    for (const it of items) { const y = it.transform[5]; let r = rows.find(r => Math.abs(r.y - y) < 2.5); if (!r) { r = { y, items: [] }; rows.push(r); } r.items.push(it); }
    rows.sort((a, b) => b.y - a.y);
    const gaps = rows.slice(1).map((r, i) => rows[i].y - r.y).filter(g => g > 0).sort((a, b) => a - b); const med = gaps.length ? gaps[Math.floor(gaps.length * 0.3)] : 12;
    let ln = 0, prevY = null;
    for (const r of rows) {
      if (prevY != null && prevY - r.y > med * 1.6) { const n = Math.min(2, Math.round((prevY - r.y) / med) - 1); for (let k = 0; k < n; k++) lines.push({ text: '', page: p, line: ++ln }); }
      prevY = r.y;
      r.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let text = '', end = null;
      for (const it of r.items) {
        const x = it.transform[4]; const cw = it.width / Math.max(1, it.str.length) || Math.abs(it.transform[0]) * 0.5 || 4;
        if (end != null) { const gap = x - end; if (gap > cw * 1.2) text += ' '.repeat(Math.max(2, Math.min(40, Math.round(gap / cw)))); else if (gap > cw * 0.2 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' '; }
        text += it.str; end = x + it.width;
      }
      lines.push({ text: text.replace(/\s+$/, ''), page: p, line: ++ln });
    }
  }
  return { lines, numPages: pdf.numPages, empty };
}

/* ================= dispatcher ================= */
function decodeText(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { }
  try { return new TextDecoder('windows-1252').decode(u8); } catch (e) { }          // older exports: not UTF-8
  let o = ''; for (let i = 0; i < u8.length; i++) o += String.fromCharCode(u8[i]); return o;
}
const ZIP_LIMITS = { maxFiles: 5000, maxBytes: 600 * 1024 * 1024, maxDepth: 3 };
const isPatientFileName = n => /(^|\/)Patient(?![A-Za-z])[^\/]*$/i.test(n);
async function importFile(name, buf, opts) {
  opts = opts || {};
  const head = new Uint8Array(buf.slice(0, 8));
  const isZip = head[0] === 0x50 && head[1] === 0x4b, isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  if (isZip || /\.zip$/i.test(name)) {
    if (!deps.JSZip) throw new Error('ZIP support not loaded');
    const refuse = msg => [{ file: name, format: 'ZIP archive', counts: {}, merged: 0, warnings: [msg], patientKey: null }];
    const depth = (opts._depth || 0) + 1; if (depth > ZIP_LIMITS.maxDepth) return refuse('ZIP files nested more than ' + ZIP_LIMITS.maxDepth + ' levels deep are not opened.');
    const zip = await deps.JSZip.loadAsync(buf); const reports = [];
    const entries = Object.values(zip.files).filter(f => !f.dir && !/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name) && !/\.(xsl|xslt|css|js|ico)$/i.test(f.name));
    const maxBytes = opts.maxZipBytes || ZIP_LIMITS.maxBytes, maxFiles = opts.maxZipFiles || ZIP_LIMITS.maxFiles;
    const declared = entries.reduce((n, f) => n + ((f._data && f._data.uncompressedSize) || 0), 0);
    if (entries.length > maxFiles) return refuse('ZIP holds ' + entries.length + ' files, more than the limit of ' + maxFiles + '; nothing was imported.');
    if (declared > maxBytes) return refuse('ZIP is too large (' + Math.round(declared / 1048576) + ' MB when unpacked; limit ' + Math.round(maxBytes / 1048576) + ' MB); nothing was imported.');
    // patient lists first, so records in the other files can find their patient
    entries.sort((a, b) => (isPatientFileName(a.name) ? 0 : 1) - (isPatientFileName(b.name) ? 0 : 1));
    let total = 0;
    for (const f of entries) {
      const b = await f.async('arraybuffer'); total += b.byteLength;
      if (total > maxBytes) { reports.push(...refuse('Unpacking stopped: the ZIP is larger than the limit of ' + Math.round(maxBytes / 1048576) + ' MB.')); break; }
      reports.push(...await importFile(name + '/' + f.name, b, Object.assign({}, opts, { _depth: depth })));
    }
    return reports;
  }
  const file = { id: uid(), name, size: buf.byteLength, importedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), sha256: await sha256(buf.slice(0)) };
  const report = { file: name, format: '', counts: {}, merged: 0, warnings: [], defaultPatient: opts.defaultPatient, patientKey: null };
  try {
    if (isPdf) {
      file.format = 'pdf'; file.method = 'rules'; report.format = 'PDF (printed/exported record) — built-in rules';
      const { lines, numPages, empty } = await pdfToLines(buf, file, report); file.pages = numPages;
      importTextLines(lines, file, report, true);
      for (const p of empty) addUnstructured('Page ' + p + ' has no text layer (it is probably a scanned image). OCR is not available in this viewer, so the page content was not interpreted.', file, { pages: p, locator: 'whole page (image only)' }, report.patientKey, report, { label: 'Image-only page', date: null });
      if (empty.length) report.warnings.push(empty.length + ' page(s) had no text layer: ' + empty.join(', '));
    } else if (/\.(png|jpe?g|gif|tiff?|bmp|dcm)$/i.test(name)) {
      file.format = 'image'; report.format = 'Image';
      addUnstructured('Image file "' + name + '" (' + buf.byteLength + ' bytes) was not interpreted.', file, { locator: 'whole file' }, opts.defaultPatient || ensureUnknownPatient(file), report, { label: 'Uninterpreted image', date: null });
    } else {
      const text = decodeText(buf).replace(/^﻿/, ''); const t = text.replace(/^[\s\x0b\x1c]+/, '');
      if (/^<\?xml|^</.test(t) && /<(?:[A-Za-z_][\w.-]*:)?ClinicalDocument\b/.test(t.slice(0, 20000))) { file.format = 'ccda'; report.format = 'HL7 C-CDA (XML)'; importCDA(text, file, report); }
      else if (/^(?:FHS|BHS|MSH)\|/.test(t)) { file.format = 'hl7v2'; report.format = 'HL7 v2 message'; importHL7v2(t, file, report); }
      else if (/^[\[{]/.test(t) && /"resourceType"\s*:/.test(t.slice(0, 20000))) { file.format = /^\{[^\n]*\}\s*\n\s*\{/.test(t) ? 'fhir-ndjson' : 'fhir-json'; report.format = 'HL7 FHIR (' + (file.format === 'fhir-ndjson' ? 'NDJSON' : 'JSON') + ')'; importFHIR(text, file, report); }
      else if (/^<\?xml|^</.test(t) && /<(?:[A-Za-z_][\w.-]*:)?[A-Z][A-Za-z]+\b[^>]*\sxmlns(?::[\w.-]+)?="http:\/\/hl7\.org\/fhir"/.test(t.slice(0, 5000))) {
        file.format = 'fhir-xml'; report.format = 'HL7 FHIR (XML) — not supported';
        report.warnings.push('FHIR XML is not supported. Ask the source for FHIR JSON (or NDJSON), or for a C-CDA. The file text was kept under Ext Data.');
        addUnstructured(htmlToText(t).slice(0, 20000), file, { locator: 'whole file (FHIR XML text content)' }, opts.defaultPatient || ensureUnknownPatient(file), report, { label: 'FHIR XML (not interpreted)', date: null });
      }
      else if (/^\{\\rtf/.test(t)) { file.format = 'rtf'; file.method = 'rules'; report.format = 'RTF text — built-in rules'; importTextLines(rtfToText(t).split(/\r?\n/).map((x, i) => ({ text: x, page: 1, line: i + 1 })), file, report, false); }
      else if (/^</.test(t) && /<html|<body|<div|<table/i.test(t.slice(0, 5000))) { file.format = 'html'; report.format = 'HTML export'; const lines = htmlToText(t).split(/\n/).map((x, i) => ({ text: x, page: 1, line: i + 1 })); importTextLines(lines, file, report, false); }
      else { file.format = 'text'; file.method = 'rules'; report.format = 'Plain text — built-in rules';
        const pages = text.split('\f'); const lines = []; pages.forEach((pg, pi) => pg.split(/\r\n|\r|\n/).forEach((x, li) => lines.push({ text: x, page: pi + 1, line: li + 1 })));
        importTextLines(lines, file, report, pages.length > 1); }
    }
  } catch (e) {
    report.warnings.push('Import error: ' + e.message);
    try { addUnstructured('The file could not be interpreted (' + e.message + ').', file, { locator: 'whole file' }, report.patientKey || opts.defaultPatient || ensureUnknownPatient(file), report, { label: 'Import error', date: null }); } catch (e2) { }
  }
  file.report = report; file.system = file.system || undefined;
  state.files.push(file);
  return [report];
}

/* CPRS4CC — Claude-based extraction for printed / text records.
 * De-identification (tokenize identifiers incl. EVERY date; key stays in the browser), prompt building,
 * batching, verification of returned values against the cited page lines, mapping to FHIR via the engine,
 * and restoration of the original values. Inserted into engine.js at build time (shares its scope). */

/* ---------------- de-identification ---------------- */
const MONTHS_RE = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const TOKEN_RE = /\[(?:PATIENT|AGE 90\+|[A-Z]+-\d+)\]/g;
function isoFromParts(y, mo, d) {
  y = +y; if (y < 100) y += y > 50 ? 1900 : 2000; mo = +mo; d = d == null ? null : +d;
  if (!(mo >= 1 && mo <= 12) || (d != null && !(d >= 1 && d <= 31)) || y < 1880 || y > 2100) return null;
  return y + '-' + pad(mo) + (d != null ? '-' + pad(d) : '');
}
const MONNUM = s => MON[String(s).slice(0, 3).toUpperCase()];
/* Ordered rules. Each: kind (token prefix), re (global), get(m) -> {orig, iso?, group?} or null to skip.
   `group` = the capture to replace (labelled values keep their label). */
function deidRules(ident, extra, ids) {
  const R = [];
  for (const t of (ids || []).map(s => String(s).trim()).filter(s => s.length >= 3)) R.push({ kind: 'ID', re: new RegExp('(?<![A-Za-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'g') });
  for (const t of (extra || []).map(s => s.trim()).filter(s => s.length >= 2).sort((a, b) => b.length - a.length))
    R.push({ kind: 'TERM', re: new RegExp('(?<![A-Za-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'gi') });
  R.push({ kind: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g });
  R.push({ kind: 'URL', re: /\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi });
  R.push({ kind: 'IP', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g });
  R.push({ kind: 'ID', re: /\b(?:\d{3}|[Xx*]{3})-(?:\d{2}|[Xx*]{2})-\d{4}\b/g });                       // SSN, incl. masked
  R.push({ kind: 'PH', re: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g });       // phone / fax
  // labelled identifiers: keep the label, replace the value
  R.push({ kind: 'ID', re: /\b(?:MRN|ICN|EDIPI|DFN|Acct|Account|Accession|Rx|Prescription|Patient\s+ID|Pt\.?\s*ID|Member\s+ID|Subscriber\s+ID|Policy|Claim|Encounter|Visit|CSN|FIN|HAR|Order|Case|Chart|Specimen\s+ID|Med(?:ical)?\.?\s*Rec(?:ord)?\.?)\s*(?:#|No\.?|Number|Num)?\s*[:#]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{2,}(?:\s\d{2,}){0,2})/gi, group: 1 });
  // dates — every date of any kind; the year alone is left (HIPAA Safe Harbor allows the year)
  R.push({ kind: 'D', re: /\b(\d{4})-(\d{2})-(\d{2})(?=T|\b)/g, iso: m => isoFromParts(m[1], m[2], m[3]) });
  R.push({ kind: 'D', re: new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]?(' + MONTHS_RE + ')\\.?[\\s,-]?(\\d{4}|\\d{2})\\b', 'gi'), iso: m => isoFromParts(m[3], MONNUM(m[2]), m[1]) });
  R.push({ kind: 'D', re: new RegExp('\\b(' + MONTHS_RE + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})\\b', 'gi'), iso: m => isoFromParts(m[3], MONNUM(m[1]), m[2]) });
  R.push({ kind: 'D', re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g, iso: m => isoFromParts(m[3], m[1], m[2]) });
  R.push({ kind: 'D', re: /\b(\d{1,2})([.-])(\d{1,2})\2(\d{4})\b/g, iso: m => isoFromParts(m[4], m[1], m[3]) });
  R.push({ kind: 'D', re: new RegExp('\\b(' + MONTHS_RE + ')\\.?,?\\s+(\\d{4})\\b', 'gi'), iso: m => isoFromParts(m[2], MONNUM(m[1]), null) });
  R.push({ kind: 'D', re: /\b(0?[1-9]|1[0-2])\/((?:19|20)\d{2})\b/g, iso: m => isoFromParts(m[2], m[1], null) });
  R.push({ kind: 'D', re: /\b((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\d{4,6})?\b/g, iso: m => isoFromParts(m[1], m[2], m[3]) });
  R.push({ kind: 'D', re: /\b(?:on|since|from|until|thru|through|dated|date|DOS|seen)\s*:?\s+((0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01]))\b(?!\/)/gi, group: 1, iso: () => null });
  R.push({ kind: 'ID', re: /\b[A-Z]{0,4}\d{7,}\b/g });                                                 // long numbers / alphanumeric IDs
  R.push({ kind: 'ID', re: /\b[A-Z]{1,3}\d{6}\b/g });
  // the patient's own name, every printed form
  const nm = [];
  if (ident) { for (const w of [ident.family].concat(ident.given || [])) { const s = String(w || '').replace(/\d+$/, ''); if (s.replace(/[^A-Za-z]/g, '').length >= 2) nm.push(s); } }
  if (ident && ident.family && (ident.given || []).length) {
    const f = String(ident.family).replace(/\d+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), g = String(ident.given[0]).replace(/\d+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    R.push({ kind: 'PATIENT', re: new RegExp('(?<![A-Za-z])(?:' + f + '\\d*\\s*,\\s*' + g + '\\d*(?:\\s+[A-Z]\\.?(?![A-Za-z]))?|' + g + '\\d*(?:\\s+[A-Z]\\.?)?\\s+' + f + '\\d*)(?![A-Za-z])', 'gi') });
  }
  if (nm.length) R.push({ kind: 'PATIENT', re: new RegExp('(?<![A-Za-z])(?:' + nm.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d*').join('|') + ')(?![A-Za-z])', 'gi') });
  R.push({ kind: 'AGE', re: /\b(?:9\d|1[01]\d)\s*(?:-?\s*(?:y\/?o|y\.o\.|yo|yrs?|years?)(?:\s*-?\s*old)?)\b/gi });
  // addresses
  R.push({ kind: 'ADDR', re: /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][A-Za-z.'-]*\s+){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Bypass|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace|Sq|Square|Trl|Trail)\b\.?(?:,?\s*(?:Apt|Unit|Suite|Ste|#)\.?\s*[A-Za-z0-9-]+)?/gi });
  R.push({ kind: 'ADDR', re: /\b[A-Z][A-Za-z .'-]{1,30},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g });
  R.push({ kind: 'ADDR', re: /\b(?:[A-Z]{2}|Massachusetts|California|New York|Texas|Florida|Virginia|North Carolina|Pennsylvania|Ohio|Georgia|Illinois|Michigan)\s+\d{5}(?:-\d{4})?\b/g });
  R.push({ kind: 'ADDR', re: /\b[A-Z][A-Za-z'-]+(?:\s[A-Z][A-Za-z'-]+)?,?\s+(?:AL|AK|AZ|AR|CA|CT|FL|GA|ID|IL|IA|KS|KY|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|RI|SC|SD|TN|TX|UT|VT|WA|WV|WI|WY)\b(?![a-z])/g });
  R.push({ kind: 'ADDR', re: /\b(?:ZIP|Zip Code|Postal Code)\s*:?\s*(\d{5}(?:-\d{4})?)\b/gi, group: 1 });
  // other people (providers, relatives); restored after extraction
  R.push({ kind: 'PER', re: /\b(?:Dr|Doctor|Mr|Mrs|Ms|Miss|Mx)\.?\s+((?:[A-Z]\.\s*|[A-Z][A-Za-z'-]+\s+){0,2}[A-Z][A-Za-z'-]+)/g, group: 1 });
  R.push({ kind: 'PER', re: /\b([A-Z][A-Za-z'-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][A-Za-z'-]+){1,2}),?\s+(?:MD|DO|NP|PA-C|PA|RN|PhD|DNP|APRN|FNP|LPN|DPM|PharmD|OD)\b/g, group: 1 });
  R.push({ kind: 'PER', re: /\b([A-Z][A-Z'-]+,[A-Z][A-Z'-]+(?:\s[A-Z]\b)?)/g, group: 1 });          // VistA LAST,FIRST M
  R.push({ kind: 'PER', re: /(?:\/es\/|\/ESIGNED BY:|Signed by:?|Electronically signed by|Author:|AUTHOR:|Pathologist:|Radiologist:|Req Phys:|Ordering(?: Provider)?:|Attending:|Provider:|PCP:|Referred by:?|Cosigner:|Interpreted by:?)\s*([A-Za-z][A-Za-z.,' -]*?[A-Za-z.])(?=\s{2,}|\s+(?:on|at)\s|\s*$|\s+\d)/g, group: 1 });
  R.push({ kind: 'PER', re: /\b(?:wife|husband|son|daughter|mother|father|brother|sister|spouse|partner|fianc[eé]e?|friend|caregiver|niece|nephew|aunt|uncle|grandson|granddaughter|guardian|neighbor)\s*,?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, group: 1 });
  return R;
}
/* pages: [{page, lines:[string]}]. Returns {pages:[{page, lines}], map: Map(token -> {orig, kind, iso}), counts}. */
function deidentify(pages, ident, extraTerms, ids) {
  const map = new Map(), byOrig = new Map(), counters = {}, counts = {};
  const token = (kind, orig, iso) => {
    if (kind === 'PATIENT') { counts.PATIENT = (counts.PATIENT || 0) + 1; if (!map.has('[PATIENT]')) map.set('[PATIENT]', { orig, kind }); return '[PATIENT]'; }
    if (kind === 'AGE') { counts.AGE = (counts.AGE || 0) + 1; const t = '[AGE 90+]'; if (!map.has(t)) map.set(t, { orig, kind }); return t; }
    const key = kind + '|' + orig.toUpperCase().replace(/\s+/g, ' ');
    counts[kind] = (counts[kind] || 0) + 1;
    if (byOrig.has(key)) return byOrig.get(key);
    const n = (counters[kind] = (counters[kind] || 0) + 1); const t = '[' + kind + '-' + n + ']';
    byOrig.set(key, t); map.set(t, { orig, kind, iso: iso || null }); return t;
  };
  const rules = deidRules(ident, extraTerms, ids);
  const out = pages.map(pg => ({ page: pg.page, lines: pg.lines.map(line => {
    let s = line;
    for (const r of rules) {
      r.re.lastIndex = 0;
      s = s.replace(r.re, (...a) => {
        const m = a.slice(0, a.length - 2); const off = a[a.length - 2]; const whole = m[0];
        // never re-tokenize inside an existing placeholder
        const before = s.slice(0, off); if (/\[[A-Z0-9 +-]*$/.test(before) && /^[A-Z0-9 +-]*\]/.test(s.slice(off + whole.length))) return whole;
        if (/^\[(?:PATIENT|[A-Z]+-\d+|AGE 90\+)\]$/.test(whole)) return whole;
        const target = r.group != null ? m[r.group] : whole; if (!target) return whole;
        const iso = r.iso ? r.iso(m) : null;
        if (r.kind === 'D' && r.iso && iso === null && r.group == null) return whole; // not a valid date
        const t = token(r.kind, target.trim(), iso);
        return r.group != null ? whole.replace(target, t) : t;
      });
    }
    return s;
  }) }));
  return { pages: out, map, counts };
}
function restoreTokens(s, map) {
  if (s == null) return s;
  return String(s).replace(TOKEN_RE, t => { const e = map.get(t); return e ? e.orig : t; });
}

/* ---------------- prompt ---------------- */
const EXTRACT_SCHEMA = `{
 "patient": {"family": "", "given": "", "dob": "", "sex": "", "mrn": ""},
 "items": [
  {"type":"lab","page":2,"line":7,"name":"POTASSIUM","value":"5.4","unit":"mmol/L","refRange":"3.5 - 5.1","flag":"H","specimen":"Serum","performer":"lab name as printed","date":"<date as printed>","time":"08:12","comment":"","panel":"BASIC METABOLIC PANEL"},
  {"type":"vital","page":3,"line":5,"vital":"BP","value":"142/88","unit":"mmHg","date":"","time":""},
  {"type":"problem","page":4,"line":2,"text":"Type 2 diabetes mellitus","code":"E11.9","codeSystem":"ICD-10-CM","status":"active","date":""},
  {"type":"medication","page":4,"line":9,"name":"metformin 500 mg tablet","sig":"1 tab by mouth daily","status":"active","date":""},
  {"type":"allergy","page":4,"line":14,"substance":"Penicillin","reaction":"hives","severity":"moderate","date":""},
  {"type":"immunization","page":5,"line":3,"vaccine":"Influenza","date":""},
  {"type":"procedure","page":5,"line":8,"name":"Colonoscopy","date":"","time":""},
  {"type":"functional","page":3,"line":6,"scale":"ECOG","value":"1","date":"","time":""},
  {"type":"functional","page":3,"line":7,"scale":"OTHER","name":"Ambulation","value":"Uses a cane","date":"","time":""},
  {"type":"encounter","page":1,"line":20,"description":"Primary care visit","status":"completed","date":"","time":""},
  {"type":"document","docType":"progress","title":"PRIMARY CARE NOTE","author":"","date":"","time":"","startPage":3,"startLine":16,"endPage":4,"endLine":12}
 ],
 "unmapped": [{"startPage":1,"startLine":1,"endPage":1,"endLine":15,"kind":"content","reason":"fax cover sheet"}, {"startPage":2,"startLine":1,"endPage":2,"endLine":2,"kind":"layout","reason":"page header"}]
}`;
function buildPrompt(batch, context, deid) {
  const lines = [];
  lines.push('You are extracting structured clinical data from a printed or exported medical record so it can be loaded into an electronic health record viewer.');
  lines.push('The text below was produced from the document. Each page starts with "=== PAGE n ===" and each line starts with its line number and "|".');
  if (deid) {
    lines.push('Identifying information has been replaced by placeholders before sending: [D-n] is a date, [PATIENT] is the patient, [PER-n] is another person (clinician or family member), [ID-n] is an identifier, [PH-n] a phone or fax number, [ADDR-n] an address, [EMAIL-n], [URL-n], [IP-n], [TERM-n] other removed text, [AGE 90+] an age of 90 or more.');
    lines.push('Copy placeholders exactly as they appear (for example "date":"[D-3]" or "author":"[PER-2]"). Never guess, invent or reconstruct a real date, name or number.');
  } else {
    lines.push('Also fill the "patient" object (name, date of birth as YYYY-MM-DD, sex, medical record number) when the document states them; leave fields empty otherwise.');
  }
  lines.push('');
  lines.push('Reply with ONLY one JSON object shaped like this example (field values here are illustrations only):');
  lines.push(EXTRACT_SCHEMA);
  lines.push('');
  lines.push('Rules:');
  lines.push('- One item per measured value: every lab result and every vital-sign measurement is its own item. A blood pressure is one vital item with value "systolic/diastolic".');
  lines.push('- vital is one of BP, PULSE, RESP, TEMP, SPO2, WEIGHT, HEIGHT, BMI, PAIN, OTHER.');
  lines.push('- "date" is the date that applies to the item, copied exactly as written in the text' + (deid ? ' (normally a [D-n] placeholder)' : '') + '; "time" is HH:MM in 24-hour form if a time is printed. For a lab block use its collection date; for a table with one column per date, emit one item per filled cell with that column\'s date; for a list under a dated heading use the heading\'s date. Use "" when no date applies.');
  lines.push('- "page" and "line" point to the line where the item\'s value is printed. Copy "value" exactly as printed (number only, no units); copy "flag" exactly as printed (H, L, HH, LL, A, *, High, Low, Abnormal), else "". Copy "refRange" exactly as printed.');
  lines.push('- functional items record functional status. scale is ECOG (0-5), KARNOFSKY (0-100), LANSKY (0-100, the children\'s play-performance scale), PPS (palliative performance scale, 0-100) or OTHER. For the four scales "value" is the score as printed (number only, no % sign). For OTHER (activities of daily living, mobility, self-care, cognition and similar findings that are not one of those scales) give the finding in "name" and the result as printed in "value". Do not make functional items from narrative note text.');
  lines.push('- Notes, consults, discharge summaries, radiology, pathology and other narrative reports are "document" items. docType is one of progress, consult, discharge, radiology, pathology, other. Give the full line range including header and signature. Do NOT copy document text; the viewer takes it from the cited lines.');
  lines.push('- Only create problem items from an actual problem list or diagnosis list. Never from note text, headings, page headers or footers, instructions or education material.');
  lines.push('- When an item spans several lines (a key/value block such as an allergy with Reaction and Type lines, a medication with its instructions, a lab comment line), add "endPage" and "endLine" for its last line.');
  lines.push('- Put everything that is not one of the item types into "unmapped" with a short reason and a kind: "layout" for section headings, column headings, page headers and footers, page numbers and continuation markers; "content" for cover sheets, disclaimers, education handouts and any other text.');
  lines.push('- Every non-blank line on the PAGES (not the context) should belong to an item, a document range, or an unmapped range.');
  if (context && context.length) {
    lines.push('- Lines under "CONTEXT" come from the previous page. Use them only to find a date or heading that applies to items on the pages; do not create items from them.');
    lines.push('');
    lines.push('=== CONTEXT (end of previous page) ===');
    lines.push(...context);
  }
  lines.push('');
  for (const pg of batch) { lines.push('=== PAGE ' + pg.page + ' ==='); pg.lines.forEach((l, i) => lines.push((i + 1) + '|' + l)); }
  return lines.join('\n');
}
function makeBatches(pages, maxChars) {
  const out = []; let cur = [], size = 0;
  for (const pg of pages) { const len = pg.lines.reduce((a, l) => a + l.length + 6, 0); if (cur.length && size + len > maxChars) { out.push(cur); cur = []; size = 0; } cur.push(pg); size += len; }
  if (cur.length) out.push(cur); return out;
}

/* ---------------- pages from a file ---------------- */
async function filePages(name, buf) {
  const head = new Uint8Array(buf.slice(0, 5));
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  let lines, numPages = 1, empty = [], format;
  if (isPdf) { const r = await pdfToLines(buf); lines = r.lines; numPages = r.numPages; empty = r.empty; format = 'pdf'; }
  else {
    let text = decodeText(buf).replace(/^﻿/, ''); format = 'text';
    if (/^\s*</.test(text) && /<html|<body|<div|<table/i.test(text.slice(0, 5000))) { text = htmlToText(text); format = 'html'; }
    const pg = text.split('\f'); lines = []; pg.forEach((p, pi) => p.split(/\r\n|\r|\n/).forEach((x, li) => lines.push({ text: x, page: pi + 1, line: li + 1 }))); numPages = pg.length;
  }
  const pages = []; for (let p = 1; p <= numPages; p++) { const pl = lines.filter(l => l.page === p); if (pl.length) pages.push({ page: p, lines: pl.map(l => l.text) }); }
  return { format, numPages, empty, lines, pages };
}
function isClaudeEligible(name, buf) {
  const head = new Uint8Array(buf.slice(0, 5));
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return true;
  if (head[0] === 0x50 && head[1] === 0x4b) return false;
  if (/\.(png|jpe?g|gif|tiff?|bmp|dcm)$/i.test(name)) return false;
  const t = decodeText(buf.slice(0, 20000)).replace(/^﻿/, '').trimStart();
  if (/<(?:[A-Za-z_][\w.-]*:)?ClinicalDocument\b/.test(t) || /^MSH\|/.test(t) || (/^[\[{]/.test(t) && /"resourceType"\s*:/.test(t))) return false;
  return true;
}
/* Step 1 (local): read the file, find the patient, and de-identify (or not). Nothing leaves the browser here. */
async function prepareClaudeImport(name, buf, opts) {
  buf = buf.slice(0); // keep our own copy: pdf.js detaches buffers it is given
  const fp = await filePages(name, buf.slice(0));
  const ident = findIdentity(fp.lines, new Set());
  const idName = ident && ident.name ? { family: ident.name.family, given: ident.name.given } : null;
  const deid = opts.mode === 'deid' ? deidentify(fp.pages, idName, opts.extraTerms || [], ident && ident.mrn ? [ident.mrn.value] : []) : null;
  return { name, buf, fp, ident, deid, mode: opts.mode };
}
/* Step 2: send batches through `call(prompt) -> Promise<object>` and ingest. */
async function runClaudeImport(prep, call, opts) {
  opts = opts || {};
  const { name, buf, fp, ident, deid, mode } = prep;
  const sendPages = deid ? deid.pages : fp.pages;
  const file = { id: uid(), name, size: buf.byteLength, importedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), sha256: await sha256(buf.slice(0)), format: fp.format, pages: fp.numPages, method: mode === 'deid' ? 'claude-deidentified' : 'claude-direct' };
  const report = { file: name, format: (fp.format === 'pdf' ? 'PDF' : 'Text') + ' — Claude extraction (' + (mode === 'deid' ? 'identifiers removed before sending' : 'no substitution, approved endpoint') + ')', counts: {}, merged: 0, warnings: [], defaultPatient: opts.defaultPatient, patientKey: null, claude: { batches: 0, items: 0, rejected: 0, fallbackPages: [] } };
  if (deid) report.claude.replaced = deid.counts;
  // patient
  let pKey = null;
  if (ident && ident.name) {
    const p = { name: [{ family: ident.name.family || undefined, given: ident.name.given.length ? ident.name.given : undefined }] };
    if (ident.dob) p.birthDate = ident.dob; if (ident.gender) p.gender = ident.gender; if (ident.mrn) p.identifier = [{ type: { text: ident.mrn.label }, value: ident.mrn.value }];
    const at = fp.lines[ident.line];
    pKey = upsertPatient(p, file, { pages: at.page, locator: 'p.' + at.page + ' line ' + at.line + ' (' + ident.how + ', found in the viewer)' });
    report.identity = (p.name[0].family || '').toUpperCase() + ',' + (p.name[0].given || []).join(' ').toUpperCase() + (ident.dob ? '  DOB ' + ident.dob : '') + ' — found on p.' + at.page + ' line ' + at.line + ' (' + ident.how + ')';
  }
  const batches = makeBatches(sendPages, opts.maxChars || 12000);
  const results = []; // {pageSet, json}
  for (let bi = 0; bi < batches.length; bi++) {
    if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
    const b = batches[bi]; const first = b[0].page;
    const prev = sendPages.find(p => p.page === first - 1);
    const context = prev ? prev.lines.slice(-12).filter(l => l.trim()).map(l => 'p' + prev.page + '|' + l) : [];
    if (opts.onProgress) opts.onProgress('Pages ' + b[0].page + (b.length > 1 ? '–' + b[b.length - 1].page : '') + ' (' + (bi + 1) + ' of ' + batches.length + ')…');
    const tryCall = async pagesSubset => { report.claude.batches++; return await call(buildPrompt(pagesSubset, context, !!deid)); };
    try { results.push({ pages: b.map(p => p.page), json: await tryCall(b) }); }
    catch (e) {
      const FATAL = ['cancelled', 'not_granted', 'rate_limited', 'unavailable', 'network', 'auth', 'sampling_disabled', 'session_expired', 'capability_disabled', 'capability_removed'];
      if (e && FATAL.includes(e.code)) throw e;
      if (b.length > 1) { for (const pg of b) { try { results.push({ pages: [pg.page], json: await tryCall([pg]) }); } catch (e2) { if (e2 && FATAL.includes(e2.code)) throw e2; results.push({ pages: [pg.page], error: e2 }); } } }
      else results.push({ pages: b.map(p => p.page), error: e });
    }
  }
  if (!pKey) {
    const pj = results.map(r => r.json && r.json.patient).find(p => p && (p.family || p.given));
    if (!deid && pj) { pKey = upsertPatient({ name: [{ family: pj.family || undefined, given: pj.given ? String(pj.given).split(/\s+/) : undefined }], birthDate: /^\d{4}-\d{2}-\d{2}$/.test(pj.dob || '') ? pj.dob : undefined, gender: sexOf(pj.sex) || undefined, identifier: pj.mrn ? [{ type: { text: 'MRN' }, value: String(pj.mrn) }] : undefined }, file, { locator: 'reported by Claude extraction' }); report.identity = 'from Claude extraction'; }
    else { pKey = report.defaultPatient || ensureUnknownPatient(file); report.warnings.push('No patient name found in the file; items were assigned to ' + (state.patients.find(p => p.key === pKey) || {}).resource.name[0].family + '.'); }
  }
  report.patientKey = pKey;
  ingestClaude(results, { file, report, pKey, fp, sendPages, deid });
  // pages Claude could not process fall back to the built-in rules
  const failed = [...new Set(results.filter(r => r.error).flatMap(r => r.pages))];
  if (failed.length) {
    report.claude.fallbackPages = failed;
    report.warnings.push('Claude could not process page(s) ' + pagesStr(new Set(failed)) + ' (' + ((results.find(r => r.error).error || {}).code || 'error') + '); the built-in rules were used for them.');
    const sub = fp.lines.filter(l => failed.includes(l.page));
    const fr = Object.assign({}, report, { counts: report.counts, defaultPatient: pKey });
    const f2 = Object.assign({}, file, { method: 'rules (fallback)' });
    importTextLines(sub, f2, fr, true); report.merged = fr.merged;
  }
  for (const p of fp.empty) addUnstructured('Page ' + p + ' has no text layer (probably a scanned image). It was not sent to Claude and was not interpreted.', file, { pages: p, locator: 'whole page (image only)' }, pKey, report, { label: 'Image-only page', date: null });
  file.report = report; state.files.push(file);
  return [report];
}

/* ---------------- ingest + verification ---------------- */
function ingestClaude(results, ctx) {
  const { file, report, pKey, fp, sendPages, deid } = ctx;
  const map = deid ? deid.map : new Map();
  const origLine = (p, l) => { const pg = fp.pages.find(x => x.page === p); return pg ? pg.lines[l - 1] : undefined; };
  const sentLine = (p, l) => { const pg = sendPages.find(x => x.page === p); return pg ? pg.lines[l - 1] : undefined; };
  const covered = new Set(); const cover = (p, a, b) => { for (let l = a; l <= b; l++) covered.add(p + ':' + l); };
  const layout = [];
  // page headers/footers repeated on most pages, section/column headings and continuation markers are layout, not data
  const rep = new Set(); if (fp.pages.length >= 2) { const cnt = new Map(); for (const pg of fp.pages) { const seen = new Set(); const nb = pg.lines.map((t, i) => [t, i]).filter(x => x[0].trim()); for (const [t] of nb.slice(0, 3).concat(nb.slice(-2))) { const k = t.trim().replace(/\d+/g, '#').replace(/\s+/g, ' '); if (!seen.has(k)) { seen.add(k); cnt.set(k, (cnt.get(k) || 0) + 1); } } } for (const [k, n] of cnt) if (n >= Math.max(2, Math.ceil(fp.pages.length * 0.6))) rep.add(k); }
  const isLayout = t => { const x = t.trim(); return !!x && (rep.has(x.replace(/\d+/g, '#').replace(/\s+/g, ' ')) || !!headingOf(x) || /^[=\-_*~]{4,}$/.test(x) || /^(Test|Test name|Component|Analyte|Date\s*\/?\s*Time)\b.*\b(Result|Value|Your Value|Measurement)\b/i.test(x) || /^(Collection DT|Collected(?: on)?|Collection Date(?:\/Time)?|Date Collected|Specimen|Performing Lab(?:oratory)?|Performed (?:by|at)|Resulted|Received|Reported)\b\s*:?/i.test(x) || /^[(\[]?\s*(cont(inued|'d|\.)?|continued\s+(on|from)\s+(next|previous|prior)\s+page.*|page\s+\d+(\s+of\s+\d+)?)\s*[)\]]?$/i.test(x)); };
  const R = s => restoreTokens(s, map);
  const str = v => v == null ? '' : String(v).trim();
  const method = deid ? 'claude-deidentified' : 'claude-direct';
  const loc = (p, a, b) => ({ pages: a && b && p !== b.p ? p + '-' + b.p : p, locator: 'p.' + p + ' line ' + a + (b ? ' – p.' + b.p + ' line ' + b.l : '') + ' (Claude extraction' + (deid ? ', de-identified' : '') + ')', method });
  const dateOf = (v, time) => {
    v = str(v); time = str(time); if (!v) return null;
    let iso = null; const tk = v.match(/\[D-\d+\]/);
    if (tk) { const e = map.get(tk[0]); iso = e && e.iso; if (!iso && e) { const f = findDate(e.orig); iso = f && f.iso.slice(0, 10); } if (!iso) return null; }
    else if (!deid) { const f = findDate(v); if (!f) return null; if (f.iso.length > 10 && !time) return f.iso; iso = f.iso.slice(0, 10); }
    else return null; // a literal date in de-identified mode cannot be trusted
    const tm = (time || v.replace(/\[D-\d+\]/, '')).match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (iso.length === 10 && tm) return fhirDT(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10), +tm[1], +tm[2], 0);
    return iso;
  };
  const near = (p, l, needle) => {
    if (!needle) return true; const n = String(needle).toUpperCase().replace(/[,\s]/g, '');
    for (let k = l - 2; k <= l + 2; k++) { const s = sentLine(p, k); if (s && s.toUpperCase().replace(/[,\s]/g, '').includes(n)) return 'line'; }
    const pg = sendPages.find(x => x.page === p); if (pg && pg.lines.join(' ').toUpperCase().replace(/[,\s]/g, '').includes(n)) return 'page';
    return false;
  };
  const reject = (it, why) => {
    report.claude.rejected++; const p = +it.page, l = +it.line || +it.startLine;
    const txt = origLine(p, l); const shown = txt != null ? txt : JSON.stringify(it);
    addUnstructured(shown, file, { pages: p || null, locator: (p ? 'p.' + p + ' line ' + l + ' ' : '') + '(Claude result rejected: ' + why + ')', method }, pKey, report, { label: 'Not verified — ' + why });
    if (p && l) cover(p, l, l);
  };
  for (const res of results) {
    if (!res.json) continue; const j = res.json; const pagesOk = new Set(res.pages);
    for (const it of Array.isArray(j.items) ? j.items : []) {
      report.claude.items++;
      const p = +it.page, l = +it.line, type = str(it.type).toLowerCase();
      if (type === 'document') {
        const sp = +it.startPage || p, sl = +it.startLine, ep = +it.endPage || sp, el = +it.endLine;
        if (!pagesOk.has(sp) || !sl || !el || origLine(sp, sl) === undefined || origLine(ep, el) === undefined || ep < sp || (ep === sp && el < sl)) { reject(it, 'document range not found'); continue; }
        const body = []; for (const pg of fp.pages.filter(x => x.page >= sp && x.page <= ep)) { const a = pg.page === sp ? sl : 1, b = pg.page === ep ? el : pg.lines.length; for (let k = a; k <= b; k++) { body.push(pg.lines[k - 1]); covered.add(pg.page + ':' + k); } }
        const kind = { progress: 'note', consult: 'consult', discharge: 'dcsumm', radiology: 'radiology', pathology: 'pathology' }[str(it.docType).toLowerCase()] || 'note';
        const L = DOC_LOINC[kind];
        const r = makeDoc({ title: R(str(it.title)) || L[1], date: dateOf(it.date, it.time), author: R(str(it.author)) || undefined, custodian: undefined, body: body.join('\n').replace(/\s+$/, ''), loincCode: L[0], loincDisplay: L[1] });
        addResource(r, file, Object.assign(loc(sp, sl, { p: ep, l: el }), { pages: sp === ep ? String(sp) : sp + '-' + ep }), pKey, report); continue;
      }
      if (!pagesOk.has(p) || !l || origLine(p, l) === undefined) { reject(it, 'cited page/line does not exist'); continue; }
      let r = null, check = null;
      if (type === 'lab') {
        const name = R(str(it.name)); const val = str(it.value); if (!name || !val) { reject(it, 'missing test name or value'); continue; }
        check = near(p, l, val); const chkName = near(p, l, name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6));
        if (!check || !chkName) { reject(it, 'value or test name not found on the cited line'); continue; }
        const unit = R(str(it.unit)); const m = val.match(/^([<>]=?)?\s*(-?\d+(?:\.\d+)?)$/);
        r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: 'laboratory', display: 'Laboratory' }] }], code: labCode(name, str(it.specimen) + ' ' + str(it.panel), !!m) };
        const dt = dateOf(it.date, it.time); if (dt) r.effectiveDateTime = dt; else report.warnings.push('Lab "' + name + '" (p.' + p + ' line ' + l + ') has no date.');
        if (m) { r.valueQuantity = qty(m[2], unit || undefined); if (m[1]) r.valueQuantity.comparator = m[1]; } else r.valueString = R(val);
        const rr = parseRange(R(str(it.refRange)), unit); if (rr) r.referenceRange = [rr];
        const fl = flagCode(str(it.flag)); if (fl) r.interpretation = [fl];
        if (str(it.specimen)) r.specimen = { display: R(str(it.specimen)) };
        if (str(it.performer)) r.performer = [{ display: R(str(it.performer)) }];
        if (str(it.comment)) r.note = [{ text: R(str(it.comment)) }];
      } else if (type === 'vital') {
        const val = str(it.value); check = near(p, l, val); if (!val || !check) { reject(it, 'value not found on the cited line'); continue; }
        const kmap = { BP: 'bp', PULSE: 'hr', HR: 'hr', RESP: 'rr', RR: 'rr', TEMP: 'temp', SPO2: 'spo2', WEIGHT: 'wt', HEIGHT: 'ht', BMI: 'bmi', PAIN: 'pain' };
        const k = kmap[str(it.vital).toUpperCase()]; const unit = str(it.unit); const dt = dateOf(it.date, it.time);
        if (k === 'bp') { const bm = val.match(/(\d{2,3})\s*\/\s*(\d{2,3})/); if (!bm) { reject(it, 'blood pressure not in systolic/diastolic form'); continue; } r = makeVital('bp', [null, bm[1], bm[2]], dt); }
        else if (k) { const nm = val.match(/-?\d+(?:\.\d+)?/); if (!nm) { reject(it, 'non-numeric vital sign'); continue; }
          const u = k === 'temp' ? (/c/i.test(unit) && !/f/i.test(unit) ? 'C' : (/f/i.test(unit) ? 'F' : undefined)) : k === 'wt' ? (/kg/i.test(unit) ? 'kg' : 'lb') : k === 'ht' ? (/cm/i.test(unit) ? 'cm' : 'in') : null;
          r = makeVital(k, [null, nm[0], u], dt); }
        else { r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: 'vital-signs', display: 'Vital Signs' }] }], code: { text: R(str(it.name)) || 'Vital sign' }, valueString: R(val) }; if (dt) r.effectiveDateTime = dt; }
        if (!dt) report.warnings.push('Vital sign (p.' + p + ' line ' + l + ') has no date.');
      } else if (type === 'functional') {
        const sk = str(it.scale).toUpperCase().replace(/[^A-Z]/g, ''); const scale = { ECOG: 'ecog', ZUBROD: 'ecog', KARNOFSKY: 'karnofsky', KPS: 'karnofsky', LANSKY: 'lansky', PPS: 'pps', PALLIATIVEPERFORMANCESCALE: 'pps' }[sk] || null;
        const val = str(it.value).replace(/\s*%$/, ''); const dt = dateOf(it.date, it.time);
        if (scale) {
          const nm = val.match(/^\d{1,3}$/); const sc = FUNC_SCALES[scale];
          if (!nm || +val > sc.max || (sc.step > 1 && +val % 5)) { reject(it, 'not a valid ' + sc.short + ' score'); continue; }
          const alias = { ecog: /ECOG|ZUBROD|WHO|PERFORMANCE/i, karnofsky: /KARNOFSKY|KPS/i, lansky: /LANSKY/i, pps: /PALLIATIVE|PPS/i }[scale];
          let named = false; for (let k = l - 2; k <= l + 2 && !named; k++) { const t = sentLine(p, k); if (t && alias.test(t)) named = true; }
          check = near(p, l, val); if (!named || !check) { reject(it, sc.short + ' score or scale name not found on the cited line'); continue; }
          r = makeFunc(scale, [null, val], dt);
        } else {
          const nm2 = R(str(it.name)); const v2 = R(val); if (!nm2 || !v2) { reject(it, 'functional finding without a name or result'); continue; }
          check = near(p, l, val.replace(TOKEN_RE, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)); const chkN = near(p, l, str(it.name).replace(TOKEN_RE, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6));
          if (!check || !chkN) { reject(it, 'functional finding not found on the cited line'); continue; }
          r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: 'survey', display: 'Survey' }] }, { coding: [{ system: CS_LOCAL, code: FUNC_CAT, display: 'Functional status' }] }], code: { text: nm2 }, valueString: v2 };
          if (dt) r.effectiveDateTime = dt;
        }
        if (!dt) report.warnings.push('Functional status (p.' + p + ' line ' + l + ') has no date.');
      } else if (type === 'problem') {
        const text = R(str(it.text)); check = near(p, l, str(it.text).replace(TOKEN_RE, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)); if (!text || !check) { reject(it, 'problem text not found on the cited line'); continue; }
        const cc = { text }; const cs = str(it.codeSystem).toUpperCase(); if (str(it.code)) cc.coding = [{ system: /SNOMED|SCT/.test(cs) ? SCT : /9/.test(cs) ? 'http://hl7.org/fhir/sid/icd-9-cm' : 'http://hl7.org/fhir/sid/icd-10-cm', code: str(it.code), display: text }];
        r = { resourceType: 'Condition', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }], code: cc, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: /resolv|inactive|historical/i.test(str(it.status)) ? 'resolved' : 'active' }] } };
        const dt = dateOf(it.date); if (dt) r.onsetDateTime = dt;
      } else if (type === 'medication') {
        const nmx = R(str(it.name)); check = near(p, l, str(it.name).replace(TOKEN_RE, '').replace(/[^A-Za-z]/g, '').slice(0, 6)); if (!nmx || !check) { reject(it, 'medication not found on the cited line'); continue; }
        r = { resourceType: 'MedicationStatement', status: /discontinu|stopped|expired|inactive/i.test(str(it.status)) ? 'stopped' : 'active', medicationCodeableConcept: { text: nmx } };
        if (str(it.sig)) r.dosage = [{ text: R(str(it.sig)) }]; const dt = dateOf(it.date); if (dt) r.effectiveDateTime = dt;
      } else if (type === 'allergy') {
        const sub = R(str(it.substance)); check = near(p, l, str(it.substance).replace(/[^A-Za-z]/g, '').slice(0, 6)); if (!sub || !check) { reject(it, 'allergy not found on the cited line'); continue; }
        r = { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, code: { text: sub } };
        if (/^(nka|nkda|no known)/i.test(sub)) r.code = { coding: [{ system: SCT, code: '716186003', display: 'No known allergy' }], text: sub };
        if (str(it.reaction)) r.reaction = [{ manifestation: R(str(it.reaction)).split(/[,;]\s*/).filter(Boolean).map(t => ({ text: t })), severity: ['mild', 'moderate', 'severe'].includes(str(it.severity).toLowerCase()) ? str(it.severity).toLowerCase() : undefined }];
        const dt = dateOf(it.date); if (dt) r.recordedDate = dt;
      } else if (type === 'immunization') {
        const v = R(str(it.vaccine)); check = near(p, l, str(it.vaccine).replace(/[^A-Za-z]/g, '').slice(0, 5)); if (!v || !check) { reject(it, 'immunization not found on the cited line'); continue; }
        const dt = dateOf(it.date); r = { resourceType: 'Immunization', status: 'completed', vaccineCode: { text: v } }; if (dt) r.occurrenceDateTime = dt; else r.occurrenceString = 'date not stated';
      } else if (type === 'procedure') {
        const v = R(str(it.name)); check = near(p, l, str(it.name).replace(/[^A-Za-z]/g, '').slice(0, 5)); if (!v || !check) { reject(it, 'procedure not found on the cited line'); continue; }
        r = { resourceType: 'Procedure', status: 'completed', code: { text: v } }; const dt = dateOf(it.date, it.time); if (dt) r.performedDateTime = dt;
      } else if (type === 'encounter' || type === 'appointment') {
        const dt = dateOf(it.date, it.time); if (!dt) { reject(it, 'visit without a date'); continue; }
        const desc = R(str(it.description)) || 'Visit';
        if (/sched|booked|upcoming|future/i.test(str(it.status)) || type === 'appointment') r = { resourceType: 'Appointment', status: 'booked', start: dt, description: desc };
        else r = { resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' }, type: [{ text: desc }], period: { start: dt } };
      } else { reject(it, 'unknown item type "' + type + '"'); continue; }
      const ep = +it.endPage || p, el = +it.endLine || l;
      const L = (ep !== p || el !== l) && origLine(ep, el) !== undefined ? loc(p, l, { p: ep, l: el }) : loc(p, l); if (check === 'page') L.locator += ' — value found elsewhere on the page';
      addResource(r, file, L, pKey, report); cover(p, l, l);
      if (origLine(ep, el) !== undefined && (ep > p || (ep === p && el > l)) && (ep - p) <= 1) { for (const pg of fp.pages.filter(x => x.page >= p && x.page <= ep)) { const a2 = pg.page === p ? l : 1, b2 = pg.page === ep ? el : pg.lines.length; for (let k = a2; k <= b2; k++) covered.add(pg.page + ':' + k); } }
      if (type === 'lab' && str(it.comment)) { const nx = origLine(p, l + 1); if (nx && /^\s*(comment|note)s?\s*:/i.test(nx)) cover(p, l + 1, l + 1); }
    }
    for (const u of Array.isArray(j.unmapped) ? j.unmapped : []) {
      const sp = +u.startPage || +u.page, sl = +u.startLine, ep = +u.endPage || sp, el = +u.endLine || sl;
      if (!pagesOk.has(sp) || !sl || origLine(sp, sl) === undefined) continue;
      if (str(u.kind).toLowerCase() === 'layout') { for (const pg of fp.pages.filter(x => x.page >= sp && x.page <= ep)) { const a = pg.page === sp ? sl : 1, b = pg.page === ep ? Math.min(el, pg.lines.length) : pg.lines.length; for (let k = a; k <= b; k++) { if (covered.has(pg.page + ':' + k)) continue; if (pg.lines[k - 1].trim()) layout.push({ p: pg.page, l: k }); covered.add(pg.page + ':' + k); } } continue; }
      const txt = []; const ps = new Set();
      for (const pg of fp.pages.filter(x => x.page >= sp && x.page <= ep)) { const a = pg.page === sp ? sl : 1, b = pg.page === ep ? Math.min(el, pg.lines.length) : pg.lines.length; for (let k = a; k <= b; k++) { if (covered.has(pg.page + ':' + k)) continue; txt.push(pg.lines[k - 1]); covered.add(pg.page + ':' + k); ps.add(pg.page); } }
      if (txt.join('').trim()) addUnstructured(txt.join('\n'), file, { pages: pagesStr(ps), locator: 'p.' + sp + ' line ' + sl + ' – p.' + ep + ' line ' + el + ' (' + (str(u.reason) ? 'Claude: ' + R(str(u.reason)) : 'unmapped') + ')', method }, pKey, report, { label: str(u.reason) ? 'Unmapped — ' + R(str(u.reason)) : undefined });
    }
  }
  // anything Claude did not account for stays visible as unstructured content
  for (const res of results) {
    if (!res.json) continue;
    for (const p of res.pages) {
      const pg = fp.pages.find(x => x.page === p); if (!pg) continue; let run = [];
      const flush = () => { if (run.length && run.some(k => pg.lines[k - 1].trim())) addUnstructured(run.map(k => pg.lines[k - 1]).join('\n'), file, { pages: p, locator: 'p.' + p + ' line ' + run[0] + ' – ' + run[run.length - 1] + ' (not classified by Claude extraction)', method }, pKey, report, { label: 'Not classified by extraction' }); run = []; };
      pg.lines.forEach((t, i) => { const k = i + 1; if (!covered.has(p + ':' + k) && isLayout(t)) { covered.add(p + ':' + k); layout.push({ p, l: k }); } if (covered.has(p + ':' + k) || !t.trim()) { if (!t.trim() && run.length) run.push(k); else flush(); } else run.push(k); });
      flush();
    }
  }
  if (layout.length) {
    const byText = new Map(); for (const x of layout) { const t = fp.pages.find(pg => pg.page === x.p).lines[x.l - 1].trim(); const k = t.replace(/\d+/g, '#'); if (!byText.has(k)) byText.set(k, { t, pages: new Set() }); byText.get(k).pages.add(x.p); }
    addUnstructured([...byText.values()].map(v => v.t + '   [p.' + pagesStr(v.pages) + ']').join('\n'), file, { pages: pagesStr(new Set(layout.map(x => x.p))), locator: layout.length + ' layout lines (headings, column headers, page headers/footers)', method }, pKey, report, { label: 'Layout text (headings, column headers, page headers/footers)', date: null });
  }
}

/* ================= describe / export ================= */
const v = qText;
function describe(r) {
  const k = meta(r).kind || kindOf(r); const d = { kind: k, type: r.resourceType };
  switch (r.resourceType) {
    case 'Observation': {
      d.date = obsDate(r); d.name = codeText(r.code);
      { const ov = obsValue(r); d.value = ov.value; d.unit = ov.unit; }
      const rr = (r.referenceRange || [])[0]; if (rr) { d.low = rr.low ? rr.low.value : ''; d.high = rr.high ? rr.high.value : ''; d.range = rr.text || [d.low, d.high].filter(x => x !== '').join(' - '); }
      const it = (r.interpretation || [])[0]; if (it) { d.flag = ((it.coding || [])[0] || {}).code || it.text; if (d.flag === 'N') d.flag = ''; }
      d.specimen = r.specimen && (r.specimen.display || r.specimen.reference) || ''; d.performer = (r.performer || []).map(p => p.display || p.reference).join('; ');
      d.comments = (r.note || []).map(n => n.text).join(' / '); d.status = r.status; d.issued = r.issued; d.code = ((r.code.coding || [])[0] || {});
      if (k === 'func') { const fi = funcInfo(r); if (fi) { d.scale = fi.scale; d.score = fi.score; d.meaning = fi.meaning; d.name = FUNC_SCALES[fi.scale].name; } }
      break;
    }
    case 'Condition': d.name = codeText(r.code); d.date = r.onsetDateTime || r.recordedDate || (r.onsetPeriod || {}).start; d.status = ((r.verificationStatus || {}).coding || [{}])[0].code === 'refuted' ? 'refuted' : ((r.clinicalStatus || {}).coding || [{}])[0].code || ''; d.end = r.abatementDateTime; d.code = ((r.code.coding || [])[0] || {}); break;
    case 'AllergyIntolerance': d.name = codeText(r.code); d.date = r.onsetDateTime || r.recordedDate; d.reaction = (r.reaction || []).flatMap(x => (x.manifestation || []).map(codeText)).join(', '); d.severity = (r.reaction || []).map(x => x.severity).filter(Boolean).join(', ') || r.criticality || ''; d.status = ((r.clinicalStatus || {}).coding || [{}])[0].code || ''; d.category = (r.category || []).join(', '); break;
    case 'MedicationRequest': case 'MedicationStatement': d.name = medName(r); d.date = r.authoredOn || (r.effectivePeriod || {}).start || r.effectiveDateTime || r.dateAsserted; d.end = (r.effectivePeriod || {}).end; d.status = r.status; d.sig = ((r.dosageInstruction || r.dosage || [])[0] || {}).text || ''; d.comments = (r.note || []).map(n => n.text).join(' / '); break;
    case 'Immunization': d.name = codeText(r.vaccineCode); d.date = r.occurrenceDateTime; d.status = r.status; break;
    case 'Procedure': d.name = codeText(r.code); d.date = r.performedDateTime || (r.performedPeriod || {}).start; d.status = r.status; break;
    case 'Encounter': d.name = codeText((r.type || [])[0]) || (r.class || {}).display || 'Encounter'; d.date = (r.period || {}).start; d.end = (r.period || {}).end; d.status = r.status; d.location = (r.location || []).map(l => l.location.display).filter(Boolean).join(', ') || (r.serviceProvider || {}).display || ''; d.reason = (r.reasonCode || []).map(codeText).join(', '); break;
    case 'Appointment': d.name = r.description || codeText((r.serviceType || [])[0]) || 'Appointment'; d.date = r.start; d.status = r.status; break;
    case 'DocumentReference': case 'DiagnosticReport':
      d.name = r.description || codeText(r.type) || codeText(r.code) || 'Document'; d.date = r.date || ((r.context || {}).period || {}).start || r.effectiveDateTime || (r.effectivePeriod || {}).start || r.issued;
      d.author = (r.author || r.performer || r.resultsInterpreter || []).map(a => a.display || a.reference).join('; '); d.custodian = (r.custodian || {}).display || '';
      d.status = r.status; break;
    default: d.name = codeText(r.code) || codeText(r.type) || r.resourceType; d.date = r.date || r.created || r.recorded || r.authoredOn || (r.period || r.billablePeriod || {}).start;
  }
  return d;
}
function filterRes(patientKey) { return state.resources.filter(r => !patientKey || meta(r).patientKey === patientKey); }
function exportBundle(patientKey, o) {
  o = Object.assign({ includeOther: true, includeUnstructured: true }, o || {});
  const pats = state.patients.filter(p => !patientKey || p.key === patientKey).map(p => p.resource);
  const res = filterRes(patientKey).filter(r => { const k = meta(r).kind; if (k === 'other' && !o.includeOther) return false; if (k === 'unstructured' && !o.includeUnstructured) return false; return true; });
  const prov = state.files.map(f => {
    const tg = res.filter(r => meta(r).fileIds.has(f.id)).map(r => ({ reference: 'urn:uuid:' + r.id }));
    const pt = pats.filter(p => sources(p).some(s => s.file === f.name)).map(p => ({ reference: 'urn:uuid:' + p.id }));
    if (!tg.length && !pt.length) return null;
    return { resourceType: 'Provenance', id: uid(), target: pt.concat(tg), recorded: f.importedAt,
      activity: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation', code: 'CREATE', display: 'create' }], text: 'Imported and normalized to FHIR R4 by CPRS4CC' },
      agent: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'assembler', display: 'Assembler' }] }, who: { display: 'CPRS4CC record importer' } }],
      entity: [{ role: 'source', what: { identifier: { system: 'urn:ietf:rfc:6920', value: f.sha256 ? 'ni:///sha-256;' + f.sha256 : undefined }, display: f.name + ' (' + f.format + (f.pages ? ', ' + f.pages + ' pages' : '') + ')' } }] };
  }).filter(Boolean);
  const entry = pats.concat(res, prov).map(r => ({ fullUrl: 'urn:uuid:' + r.id, resource: JSON.parse(JSON.stringify(Object.assign({ resourceType: r.resourceType, id: r.id }, r))) }));
  return { resourceType: 'Bundle', id: uid(), meta: { lastUpdated: new Date().toISOString() }, type: 'collection', timestamp: new Date().toISOString(), entry };
}
function exportNDJSON(patientKey, o) { return exportBundle(patientKey, o).entry.map(e => JSON.stringify(e.resource)).join('\n') + '\n'; }
function exportCSV(patientKey) {
  const cols = ['patient', 'resource_type', 'category', 'date_time', 'name', 'code_system', 'code', 'value', 'units', 'ref_low', 'ref_high', 'ref_text', 'flag', 'specimen', 'performer_or_author', 'status', 'comments', 'source_files', 'source_pages', 'source_locators', 'fhir_id'];
  const esc = x => { const s = x == null ? '' : String(x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [cols.join(',')];
  for (const r of filterRes(patientKey)) {
    const d = describe(r); const s = sources(r); const p = state.patients.find(x => x.key === meta(r).patientKey);
    const pn = p ? (p.resource.name[0].family + ',' + (p.resource.name[0].given || []).join(' ')) : '';
    const text = d.kind === 'unstructured' || ['note', 'consult', 'dcsumm', 'radiology', 'pathology'].includes(d.kind) ? docText(r).replace(/\s+/g, ' ').slice(0, 2000) : '';
    rows.push([pn, r.resourceType, d.kind, d.date, d.name, (d.code || {}).system, (d.code || {}).code, d.value != null ? d.value : (d.sig || text), d.unit, d.low, d.high, d.range, d.flag, d.specimen, d.performer || d.author, d.status, d.comments || d.reaction, s.map(x => x.file).join(' | '), s.map(x => x.pages || '').join(' | '), s.map(x => x.locator || '').join(' | '), r.id].map(esc).join(','));
  }
  return rows.join('\n') + '\n';
}
function clear() { state.patients.length = 0; state.resources.length = 0; state.files.length = 0; state.byKey.clear(); PATIENT_REFS.clear(); }

/* Manually registered patient (no source file). Returns {key, existed}. */
function addPatient(o) {
  const given = String(o.given || '').trim(), family = String(o.family || '').trim();
  const p = { name: [{ family: family || undefined, given: given ? given.split(/\s+/) : undefined, text: [given, family].filter(Boolean).join(' ') }] };
  if (o.birthDate) p.birthDate = o.birthDate;
  if (o.gender) p.gender = o.gender;
  const before = new Set(state.patients.map(x => x.key));
  const file = { id: uid(), name: 'Manual entry (CPRS4CC)', format: 'manual', importedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
  const key = upsertPatient(p, file, { locator: 'entered in the New Patient dialog' });
  return { key, existed: before.has(key) };
}
root.CPRSEngine = { funcScales: FUNC_SCALES, funcInfo, prepareClaudeImport, runClaudeImport, isClaudeEligible, deidentify, buildPrompt, restoreTokens, makeBatches, addPatient, LAB_CAT, lookupLab, _pdfToLines: pdfToLines, deps, state, importFile, exportBundle, exportNDJSON, exportCSV, sources, docText, describe, codeText, medName, meta, kindOf, clear, setMerge: b => { MERGE = !!b; }, EXT_SRC, findDate, CS_LOCAL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
