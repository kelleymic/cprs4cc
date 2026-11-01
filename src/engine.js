/* CPRS4CC import/normalization engine.
 * Every imported item is normalized to an HL7 FHIR R4 (US Core-aligned) resource.
 * Each resource carries one or more source-reference extensions (file, pages/locator, format).
 * Works in the browser and in Node (inject DOMParser / pdfjs / JSZip via Engine.deps). */
(function (root) {
'use strict';

const EXT_SRC = 'https://cprs4cc.example.org/fhir/StructureDefinition/source-reference';
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
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
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
function htmlToText(h) {
  return String(h).replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<\/t[dh]>/gi, '  ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
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
  const q = { value: Number(value) }; if (unit) { q.unit = unit; const u = UCUM_MAP[String(unit).toLowerCase()]; if (u) { q.system = UCUM; q.code = u; } }
  return q;
}
/* Lab name -> LOINC. The catalog (catalog.txt, ~200 common results incl. serum tumor markers) is injected at build time.
   Mapping is by printed name and specimen; the printed name is always kept in code.text and the added coding is userSelected:false. */
const LAB_CATALOG_TXT = `/*CATALOG*/`;
const NN = s => String(s || '').toUpperCase().replace(/%/g, ' PCT ').replace(/#/g, ' ABS ').replace(/[^A-Z0-9]+/g, ' ').replace(/\bANTIGEN\b/g, 'AG').replace(/\b(ANTIBODY|ANTIBODIES)\b/g, 'AB').replace(/\s+/g, ' ').trim();
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

/* ---------------- the store ---------------- */
const M = new WeakMap();            // resource -> {patientKey, fileIds:Set, kind, dkey}
const state = { patients: [], resources: [], files: [], byKey: new Map() };
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
  const fam = norm((p.name && p.name[0] && p.name[0].family) || '').replace(/[0-9]/g, '').replace(/\s+/g, '');
  const giv = norm((p.name && p.name[0] && (p.name[0].given || [])[0]) || '').replace(/[0-9]/g, '').replace(/\s+/g, '');
  return fam + '|' + (giv[0] || '') + '|' + (p.birthDate || '');
}
function upsertPatient(p, file, loc) {
  let key = patientKeyOf(p);
  let ex = state.patients.find(x => x.key === key);
  if (!ex && !p.birthDate) ex = state.patients.find(x => x.key.startsWith(key.split('|').slice(0, 2).join('|') + '|'));
  if (ex) {
    for (const id of p.identifier || []) if (!(ex.resource.identifier || []).some(i => i.value === id.value)) (ex.resource.identifier = ex.resource.identifier || []).push(id);
    if (!ex.resource.gender && p.gender) ex.resource.gender = p.gender;
    if (!(ex.resource.address || []).length && p.address) ex.resource.address = p.address;
    ex.resource.extension.push(srcExt(file, loc));
    return ex.key;
  }
  const r = clone(p); r.resourceType = 'Patient'; r.id = uid(); delete r.meta; delete r.text;
  r.extension = (r.extension || []).filter(e => e.url !== EXT_SRC); r.extension.push(srcExt(file, loc));
  state.patients.push({ key, resource: r });
  return key;
}
function patientRef(key) { const p = state.patients.find(x => x.key === key); return p ? { reference: 'urn:uuid:' + p.resource.id } : undefined; }
function ensureUnknownPatient(file) {
  return upsertPatient({ name: [{ family: 'UNIDENTIFIED', given: ['PATIENT'], text: 'UNIDENTIFIED PATIENT' }] }, file, { locator: 'no patient identity found in file' });
}

/* ---- classification ---- */
function obsKind(r) {
  const cats = (r.category || []).flatMap(c => (c.coding || []).map(x => x.code));
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
    if (!c) continue;
    if (c.data) { let t = ''; try { t = b64ToUtf8(c.data); } catch (e) { t = '[undecodable attachment]'; } out.push(/html|xml/.test(c.contentType || '') ? htmlToText(t) : t); }
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
function primaryValue(r) {
  if (r.valueQuantity) return String(r.valueQuantity.value);
  if (r.component && r.component.length) return r.component.map(c => c.valueQuantity ? c.valueQuantity.value : codeText(c.valueCodeableConcept)).join('/');
  if (r.valueCodeableConcept) return codeText(r.valueCodeableConcept);
  return r.valueString != null ? String(r.valueString) : '';
}
function dedupeKey(r, kind) {
  const loinc = cc => { const c = (cc && cc.coding || []).find(x => x.system === LOINC || x.system === SCT); return c ? c.code : norm(codeText(cc)); };
  switch (kind) {
    case 'lab': case 'vital': case 'social': case 'survey': case 'obs-other':
      return 'obs|' + loinc(r.code) + '|' + minuteKey(r.effectiveDateTime || (r.effectivePeriod || {}).start) + '|' + primaryValue(r);
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
function remapRefs(o, map) {
  if (Array.isArray(o)) { o.forEach(x => remapRefs(x, map)); return; }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) {
    if (k === 'reference' && typeof o[k] === 'string' && map.has(o[k])) o[k] = map.get(o[k]);
    else remapRefs(o[k], map);
  }
}
function importFHIR(text, file, report) {
  let items = [];
  const t = text.trim();
  try {
    if (t.startsWith('{') || t.startsWith('[')) {
      let j;
      try { j = JSON.parse(t); } catch (e) {
        items = t.split(/\r?\n/).filter(l => l.trim()).map((l, i) => ({ res: JSON.parse(l), loc: 'NDJSON line ' + (i + 1) }));
      }
      if (j) {
        if (Array.isArray(j)) items = j.map((r, i) => ({ res: r, loc: '[' + i + ']' }));
        else if (j.resourceType === 'Bundle') items = (j.entry || []).map((e, i) => ({ res: e.resource, full: e.fullUrl, loc: 'Bundle.entry[' + i + ']' })).filter(x => x.res);
        else items = [{ res: j, loc: 'root' }];
      }
    }
  } catch (e) { report.warnings.push('Not valid JSON/NDJSON: ' + e.message); addUnstructured(text.slice(0, 20000), file, { locator: 'whole file (invalid JSON)' }, ensureUnknownPatient(file), report); return; }
  if (!items.length) { report.warnings.push('No FHIR resources found.'); return; }
  if (items.some(x => ['MedicationOrder', 'DiagnosticOrder'].includes(x.res.resourceType))) report.warnings.push('This looks like FHIR DSTU2; it was read as R4 and some fields may not map.');
  // patient(s)
  let pKey = null;
  const pats = items.filter(x => x.res.resourceType === 'Patient');
  for (const p of pats) pKey = upsertPatient(p.res, file, { locator: p.loc, originalId: 'Patient/' + p.res.id });
  if (!pKey) pKey = report.defaultPatient || ensureUnknownPatient(file);
  report.patientKey = pKey;
  const pref = patientRef(pKey).reference;
  // id remapping so internal references survive
  const map = new Map();
  for (const x of items) {
    const r = x.res; if (!r.resourceType) continue;
    if (r.resourceType === 'Patient') { for (const k of ['urn:uuid:' + r.id, 'Patient/' + r.id, x.full]) if (k) map.set(k, pref); continue; }
    x.newId = uid();
    for (const k of ['urn:uuid:' + r.id, r.resourceType + '/' + r.id, x.full]) if (k) map.set(k, 'urn:uuid:' + x.newId);
  }
  // lookup for display names of practitioners/organizations
  const disp = new Map();
  for (const x of items) {
    const r = x.res; if (!['Practitioner', 'Organization', 'Location'].includes(r.resourceType)) continue;
    const name = r.resourceType === 'Practitioner' ? ((r.name || [])[0] ? ([((r.name[0].prefix || []).join(' ')), (r.name[0].given || []).join(' '), r.name[0].family].join(' ').trim()) : '') : r.name;
    for (const k of ['urn:uuid:' + r.id, r.resourceType + '/' + r.id, x.full]) if (k) disp.set(k, name);
  }
  for (const x of items) {
    const r0 = x.res; if (!r0 || !r0.resourceType) { addUnstructured(JSON.stringify(r0, null, 1), file, { locator: x.loc }, pKey, report); continue; }
    if (r0.resourceType === 'Patient') continue;
    const r = clone(r0); const orig = r.resourceType + '/' + r.id;
    r.id = x.newId; delete r.text;
    // keep display names for performer / author references
    const fillDisp = ref => { if (ref && ref.reference && !ref.display && disp.has(ref.reference)) ref.display = disp.get(ref.reference); };
    (r.performer || []).forEach(p => fillDisp(p.actor || p)); (r.author || []).forEach(fillDisp); fillDisp(r.custodian); fillDisp(r.requester); fillDisp(r.recorder); fillDisp(r.asserter);
    (r.participant || []).forEach(p => fillDisp(p.individual || p.actor)); fillDisp(r.serviceProvider);
    remapRefs(r, map);
    if (r.resourceType === 'Observation') (r.referenceRange || []).forEach(rr => { if (!rr.low && !rr.high && rr.text) { const pr = parseRange(rr.text, (r.valueQuantity || {}).unit); if (pr && pr.low) rr.low = pr.low; if (pr && pr.high) rr.high = pr.high; } });
    const loc = { locator: x.loc + ' (' + orig + ')', originalId: orig };
    if (r.resourceType === 'DocumentReference' && (r.content || []).some(c => c.attachment && !c.attachment.data && c.attachment.url)) report.warnings.push('DocumentReference ' + orig + ' points to external content (' + r.content[0].attachment.url + '); only metadata was imported.');
    addResource(r, file, loc, pKey, report);
  }
}

/* ================= HL7 v2 (ORU) ================= */
function importHL7v2(text, file, report) {
  const segs = text.split(/\r\n|\r|\n/).filter(s => s.trim());
  if (!segs.length || !/^MSH/.test(segs[0])) { report.warnings.push('No MSH segment; not an HL7 v2 message.'); }
  const fs = segs[0] ? segs[0][3] : '|'; const comp = segs[0] ? (segs[0].split(fs)[1] || '^~\\&')[0] : '^'; const rep = segs[0] ? (segs[0].split(fs)[1] || '^~')[1] : '~';
  const F = (seg, n) => (seg[n] || ''); const C = (v, n) => (v || '').split(comp)[n] || '';
  const unesc = s => s.replace(/\\\.br\\/g, '\n').replace(/\\F\\/g, '|').replace(/\\S\\/g, '^').replace(/\\T\\/g, '&').replace(/\\R\\/g, '~').replace(/\\E\\/g, '\\');
  const xcn = v => { const p = (v || '').split(comp); const o = /^\d/.test(p[0]) ? 1 : 0; return [p[o + 1], p[o + 2], p[o]].filter(Boolean).join(' '); };
  const sendingFac = segs[0] ? C(segs[0].split(fs)[3], 0) : '';
  let pKey = null, obr = null, lastObs = null, docBuf = null;
  const flushDoc = () => {
    if (!docBuf) return;
    const kind = /RAD|IMAG|US |CT |MR|XR|X-RAY/i.test(docBuf.title + docBuf.text) ? 'radiology' : /PATH|BIOPSY/i.test(docBuf.title) ? 'pathology' : 'note';
    const L = DOC_LOINC[kind];
    const r = makeDoc({ title: docBuf.title, date: docBuf.date, author: docBuf.author, custodian: docBuf.org || sendingFac, body: docBuf.text, loincCode: L[0], loincDisplay: L[1] });
    addResource(r, file, { locator: 'segments ' + docBuf.from + '-' + docBuf.to + ' (OBR/OBX TX)' }, pKey, report); docBuf = null;
  };
  segs.forEach((line, i) => {
    const seg = line.split(fs); const id = seg[0]; const n = i + 1;
    if (id === 'MSH') return;
    if (id === 'PID') {
      const nm = F(seg, 5); const p = { name: [{ family: C(nm, 0), given: [C(nm, 1), C(nm, 2)].filter(Boolean) }], birthDate: (tsToFhir(F(seg, 7)) || '').slice(0, 10) || undefined, gender: { M: 'male', F: 'female', O: 'other', U: 'unknown' }[F(seg, 8)] };
      if (C(F(seg, 3), 0)) p.identifier = [{ type: { text: C(F(seg, 3), 4) || 'MR' }, system: 'urn:hl7v2:' + (C(F(seg, 3), 3) || sendingFac), value: C(F(seg, 3), 0) }];
      pKey = upsertPatient(p, file, { locator: 'segment ' + n + ' (PID)' }); report.patientKey = pKey; return;
    }
    if (!pKey) pKey = report.defaultPatient || ensureUnknownPatient(file);
    if (id === 'OBR') { flushDoc(); obr = { code: F(seg, 4), date: tsToFhir(F(seg, 7)), issued: tsToFhir(F(seg, 22)), prov: F(seg, 16), seg: n }; lastObs = null; return; }
    if (id === 'OBX') {
      const type = F(seg, 2), code = F(seg, 3), val = F(seg, 5), units = C(F(seg, 6), 0), range = F(seg, 7), flags = F(seg, 8), dt = tsToFhir(F(seg, 14)) || (obr && obr.date), org = C(F(seg, 23), 0);
      if (type === 'TX' || type === 'FT') {
        const t = val.split(rep).map(unesc).join('\n');
        if (!docBuf) docBuf = { title: C(obr ? obr.code : code, 1) || C(code, 1) || 'Report', date: dt, author: obr && obr.prov ? xcn(obr.prov) + ' (ordering provider)' : '', org, text: t, from: obr ? obr.seg : n, to: n };
        else { docBuf.text += '\n' + t; docBuf.to = n; }
        return;
      }
      flushDoc();
      const cc = { coding: [], text: C(code, 1) || C(code, 0) };
      if (C(code, 0)) cc.coding.push({ system: C(code, 2) === 'LN' ? LOINC : 'urn:hl7v2:' + (C(code, 2) || 'local'), code: C(code, 0), display: C(code, 1) || undefined });
      const r = { resourceType: 'Observation', status: { F: 'final', P: 'preliminary', C: 'corrected', X: 'cancelled' }[F(seg, 11)] || 'final', category: [{ coding: [{ system: OBSCAT, code: 'laboratory', display: 'Laboratory' }] }], code: cc };
      if (dt) r.effectiveDateTime = dt; if (obr && obr.issued) r.issued = obr.issued.length > 10 ? obr.issued : undefined;
      if ((type === 'NM' || type === 'SN') && /^[<>]?=?\s*-?\d/.test(val)) { const m = val.match(/^([<>]=?)?\s*(-?\d+(?:\.\d+)?)/); r.valueQuantity = qty(m[2], units); if (m[1]) r.valueQuantity.comparator = m[1]; }
      else if (type === 'CE' || type === 'CWE') r.valueCodeableConcept = { text: C(val, 1) || C(val, 0) };
      else r.valueString = val;
      const rr = parseRange(range, units); if (rr) r.referenceRange = [rr];
      const fl = flagCode(flags); if (fl) r.interpretation = [fl];
      if (org) r.performer = [{ display: org }];
      lastObs = addResource(r, file, { locator: 'segment ' + n + ' (OBX-' + F(seg, 1) + ')' }, pKey, report);
      return;
    }
    if (id === 'NTE' && lastObs) { (lastObs.note = lastObs.note || []).push({ text: F(seg, 3) }); return; }
    if (id === 'SPM' && lastObs) { lastObs.specimen = { display: C(F(seg, 4), 1) || C(F(seg, 4), 0) }; return; }
    if (['PV1', 'ORC', 'EVN', 'PD1'].includes(id)) return; // routing/administrative segments with no clinical content
    addUnstructured(line, file, { locator: 'segment ' + n + ' (' + id + ')', }, pKey, report, { label: 'Unrecognized HL7 v2 segment ' + id, date: null });
  });
  flushDoc();
}

/* ================= HL7 C-CDA (CCD, notes, Epic / VA / Oracle Health exports) ================= */
const OID = { '2.16.840.1.113883.6.1': LOINC, '2.16.840.1.113883.6.96': SCT, '2.16.840.1.113883.6.88': RXN, '2.16.840.1.113883.12.292': 'http://hl7.org/fhir/sid/cvx',
  '2.16.840.1.113883.6.90': 'http://hl7.org/fhir/sid/icd-10-cm', '2.16.840.1.113883.6.103': 'http://hl7.org/fhir/sid/icd-9-cm', '2.16.840.1.113883.6.12': 'http://www.ama-assn.org/go/cpt',
  '2.16.840.1.113883.6.285': 'urn:oid:2.16.840.1.113883.6.285', '2.16.840.1.113883.6.69': 'http://hl7.org/fhir/sid/ndc', '2.16.840.1.113883.5.4': 'http://terminology.hl7.org/CodeSystem/v3-ActCode' };
const SEC = [
  ['results', ['2.16.840.1.113883.10.20.22.2.3.1', '2.16.840.1.113883.10.20.22.2.3'], ['30954-2']],
  ['vitals', ['2.16.840.1.113883.10.20.22.2.4.1', '2.16.840.1.113883.10.20.22.2.4'], ['8716-3']],
  ['problems', ['2.16.840.1.113883.10.20.22.2.5.1', '2.16.840.1.113883.10.20.22.2.5'], ['11450-4']],
  ['meds', ['2.16.840.1.113883.10.20.22.2.1.1', '2.16.840.1.113883.10.20.22.2.1', '2.16.840.1.113883.10.20.22.2.38', '2.16.840.1.113883.10.20.22.2.11.1'], ['10160-0', '29549-3', '10183-2']],
  ['allergies', ['2.16.840.1.113883.10.20.22.2.6.1', '2.16.840.1.113883.10.20.22.2.6'], ['48765-2']],
  ['imms', ['2.16.840.1.113883.10.20.22.2.2.1', '2.16.840.1.113883.10.20.22.2.2'], ['11369-6']],
  ['procs', ['2.16.840.1.113883.10.20.22.2.7.1', '2.16.840.1.113883.10.20.22.2.7'], ['47519-4']],
  ['encs', ['2.16.840.1.113883.10.20.22.2.22.1', '2.16.840.1.113883.10.20.22.2.22'], ['46240-8']],
  ['social', ['2.16.840.1.113883.10.20.22.2.17'], ['29762-2']],
  ['notes', ['2.16.840.1.113883.10.20.22.2.65'], []],
];
const SUMMARY_DOC_CODES = new Set(['34133-9', '60591-5', '18761-7', '57133-1', '81218-0']);
function importCDA(text, file, report) {
  const doc = new deps.DOMParser().parseFromString(text, 'text/xml');
  const all = (el, name) => Array.from(el.getElementsByTagNameNS(CNS, name));
  const kids = (el, name) => el ? Array.from(el.childNodes).filter(n => n.nodeType === 1 && n.localName === name) : [];
  const kid = (el, name) => kids(el, name)[0] || null;
  const path = (el, ...names) => { for (const n of names) { el = kid(el, n); if (!el) return null; } return el; };
  const at = (el, a) => el ? (el.getAttribute(a) || '') : '';
  const txt = el => el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  const root = doc.documentElement;
  if (!root || root.localName !== 'ClinicalDocument') { report.warnings.push('Not an HL7 CDA ClinicalDocument.'); addUnstructured(text.slice(0, 20000), file, { locator: 'whole file' }, report.defaultPatient || ensureUnknownPatient(file), report); return; }
  const ids = {}; all(root, '*').forEach(e => { const id = e.getAttribute && e.getAttribute('ID'); if (id) ids[id] = e; });
  const refText = el => { const r = el && path(el, 'originalText', 'reference'); const id = r && at(r, 'value').replace(/^#/, ''); return id && ids[id] ? txt(ids[id]) : txt(el && kid(el, 'originalText')); };
  const code = el => {
    if (!el) return null;
    const cc = { coding: [] };
    const push = e => { if (at(e, 'code')) cc.coding.push({ system: OID[at(e, 'codeSystem')] || ('urn:oid:' + at(e, 'codeSystem')), code: at(e, 'code'), display: at(e, 'displayName') || undefined }); };
    push(el); kids(el, 'translation').forEach(push);
    cc.text = at(el, 'displayName') || refText(el) || (cc.coding.find(c => c.display) || {}).display || undefined;
    if (!cc.coding.length) delete cc.coding;
    return (cc.coding || cc.text) ? cc : null;
  };
  const ts = el => { if (!el) return null; if (at(el, 'value')) return tsToFhir(at(el, 'value')); const l = kid(el, 'low'); if (l && at(l, 'value')) return tsToFhir(at(l, 'value')); const c = kid(el, 'center'); return c ? tsToFhir(at(c, 'value')) : null; };
  const tsHigh = el => { const h = el && kid(el, 'high'); return h && at(h, 'value') ? tsToFhir(at(h, 'value')) : null; };
  const xtype = el => el ? (el.getAttributeNS(XSI, 'type') || el.getAttribute('xsi:type') || '').replace(/^.*:/, '') : '';
  const personName = n => n ? [txt(kid(n, 'prefix')), ...kids(n, 'given').map(txt), txt(kid(n, 'family')), txt(kid(n, 'suffix'))].filter(Boolean).join(' ') || txt(n) : '';
  const hasTpl = (el, roots) => kids(el, 'templateId').some(t => roots.includes(at(t, 'root')));

  // ---- header
  const pr = path(root, 'recordTarget', 'patientRole'); const pt = pr && kid(pr, 'patient');
  let pKey;
  if (pt) {
    const n = kid(pt, 'name');
    const p = { name: [{ family: txt(kid(n, 'family')), given: kids(n, 'given').map(txt) }], gender: { M: 'male', F: 'female', UN: 'other' }[at(kid(pt, 'administrativeGenderCode'), 'code')] };
    const bt = at(kid(pt, 'birthTime'), 'value'); if (bt) p.birthDate = tsToFhir(bt.slice(0, 8));
    p.identifier = kids(pr, 'id').filter(i => at(i, 'extension')).map(i => ({ system: 'urn:oid:' + at(i, 'root'), value: at(i, 'extension') }));
    const a = kid(pr, 'addr'); if (a) p.address = [{ line: kids(a, 'streetAddressLine').map(txt), city: txt(kid(a, 'city')), state: txt(kid(a, 'state')), postalCode: txt(kid(a, 'postalCode')) }];
    pKey = upsertPatient(p, file, { locator: 'ClinicalDocument/recordTarget' });
  } else pKey = report.defaultPatient || ensureUnknownPatient(file);
  report.patientKey = pKey;
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
        if (['paragraph', 'item', 'caption', 'content'].includes(ln) && ln !== 'content') { out.push('\n'); walk(n, depth + 1); out.push('\n'); continue; }
        walk(n, depth + 1);
      }
    };
    walk(t, 0);
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  const isNoteDoc = docLoinc && !SUMMARY_DOC_CODES.has(docLoinc);
  const noteParts = [];
  const sections = all(root, 'section');
  sections.forEach((sec, si) => {
    const stitle = txt(kid(sec, 'title')) || (code(kid(sec, 'code')) || {}).text || 'Section ' + (si + 1);
    const scode = at(kid(sec, 'code'), 'code');
    let type = null; for (const [t, tpl, codes] of SEC) if (hasTpl(sec, tpl) || codes.includes(scode)) { type = t; break; }
    const entries = kids(sec, 'entry');
    const locBase = 'section "' + stitle + '"';
    let made = 0;
    const add = (r, i) => { addResource(r, file, { locator: locBase + ' › entry ' + (i + 1) }, pKey, report); made++; };
    const obsFrom = (o, cat) => {
      const r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: cat, display: { laboratory: 'Laboratory', 'vital-signs': 'Vital Signs', 'social-history': 'Social History', exam: 'Exam' }[cat] }] }], code: code(kid(o, 'code')) || { text: 'Observation' } };
      const dt = ts(kid(o, 'effectiveTime')); if (dt) r.effectiveDateTime = dt;
      const v = kid(o, 'value'), xt = xtype(v);
      if (v && (xt === 'PQ' || (at(v, 'value') && at(v, 'unit')))) r.valueQuantity = qty(at(v, 'value'), at(v, 'unit') && at(v, 'unit') !== '1' ? at(v, 'unit') : undefined);
      else if (v && ['CD', 'CE', 'CO', 'CV'].includes(xt)) r.valueCodeableConcept = code(v);
      else if (v && xt === 'IVL_PQ') r.valueString = [at(kid(v, 'low'), 'value'), at(kid(v, 'high'), 'value')].filter(Boolean).join('-') + ' ' + (at(kid(v, 'low'), 'unit') || '');
      else if (v && txt(v)) r.valueString = txt(v);
      else if (v && at(v, 'value')) r.valueString = at(v, 'value');
      const ic = kid(o, 'interpretationCode'); if (ic && at(ic, 'code')) r.interpretation = [flagCode(at(ic, 'code')) || { text: at(ic, 'code') }];
      const rr = path(o, 'referenceRange', 'observationRange');
      if (rr) { const rv = kid(rr, 'value'); const unit = at(kid(rv, 'low'), 'unit') || at(kid(rv, 'high'), 'unit');
        const range = { text: txt(kid(rr, 'text')) || undefined }; if (rv && at(kid(rv, 'low'), 'value')) range.low = qty(at(kid(rv, 'low'), 'value'), unit); if (rv && at(kid(rv, 'high'), 'value')) range.high = qty(at(kid(rv, 'high'), 'value'), unit);
        if (!range.low && !range.high && range.text) { const pr = parseRange(range.text, (r.valueQuantity || {}).unit); if (pr) { if (pr.low) range.low = pr.low; if (pr.high) range.high = pr.high; } }
        if (range.text || range.low || range.high) r.referenceRange = [range]; }
      const sp = path(o, 'specimen', 'specimenRole', 'specimenPlayingEntity', 'code'); if (sp) r.specimen = { display: at(sp, 'displayName') || txt(sp) };
      const perf = path(o, 'performer', 'assignedEntity', 'representedOrganization', 'name') || path(o, 'author', 'assignedAuthor', 'representedOrganization', 'name');
      if (perf) r.performer = [{ display: txt(perf) }];
      kids(o, 'entryRelationship').forEach(er => { const a = kid(er, 'act'); if (a && at(kid(a, 'code'), 'code') === '48767-8') (r.note = r.note || []).push({ text: txt(kid(a, 'text')) }); });
      return r;
    };
    entries.forEach((en, i) => {
      const el = Array.from(en.childNodes).find(n => n.nodeType === 1); if (!el) return;
      if (type === 'results' || type === 'vitals' || type === 'social' || (!type && (el.localName === 'organizer' || el.localName === 'observation'))) {
        const cat = type === 'vitals' ? 'vital-signs' : type === 'social' ? 'social-history' : 'laboratory';
        const obsEls = el.localName === 'organizer' ? kids(el, 'component').map(c => kid(c, 'observation')).filter(Boolean) : [el];
        const made0 = made;
        const obs = obsEls.map(o => obsFrom(o, cat));
        if (type === 'vitals') { // combine systolic/diastolic into a FHIR BP panel
          const sys = obs.find(o => (o.code.coding || []).some(c => c.code === '8480-6')), dia = obs.find(o => (o.code.coding || []).some(c => c.code === '8462-4'));
          if (sys && dia && sys.valueQuantity && dia.valueQuantity) {
            const bp = { resourceType: 'Observation', status: 'final', category: sys.category, code: { coding: [{ system: LOINC, code: '85354-9', display: 'Blood pressure panel with all children optional' }], text: 'Blood pressure' }, effectiveDateTime: sys.effectiveDateTime,
              component: [{ code: sys.code, valueQuantity: sys.valueQuantity }, { code: dia.code, valueQuantity: dia.valueQuantity }] };
            obs.splice(obs.indexOf(sys), 1); obs.splice(obs.indexOf(dia), 1); obs.push(bp);
          }
        }
        const refs = obs.map(o => { add(o, i); return o; });
        if (type === 'results' && el.localName === 'organizer' && refs.length) {
          const dr = { resourceType: 'DiagnosticReport', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB', display: 'Laboratory' }] }], code: code(kid(el, 'code')) || { text: 'Lab panel' }, effectiveDateTime: ts(kid(el, 'effectiveTime')) || refs[0].effectiveDateTime, result: refs.map(o => ({ reference: 'urn:uuid:' + o.id, display: codeText(o.code) })) };
          add(dr, i);
        }
        if (made === made0) addUnstructured(txt(el), file, { locator: locBase + ' › entry ' + (i + 1) }, pKey, report);
        return;
      }
      if (type === 'problems') {
        const o = all(el, 'observation').find(x => kid(x, 'value')) || el; const v = kid(o, 'value');
        const r = { resourceType: 'Condition', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item', display: 'Problem List Item' }] }], code: code(v) || { text: txt(kid(o, 'text')) || 'Problem' } };
        const eff = kid(o, 'effectiveTime'); const on = ts(eff), ab = tsHigh(eff); if (on) r.onsetDateTime = on; if (ab) r.abatementDateTime = ab;
        const st = all(el, 'observation').find(x => at(kid(x, 'code'), 'code') === '33999-4');
        const stv = st ? (at(kid(st, 'value'), 'displayName') || at(kid(st, 'value'), 'code')) : (ab ? 'resolved' : at(kid(el, 'statusCode'), 'code') === 'completed' && ab ? 'resolved' : 'active');
        const cs = /resolv|inactive|55561003-no/i.test(stv) ? 'resolved' : /inactive/i.test(stv) ? 'inactive' : (ab ? 'resolved' : 'active');
        r.clinicalStatus = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: cs }] };
        add(r, i); return;
      }
      if (type === 'meds' && el.localName === 'substanceAdministration') {
        const mm = path(el, 'consumable', 'manufacturedProduct', 'manufacturedMaterial');
        const cc = code(kid(mm, 'code')) || { text: txt(kid(mm, 'name')) || 'Medication' }; if (!cc.text) cc.text = txt(kid(mm, 'name'));
        const intent = at(el, 'moodCode') === 'INT';
        const ets = kids(el, 'effectiveTime'); const start = ets.length ? ts(ets[0]) : null, end = ets.length ? tsHigh(ets[0]) : null;
        const sig = txt(kid(el, 'text')) || [at(kid(el, 'doseQuantity'), 'value') && ('dose ' + at(kid(el, 'doseQuantity'), 'value') + ' ' + at(kid(el, 'doseQuantity'), 'unit')), at(kid(el, 'routeCode'), 'displayName')].filter(Boolean).join(', ');
        const status = at(kid(el, 'statusCode'), 'code');
        const r = intent ? { resourceType: 'MedicationRequest', status: status === 'completed' ? 'completed' : 'active', intent: 'order', medicationCodeableConcept: cc, authoredOn: start || undefined }
          : { resourceType: 'MedicationStatement', status: end ? 'completed' : (status === 'completed' ? 'completed' : 'active'), medicationCodeableConcept: cc, effectivePeriod: start ? { start, end: end || undefined } : undefined };
        if (sig) r.dosage = r.resourceType === 'MedicationRequest' ? undefined : [{ text: sig }];
        if (sig && r.resourceType === 'MedicationRequest') r.dosageInstruction = [{ text: sig }];
        add(r, i); return;
      }
      if (type === 'allergies') {
        const o = all(el, 'observation').find(x => hasTpl(x, ['2.16.840.1.113883.10.20.22.4.7'])) || all(el, 'observation')[0]; if (!o) return;
        const pe = path(o, 'participant', 'participantRole', 'playingEntity');
        const cc = (pe && (code(kid(pe, 'code')) || { text: txt(kid(pe, 'name')) })) || code(kid(o, 'value')) || { text: 'Allergy' };
        if (pe && !cc.text) cc.text = txt(kid(pe, 'name'));
        if (at(o, 'negationInd') === 'true') { add({ resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, code: { coding: [{ system: SCT, code: '716186003', display: 'No known allergy' }], text: 'No known allergies' } }, i); return; }
        const r = { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] }, code: cc };
        const on = ts(kid(o, 'effectiveTime')); if (on) r.onsetDateTime = on;
        const vt = code(kid(o, 'value')); if (vt && /food/i.test(vt.text || '')) r.category = ['food']; else if (vt && /drug|medication/i.test(vt.text || '')) r.category = ['medication'];
        const reacts = all(o, 'observation').filter(x => hasTpl(x, ['2.16.840.1.113883.10.20.22.4.9']));
        const sev = all(o, 'observation').find(x => hasTpl(x, ['2.16.840.1.113883.10.20.22.4.8']));
        if (reacts.length) r.reaction = [{ manifestation: reacts.map(x => code(kid(x, 'value')) || { text: txt(kid(x, 'text')) }), severity: sev ? ({ mild: 'mild', moderate: 'moderate', severe: 'severe' }[(at(kid(sev, 'value'), 'displayName') || '').toLowerCase()] || undefined) : undefined }];
        add(r, i); return;
      }
      if (type === 'imms' && el.localName === 'substanceAdministration') {
        const mm = path(el, 'consumable', 'manufacturedProduct', 'manufacturedMaterial');
        const r = { resourceType: 'Immunization', status: at(el, 'negationInd') === 'true' ? 'not-done' : 'completed', vaccineCode: code(kid(mm, 'code')) || { text: txt(kid(mm, 'name')) || 'Vaccine' }, occurrenceDateTime: ts(kid(el, 'effectiveTime')) || undefined };
        if (!r.occurrenceDateTime) r.occurrenceString = 'unknown';
        add(r, i); return;
      }
      if (type === 'procs') {
        const r = { resourceType: 'Procedure', status: 'completed', code: code(kid(el, 'code')) || { text: 'Procedure' } };
        const eff = kid(el, 'effectiveTime'); const s = ts(eff), e = tsHigh(eff); if (s && e && e !== s) r.performedPeriod = { start: s, end: e }; else if (s) r.performedDateTime = s;
        add(r, i); return;
      }
      if (type === 'encs' && el.localName === 'encounter') {
        const eff = kid(el, 'effectiveTime');
        const r = { resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' }, type: [code(kid(el, 'code')) || { text: 'Encounter' }], period: { start: ts(eff) || undefined, end: tsHigh(eff) || undefined } };
        const loc = path(el, 'participant', 'participantRole', 'playingEntity', 'name'); if (loc) r.location = [{ location: { display: txt(loc) } }];
        const dx = all(el, 'observation').map(o => code(kid(o, 'value'))).filter(Boolean); if (dx.length) r.reasonCode = dx;
        add(r, i); return;
      }
      if (type === 'notes' || hasTpl(el, ['2.16.840.1.113883.10.20.22.4.202'])) {
        const body = txt(kid(el, 'text')) || refText(el);
        const nc = code(kid(el, 'code')) || {};
        const r = makeDoc({ title: nc.text || stitle, date: ts(kid(el, 'effectiveTime')), author: personName(path(el, 'author', 'assignedAuthor', 'assignedPerson', 'name')), custodian, body });
        add(r, i); return;
      }
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
}

/* ================= printed / exported text (PDF, TXT, HTML) ================= */
const HEADINGS = [
  ['labs', /^(LABORATORY RESULTS|LABORATORY|LAB RESULTS|LABS|TEST RESULTS|CHEMISTRY ?\/ ?HEMATOLOGY|CHEMISTRY|HEMATOLOGY|LAB(ORATORY)? DATA|RESULTS)$/],
  ['vitals', /^(VITAL SIGNS|VITALS)\b/],
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
function parseLabRow(line) {
  let cells = line.replace(/\t/g, '  ').trim().split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (!cells.length) return null;
  // name and value separated by a single space (column overflow)
  const m0 = cells[0].match(/^(.*?[A-Za-z)\]%])\s+((?:[<>]=?)?\s*-?\d+(?:\.\d+)?(?:\s+(?:HH|LL|H\*?|L\*?|A))?)$/);
  if (m0) cells = [m0[1], m0[2]].concat(cells.slice(1));
  if (cells.length < 2) return null;
  const name = cells[0];
  if (!/^[A-Za-z]/.test(name) || name.length > 60 || /:$/.test(name)) return null;
  const m = cells[1].match(/^([<>]=?)?\s*(-?\d+(?:\.\d+)?|POS(?:ITIVE)?|NEG(?:ATIVE)?|DETECTED|NOT DETECTED|NONE SEEN|REACTIVE|NONREACTIVE|NON-REACTIVE)\s*(HH|LL|H\*?|L\*?|A|\*)?$/i);
  if (!m) return null;
  let flag = m[3] || ''; const units = [], ranges = [];
  for (const c of cells.slice(2)) { if (isRange(c)) { ranges.push(c); const ru = rangeUnit(c); if (ru && !units.length) units.push(ru); } else if (FLAG_RE.test(c)) flag = c; else units.push(c); }
  return { name, comparator: m[1] || '', value: m[2], numeric: /^-?\d/.test(m[2]), flag, unit: units[0] || '', range: ranges[0] || '', extra: units.slice(1) };
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
  const ok = w => /^[A-Z][A-Za-z'.\-]*$/.test(w);
  if (!family || !ok(family.replace(/\s+/g, '')) || !given.every(ok)) return null;
  if (NAME_STOP.test(family.toUpperCase()) || given.some(g => NAME_STOP.test(g.toUpperCase()))) return null;
  if (family.replace(/[^A-Za-z]/g, '').length < 2) return null;
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
  let block = null;
  const flushLeft = () => { if (!left) return; const txt = left.idx.map(i => lines[i].text).join('\n'); if (txt.trim()) addUnstructured(txt, file, loc(left.idx[0], left.idx[left.idx.length - 1]), pKey, report); left = null; };
  const pushLeft = i => { if (!lines[i].text.trim() && !left) return; if (!left) left = { idx: [] }; left.idx.push(i); };
  const consumed = () => flushLeft();
  const endBlock = () => {
    if (block && block.rows.length && block.panel) {
      const dr = { resourceType: 'DiagnosticReport', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB', display: 'Laboratory' }] }], code: labCode(block.panel), effectiveDateTime: block.date || undefined, result: block.rows.map(o => ({ reference: 'urn:uuid:' + o.id, display: codeText(o.code) })) };
      if (block.performer) dr.performer = [{ display: block.performer }];
      addResource(dr, file, loc(block.from, block.to), pKey, report);
    }
    block = null;
  };
  const newBlock = i => { endBlock(); block = { date: null, specimen: null, performer: null, issued: null, panel: pendingPanel, rows: [], from: i, to: i }; pendingPanel = null; };
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
      const name = g('lab test', 'test name', 'test', 'component'), val = g('result', 'value');
      if (name && val != null) {
        const unit = g('units', 'unit') || ''; const m = String(val).match(/^([<>]=?)?\s*(-?\d+(?:\.\d+)?)\s*(HH|LL|H|L|A)?$/i);
        r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: 'laboratory', display: 'Laboratory' }] }], code: labCode(name, (f['specimen'] || f['sample type'] || '') + ' ' + name, /^[<>]?=?\s*-?\d/.test(String(val))) };
        const dt = parseDT(g('collected date/time', 'collection date/time', 'collection date', 'date collected', 'date/time', 'date') || ''); if (dt) r.effectiveDateTime = dt;
        if (m) { r.valueQuantity = qty(m[2], unit); if (m[1]) r.valueQuantity.comparator = m[1]; } else r.valueString = val;
        const rr = parseRange(g('reference range', 'ref range', 'normal range', 'range'), unit); if (rr) r.referenceRange = [rr];
        const fl = flagCode(g('interpretation', 'flag', 'abnormal flag') || (m && m[3])); if (fl) r.interpretation = [fl];
        const sp = g('specimen', 'sample type'); if (sp) r.specimen = { display: sp };
        const pl = g('performing lab', 'performing laboratory', 'lab'); if (pl) r.performer = [{ display: pl }];
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
  const listItem = (t, i) => {
    const s = t.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim(); let r = null;
    if (section === 'allergies') {
      if (/^(NKA|NKDA|No Known)/i.test(s)) r = { resourceType: 'AllergyIntolerance', code: { coding: [{ system: SCT, code: '716186003', display: 'No known allergy' }], text: s } };
      else { const [sub, rest] = s.split(/\s+-\s+/, 2); const sev = (rest || '').match(/\((mild|moderate|severe)\)/i);
        r = { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, code: { text: sub.trim() } };
        if (rest) r.reaction = [{ manifestation: rest.replace(/\((mild|moderate|severe)\)/i, '').split(/[,;]\s*/).filter(x => x.trim()).map(x => ({ text: x.trim() })), severity: sev ? sev[1].toLowerCase() : undefined }]; }
    } else if (section === 'meds') { const [nm, sig] = s.split(/\s+-\s+/, 2); r = { resourceType: 'MedicationStatement', status: 'active', medicationCodeableConcept: { text: nm.trim() } }; if (sig) r.dosage = [{ text: sig.trim() }]; }
    else if (section === 'problems') { const d = findDate(s); r = { resourceType: 'Condition', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { text: d ? s.replace(d.raw, '').replace(/[\s,;-]+$/, '').trim() : s } }; if (d) r.onsetDateTime = d.iso; }
    else if (section === 'imms') { const d = findDate(s); if (d) r = { resourceType: 'Immunization', status: 'completed', vaccineCode: { text: s.replace(d.raw, '').replace(/[\s,;-]+$/, '').trim() }, occurrenceDateTime: d.iso }; }
    else if (section === 'appts') { const d = findDate(s); if (d) r = { resourceType: 'Appointment', status: 'booked', start: d.iso, description: s.replace(d.raw, '').trim() }; }
    if (!r) return false;
    consumed(); addResource(r, file, loc(i), pKey, report); return true;
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
    if (h) { closeDoc(); flushKV(); flushLeft(); endBlock(); section = h.type; sectionDate = h.date; lastObs = null; continue; }
    const ds = docStart(i, raw);
    if (ds) { closeDoc(); flushKV(); flushLeft(); endBlock(); doc = Object.assign({ idx: [] }, ds); doc.idx.push(i); continue; }
    if (doc) { doc.idx.push(i); docHeader(raw, i); if (doc.closing && !t) closeDoc(); continue; }
    if (!t) { flushKV(); if (left) left.idx.push(i); continue; }
    let m;
    if (section === 'labs') {
      if (kv) { const km = t.match(KV_RE); if (km) { const k = km[1].toLowerCase(); if (kv.f[k] == null) { kv.f[k] = km[2]; kv.keys[k] = km[1]; kv.idx.push(i); continue; } flushKV(); } else flushKV(); }
      if ((m = t.match(/^(Lab Test|Test Name)\s*:\s*(.+)$/i))) { kv = { f: { [m[1].toLowerCase()]: m[2] }, keys: { [m[1].toLowerCase()]: m[1] }, idx: [i] }; continue; }
      if (/^(Collection DT|Collection Date(?:\/Time)?|Collected(?: on| Date(?:\/Time)?)?|Date Collected|Specimen Collected)\b/i.test(t)) {
        consumed(); newBlock(i); block.date = parseDT(t);
        const sp = t.match(/Specimen:\s*(.+?)(?:\s{2,}|$)/i); if (sp) block.specimen = sp[1].trim();
        const rs = t.match(/Resulted:?\s*(.+?)(?:\s{2,}|$)/i); if (rs) block.issued = parseDT(rs[1]); continue;
      }
      if ((m = t.match(/^Specimen:\s*(.+)$/i))) { consumed(); if (!block) newBlock(i); block.specimen = m[1].trim(); continue; }
      if ((m = t.match(/^(?:Performing Lab(?:oratory)?|Performed (?:by|at)|Testing Lab)\s*:\s*(.+)$/i))) {
        consumed(); if (!block) newBlock(i); block.performer = m[1].trim(); block.to = i;
        for (const o of block.rows) if (!o.performer) o.performer = [{ display: block.performer }];
        continue;
      }
      if (/^(Test name|Test|Component|Analyte)\b.*\b(Result|Value|Your Value)\b/i.test(t)) { consumed(); continue; }
      if ((m = t.match(/^(?:Comment|Comments|Note)\s*:\s*(.+)$/i)) && lastObs) { (lastObs.note = lastObs.note || []).push({ text: m[1] }); lastObs.extension.find(e => e.url === EXT_SRC).extension.find(x => x.url === 'locator').valueString += ' (+ comment line ' + lines[i].line + ')'; continue; }
      const row = parseLabRow(t);
      if (row) {
        consumed(); if (!block) newBlock(i); block.to = i;
        const r = { resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: OBSCAT, code: 'laboratory', display: 'Laboratory' }] }], code: labCode(row.name, (block.specimen || '') + ' ' + (block.panel || ''), row.numeric) };
        const dt = block.date || sectionDate; if (dt) r.effectiveDateTime = dt; else report.warnings.push('Lab "' + row.name + '" has no collection date (line ' + lines[i].line + ').');
        if (block.issued) r.issued = block.issued;
        if (row.numeric) { r.valueQuantity = qty(row.value, row.unit); if (row.comparator) r.valueQuantity.comparator = row.comparator; } else { r.valueString = row.value; }
        const rr = parseRange(row.range, row.unit); if (rr) r.referenceRange = [rr];
        const fl = flagCode(row.flag); if (fl) r.interpretation = [fl];
        if (block.specimen) r.specimen = { display: block.specimen.replace(/\b\w/g, c => c.toUpperCase()).replace(/\B\w+/g, w => w.toLowerCase()) };
        if (block.performer) r.performer = [{ display: block.performer }];
        if (row.extra.length) r.note = [{ text: 'Additional printed columns: ' + row.extra.join(' | ') }];
        lastObs = addResource(r, file, loc(i), pKey, report); block.rows.push(lastObs); continue;
      }
      if (t.length <= 50 && !/\d/.test(t) && !KV_RE.test(t) && /^[A-Za-z]/.test(t)) { consumed(); endBlock(); pendingPanel = t; continue; }
      pushLeft(i); continue;
    }
    if (section === 'vitals') {
      if (/^Date\s*\/?\s*Time\b/i.test(t)) { consumed(); continue; }
      const d = findDate(t); const date = (d && d.index < 3) ? d.iso : sectionDate;
      let hit = 0; const L = loc(i);
      for (const [k, re] of VITAL_RES) { const vm = t.match(re); if (vm) { if (!hit) consumed(); hit++; addResource(makeVital(k, vm, date), file, L, pKey, report); } }
      if (!hit) pushLeft(i);
      continue;
    }
    if (['allergies', 'problems', 'meds', 'appts', 'imms'].includes(section)) {
      const km = t.match(KV_RE);
      if (km && !/^https?$/i.test(km[1])) { const k = km[1].toLowerCase(); if (!kv) kv = { f: {}, keys: {}, idx: [] }; if (kv.f[k] != null) { flushKV(); kv = { f: {}, keys: {}, idx: [] }; } kv.f[k] = km[2]; kv.keys[k] = km[1]; kv.idx.push(i); continue; }
      flushKV(); if (listItem(t, i)) continue; pushLeft(i); continue;
    }
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
function decodeText(buf) { try { return new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch (e) { return Buffer.from(buf).toString('utf8'); } }
async function importFile(name, buf, opts) {
  opts = opts || {};
  const head = new Uint8Array(buf.slice(0, 8));
  const isZip = head[0] === 0x50 && head[1] === 0x4b, isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  if (isZip || /\.zip$/i.test(name)) {
    if (!deps.JSZip) throw new Error('ZIP support not loaded');
    const zip = await deps.JSZip.loadAsync(buf); const reports = [];
    for (const f of Object.values(zip.files)) {
      if (f.dir || /(^|\/)(__MACOSX|\.DS_Store)/.test(f.name) || /\.(xsl|xslt|css|js|ico)$/i.test(f.name)) continue;
      const b = await f.async('arraybuffer'); reports.push(...await importFile(name + '/' + f.name, b, opts));
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
      const text = decodeText(buf).replace(/^﻿/, ''); const t = text.trimStart();
      if (/^<\?xml|^</.test(t) && /<ClinicalDocument\b/.test(t.slice(0, 4000))) { file.format = 'ccda'; report.format = 'HL7 C-CDA (XML)'; importCDA(text, file, report); }
      else if (/^MSH\|/.test(t)) { file.format = 'hl7v2'; report.format = 'HL7 v2 message'; importHL7v2(t, file, report); }
      else if (/^[\[{]/.test(t) && /"resourceType"\s*:/.test(t.slice(0, 20000))) { file.format = /^\{[^\n]*\}\s*\n\s*\{/.test(t) ? 'fhir-ndjson' : 'fhir-json'; report.format = 'HL7 FHIR (' + (file.format === 'fhir-ndjson' ? 'NDJSON' : 'JSON') + ')'; importFHIR(text, file, report); }
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
  if (/<ClinicalDocument\b/.test(t) || /^MSH\|/.test(t) || (/^[\[{]/.test(t) && /"resourceType"\s*:/.test(t))) return false;
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
const v = q => q ? (q.comparator || '') + q.value : '';
function describe(r) {
  const k = meta(r).kind || kindOf(r); const d = { kind: k, type: r.resourceType };
  switch (r.resourceType) {
    case 'Observation': {
      d.date = r.effectiveDateTime || (r.effectivePeriod || {}).start; d.name = codeText(r.code);
      if (r.component && r.component.length && !r.valueQuantity) { d.value = r.component.map(c => v(c.valueQuantity) || codeText(c.valueCodeableConcept)).join('/'); d.unit = (r.component[0].valueQuantity || {}).unit || ''; }
      else { d.value = r.valueQuantity ? v(r.valueQuantity) : r.valueCodeableConcept ? codeText(r.valueCodeableConcept) : (r.valueString != null ? r.valueString : r.valueBoolean != null ? String(r.valueBoolean) : ''); d.unit = (r.valueQuantity || {}).unit || ''; }
      const rr = (r.referenceRange || [])[0]; if (rr) { d.low = rr.low ? rr.low.value : ''; d.high = rr.high ? rr.high.value : ''; d.range = rr.text || [d.low, d.high].filter(x => x !== '').join(' - '); }
      const it = (r.interpretation || [])[0]; if (it) { d.flag = ((it.coding || [])[0] || {}).code || it.text; if (d.flag === 'N') d.flag = ''; }
      d.specimen = r.specimen && (r.specimen.display || r.specimen.reference) || ''; d.performer = (r.performer || []).map(p => p.display || p.reference).join('; ');
      d.comments = (r.note || []).map(n => n.text).join(' / '); d.status = r.status; d.issued = r.issued; d.code = ((r.code.coding || [])[0] || {}); break;
    }
    case 'Condition': d.name = codeText(r.code); d.date = r.onsetDateTime || r.recordedDate || (r.onsetPeriod || {}).start; d.status = ((r.clinicalStatus || {}).coding || [{}])[0].code || ''; d.end = r.abatementDateTime; d.code = ((r.code.coding || [])[0] || {}); break;
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
function clear() { state.patients.length = 0; state.resources.length = 0; state.files.length = 0; state.byKey.clear(); }

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
root.CPRSEngine = { prepareClaudeImport, runClaudeImport, isClaudeEligible, deidentify, buildPrompt, restoreTokens, makeBatches, addPatient, LAB_CAT, lookupLab, _pdfToLines: pdfToLines, deps, state, importFile, exportBundle, exportNDJSON, exportCSV, sources, docText, describe, codeText, medName, meta, kindOf, clear, setMerge: b => { MERGE = !!b; }, EXT_SRC, findDate, CS_LOCAL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
