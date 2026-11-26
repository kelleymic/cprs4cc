'use strict';
// Optional Claude extraction path, exercised with a scripted stand-in for the model (no network).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers');
const { E } = H;
beforeEach(() => H.fresh());

const sample = f => H.toBuf(H.fs.readFileSync(H.path.join(H.ROOT, 'samples', f)));
const L = (page, line, name, value, unit, ref, flag, extra) => Object.assign({ type: 'lab', page, line, name, value, unit, refRange: ref, flag, specimen: 'SERUM', performer: 'RIVERSIDE REFERENCE LAB', date: '[D-2]', time: '07:40', comment: '', panel: '' }, extra || {});

test('de-identified mode: nothing identifying is sent, invented or unlocatable results are rejected, the patient comes from the file', async () => {
  const MOCK = { patient: {}, items: [
    L(1, 10, 'SODIUM', '141', 'mmol/L', '136 - 145', ''), L(1, 11, 'POTASSIUM', '3.3', 'mmol/L', '3.5 - 5.1', 'L'),
    L(2, 4, 'MAGNESIUM', '999', 'mg/dL', '1.7 - 2.2', 'H'),                                       // invented: must be rejected
    { type: 'allergy', page: 3, line: 10, endPage: 3, endLine: 12, substance: 'SULFONAMIDE ANTIBIOTICS', reaction: 'HIVES', severity: '', date: '' },
    { type: 'problem', page: 2, line: 15, text: 'Peripheral neuropathy', status: 'active', date: '' },     // not on that line: must be rejected
  ], unmapped: [] };
  const prep = await E.prepareClaudeImport('Riverside_Multipage_GARCIA_2026.pdf', sample('Riverside_Multipage_GARCIA_2026.pdf'), { mode: 'deid' });
  const prompts = [];
  const reps = await E.runClaudeImport(prep, async p => { prompts.push(p); return JSON.parse(JSON.stringify(MOCK)); }, {});
  for (const bad of ['GARCIA', 'MARIA', '11/02/1958', 'OYELARAN', 'Mensah']) assert.ok(!prompts[0].includes(bad), 'identifier leaked to the model: ' + bad);
  const labs = H.ofKind('lab').map(x => x.d.name).sort();
  assert.deepEqual(labs, ['POTASSIUM', 'SODIUM']);
  assert.ok(!labs.includes('MAGNESIUM'));
  assert.equal(H.ofKind('allergy').length, 1);
  assert.equal(H.ofKind('problem').length, 0);
  assert.ok(H.ofKind('unstructured').some(x => /Not verified/.test(x.d.name)), 'rejected items are kept as unverified text, not dropped');
  assert.equal(reps[0].claude.rejected, 2);
  assert.match(reps[0].identity, /GARCIA/);                                                          // identity is read from the file by the app's own rules
  assert.equal(E.state.patients.length, 1);
});

test('a failing batch falls back to the built-in rules for just those pages', async () => {
  const f = 'VA_ROI_Printout_HESSEL_2026.pdf';
  const prep = await E.prepareClaudeImport(f, sample(f), { mode: 'deid' });
  const r = (await E.runClaudeImport(prep, async p => { if (/=== PAGE 2 ===/.test(p)) throw { code: 'invalid_json', message: 'bad' }; return { items: [], unmapped: [] }; }, { maxChars: 3000 }))[0];
  assert.deepEqual(r.claude.fallbackPages, [2]);
  assert.match(r.warnings[0], /page\(s\) 2/);
  assert.ok(H.ofKind('lab').length >= 10, 'labs on the failed page come from the rules');
  assert.equal(E.sources(H.ofKind('lab')[0].r)[0].method, 'rules (fallback)');
});

test('direct mode sends the text as it is and takes the patient from the model', async () => {
  const f = 'VA_ROI_Printout_HESSEL_2026.pdf';
  const prep = await E.prepareClaudeImport(f, sample(f), { mode: 'direct' });
  const sent = [];
  await E.runClaudeImport(prep, async p => { sent.push(p); return { patient: { family: 'HESSEL', given: 'LENARD F', dob: '1993-04-04', sex: 'male' }, items: [
    L(2, 6, 'POTASSIUM', '5.4', 'mmol/L', '3.5 - 5.1', 'H', { date: '09/14/2026', time: '08:12' })], unmapped: [] }; }, {});
  assert.ok(sent[0].includes('HESSEL') && sent[0].includes('09/14/2026'));
  assert.ok(!sent[0].includes('[D-n]'));
  assert.equal(E.state.patients[0].resource.name[0].family, 'HESSEL');
});

test('Claude path: functional status items (scales and other findings) are verified against the cited line', async () => {
  const txt = 'Patient: DOE, JANE\nDOB: 01/02/1960\nMRN: 12345\n\nASSESSMENT 03/01/2025\nECOG performance status: 1\nKarnofsky: 80%\nAmbulation: Uses a cane\nLansky score: 90\nWeight 150 lb\n';
  const prep = await E.prepareClaudeImport('assess.txt', H.toBuf(Buffer.from(txt)), { mode: 'direct' });
  let prompt = ''; const lineOf = re => { const m = prompt.match(new RegExp('^(\\d+)\\|' + re, 'm')); return m ? +m[1] : 0; };
  await E.runClaudeImport(prep, async p => {
    prompt = p;
    const f = (scale, value, re, extra) => Object.assign({ type: 'functional', page: 1, line: lineOf(re), scale, value, date: '03/01/2025', time: '' }, extra);
    return { patient: { family: 'DOE', given: 'JANE', dob: '1960-01-02' }, items: [
      f('ECOG', '1', 'ECOG'), f('KARNOFSKY', '80%', 'Karnofsky'), f('OTHER', 'Uses a cane', 'Ambulation', { name: 'Ambulation' }),
      f('LANSKY', '90', 'Lansky'),
      f('LANSKY', '85', 'Lansky'),                                   // the printed score is 90: a value that is not on the line is rejected
      f('ECOG', '7', 'ECOG'),                                        // outside the 0-5 range
      f('KARNOFSKY', '70', 'ECOG'),                                  // the scale is not named on the cited line
      f('ECOG', '4', 'Weight'),                                      // invented: not on that line
    ], unmapped: [] };
  }, {});
  const x = H.ofKind('func').map(i => i.d.scale ? i.d.scale + ':' + i.d.score : i.d.name + '=' + i.d.value).sort();
  assert.deepEqual(x, ['Ambulation=Uses a cane', 'ecog:1', 'karnofsky:80', 'lansky:90'].sort());
  assert.ok(H.ofKind('func').every(i => i.d.date === '2025-03-01'));
  assert.ok(H.ofKind('unstructured').filter(u => /Not verified/.test(u.d.name)).length >= 4, 'rejected items are kept as unverified text');
});
