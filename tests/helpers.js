'use strict';
/* Shared test helpers: load the engine in Node with its optional dependencies injected,
 * and provide small builders so each test states only what it is about. */
process.env.TZ = 'America/New_York';            // deterministic local-time offsets (EST/EDT)
const fs = require('fs');
const path = require('path');

// pdf.js probes for these browser classes and prints a warning when they are missing; text extraction does not need them.
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix { };
if (!globalThis.Path2D) globalThis.Path2D = class Path2D { };

globalThis.DOMParser = require('@xmldom/xmldom').DOMParser;
globalThis.pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
globalThis.JSZip = require('jszip');
require('../src/engine.js');
const E = globalThis.CPRSEngine;
E.deps.DOMParser = globalThis.DOMParser; E.deps.pdfjs = globalThis.pdfjsLib; E.deps.JSZip = globalThis.JSZip;

const ROOT = path.join(__dirname, '..');
const toBuf = x => { const b = Buffer.isBuffer(x) ? x : Buffer.from(String(x), 'utf8'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };

/** Import a string as a file; returns the first report. State is NOT cleared (call fresh() yourself). */
async function importText(name, text, opts) { return (await E.importFile(name, toBuf(text), opts))[0]; }
/** Import a file from samples/ or tests/fixtures/. */
async function importPath(rel, opts) { const p = path.join(ROOT, rel); return E.importFile(path.basename(p), toBuf(fs.readFileSync(p)), opts); }
function fresh() { E.clear(); return E; }

const all = () => E.state.resources.map(r => ({ r, d: E.describe(r) }));
const ofKind = k => all().filter(x => (Array.isArray(k) ? k : [k]).includes(x.d.kind));
const byName = (kind, re) => ofKind(kind).filter(x => re.test(x.d.name || ''));
const counts = () => { const c = {}; for (const { d } of all()) c[d.kind] = (c[d.kind] || 0) + 1; return c; };
const patientOf = r => E.state.patients.find(p => p.key === E.meta(r).patientKey);

/* ---- builders ---- */
const PAT = { resourceType: 'Patient', id: 'p1', name: [{ family: 'Test', given: ['Ann'] }], birthDate: '1970-01-01', gender: 'female' };
const fhirBundle = (...resources) => JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: resources.map(r => ({ fullUrl: 'https://fhir.example.org/r4/' + r.resourceType + '/' + r.id, resource: r })) });
const labObs = (id, text, value, extra) => Object.assign({ resourceType: 'Observation', id, status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }], code: { text }, valueQuantity: { value, unit: 'mmol/L' }, effectiveDateTime: '2026-01-01T10:00:00Z', subject: { reference: 'Patient/p1' } }, extra || {});

const CDA_NS = 'xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const cda = (body, o) => `<?xml version="1.0" encoding="UTF-8"?><ClinicalDocument ${CDA_NS}><templateId root="2.16.840.1.113883.10.20.22.1.1"/><code code="${(o && o.docCode) || '34133-9'}" codeSystem="2.16.840.1.113883.6.1"/><title>${(o && o.title) || 'Continuity of Care Document'}</title><effectiveTime value="20260105"/>
<recordTarget><patientRole><id root="1.2.3" extension="MRN1"/><patient><name><given>Ann</given><family>Test</family></name><administrativeGenderCode code="F"/><birthTime value="19700101"/></patient></patientRole></recordTarget>
<component><structuredBody>${body}</structuredBody></component></ClinicalDocument>`;
const cdaSection = (tpl, code, title, inner, textXml) => `<component><section><templateId root="${tpl}"/><code code="${code}" codeSystem="2.16.840.1.113883.6.1"/><title>${title}</title>${textXml || '<text/>'}${inner}</section></component>`;
const SEC_ID = { results: ['2.16.840.1.113883.10.20.22.2.3.1', '30954-2', 'Results'], vitals: ['2.16.840.1.113883.10.20.22.2.4.1', '8716-3', 'Vital Signs'], problems: ['2.16.840.1.113883.10.20.22.2.5.1', '11450-4', 'Problems'],
  meds: ['2.16.840.1.113883.10.20.22.2.1.1', '10160-0', 'Medications'], allergies: ['2.16.840.1.113883.10.20.22.2.6.1', '48765-2', 'Allergies'], imms: ['2.16.840.1.113883.10.20.22.2.2.1', '11369-6', 'Immunizations'], procs: ['2.16.840.1.113883.10.20.22.2.7.1', '47519-4', 'Procedures'] };
const section = (kind, inner, textXml) => cdaSection(SEC_ID[kind][0], SEC_ID[kind][1], SEC_ID[kind][2], inner, textXml);

const hl7 = (...segs) => segs.join('\r') + '\r';

module.exports = { cdaSection, E, ROOT, toBuf, importText, importPath, fresh, all, ofKind, byName, counts, patientOf, PAT, fhirBundle, labObs, cda, section, hl7, fs, path };
