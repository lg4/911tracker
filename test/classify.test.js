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

test('T34: CATS is exactly three buckets, Police/Fire/EMS in display order', () => {
  assert.deepEqual(CATS.map((c) => c.key), ['police', 'fire', 'ems']);
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

test('T31: medical codes whose third char is A or O classify as EMS', () => {
  // The feed's numeric-code alphabet runs A/B/C/D/O, not just B/C/D. Before T31 widened the
  // pattern these rows escaped every rule and fell to the default bucket (Police since T34) —
  // even where a keyword (FALL, SICK) would have rescued them, EYE PROBLEMS had none.
  assert.equal(classify(f('16A01-EYE PROBLEMS')), 'ems');
  assert.equal(classify(f('17A04-FALL (PUBLIC ASSIST)')), 'ems');
  assert.equal(classify(f('26O06-SICK PERSON')), 'ems');
  assert.equal(classify(f('19D01-HEART PROBLEMS')), 'ems');
});

test('T34: uninterpretable CAD noise now defaults to Police (no fourth bucket)', () => {
  // T34 removed the Other/civil buckets — a bare two-digit prefix with no trailing digits
  // must not be misread as an EMS code, and every residual row lands under Police.
  assert.equal(classify(f('ATL')), 'police');
  assert.equal(classify(f('DISCON')), 'police');
  assert.equal(classify(f('MHL')), 'police');
  assert.equal(classify(f('Unknown')), 'police');
});

test('T34: former civil/welfare-assistance rows fold under Police', () => {
  // The documented-but-unwired civil branch is gone; its residual set now classifies as
  // Police so only three chips exist on the map.
  assert.equal(classify(f('ASSIST')), 'police');
  assert.equal(classify(f('ASSISTANCE')), 'police');
  assert.equal(classify(f('VTL COMPLAINT')), 'police');
  assert.equal(classify(f('RUNAWAY')), 'police');
  assert.equal(classify(f('FOOUND PERSON')), 'police'); // feed typo tolerance
  assert.equal(classify(f('MVA-UNKNOWN')), 'police');
});

test('service keywords still win over a generic assist when both match', () => {
  assert.equal(classify(f('POLICE ASSIST')), 'police');
  assert.equal(classify(f('OFFICER ASSIST')), 'police');
});

test('T34: empty/blank incidents default to Police, not a fourth bucket', () => {
  assert.equal(classify(f('', '')), 'police');
});
