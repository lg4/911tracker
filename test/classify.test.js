import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// web/classify.js attaches CATS + classify to globalThis as a plain browser script;
// load it the same way the browser does (index.html) and grab both exports.
new Function(readFileSync(join(here, '..', 'web', 'classify.js'), 'utf8'))({});
const { CATS, classify } = globalThis;

const f = (type, title = '') => ({ properties: { type, title } });

test('CATS has all five categories in display order', () => {
  assert.deepEqual(CATS.map((c) => c.key), ['police', 'fire', 'ems', 'civil', 'other']);
});

test('service keywords bucket correctly', () => {
  assert.equal(classify(f('FIRE')), 'fire');
  assert.equal(classify(f('MVA-FD')), 'fire');
  assert.equal(classify(f('CARBON MONOXIDE')), 'fire');
  assert.equal(classify(f('MEDICAL ASSISTANCE')), 'ems');
  assert.equal(classify(f('MVA-MED')), 'ems');
  assert.equal(classify(f('TRAFFIC HAZARD')), 'police');
  assert.equal(classify(f('MISSING PERSON')), 'police');
  assert.equal(classify(f('NOISE COMPLAINT')), 'police');
});

test('numeric CAD dispatch codes are EMS responses', () => {
  assert.equal(classify(f('06D02-BREATHING PROBLEMS')), 'ems');
  assert.equal(classify(f('31D04-UNCONSCIOUS/FAINTING')), 'ems');
  assert.equal(classify(f('33C07-TRANSFER')), 'ems');
});

test('T31: medical codes whose third char is A or O no longer fall to other', () => {
  // The feed's numeric-code alphabet runs A/B/C/D/O, not just B/C/D. These rows were
  // previously misfiled into the Other bucket purely from a too-narrow [BCD] class —
  // even where a keyword (FALL, SICK) would have rescued them, EYE PROBLEMS had none.
  assert.equal(classify(f('16A01-EYE PROBLEMS')), 'ems');
  assert.equal(classify(f('17A04-FALL (PUBLIC ASSIST)')), 'ems');
  assert.equal(classify(f('26O06-SICK PERSON')), 'ems');
  assert.equal(classify(f('19D01-HEART PROBLEMS')), 'ems');
});

test('the broadened code pattern does not swallow non-medical noise', () => {
  // Uninterpretable CAD noise still lands in other; and a bare two-digit prefix with no
  // trailing digits must not match (the \b after four digits keeps it anchored).
  assert.equal(classify(f('ATL')), 'other');
  assert.equal(classify(f('DISCON')), 'other');
  assert.equal(classify(f('MHL')), 'other');
  assert.equal(classify(f('Unknown')), 'other');
});

test('standalone assist rows land in civil, not other (T29 regression)', () => {
  // The documented-but-unwired civil branch: before the fix these fell through to
  // other despite a live Civil chip — this is what left ~44 rows in Other.
  assert.equal(classify(f('ASSIST')), 'civil');
  assert.equal(classify(f('ASSISTANCE')), 'civil');
  assert.equal(classify(f('VTL COMPLAINT')), 'civil');
  assert.equal(classify(f('RUNAWAY')), 'civil');
  assert.equal(classify(f('FOOUND PERSON')), 'civil'); // feed typo tolerance
  assert.equal(classify(f('MVA-UNKNOWN')), 'civil');
});

test('service keywords win over civil when both match', () => {
  assert.equal(classify(f('POLICE ASSIST')), 'police');
  assert.equal(classify(f('OFFICER ASSIST')), 'police');
});

test('uninterpretable CAD noise stays in other', () => {
  assert.equal(classify(f('DISCON')), 'other');
  assert.equal(classify(f('ATL')), 'other');
  assert.equal(classify(f('Unknown')), 'other');
  assert.equal(classify(f('', '')), 'other');
});
