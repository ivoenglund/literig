import assert from 'node:assert/strict';
import { fineliDisplayName, fineliFoodStatus, kcalFromKj } from '../import-fineli-full.js';

assert.equal(kcalFromKj(418.4), 100);
assert.equal(kcalFromKj(3710.54), 886.8);
assert.equal(fineliDisplayName('GINGER, GROUND'), 'Ground Ginger');
assert.equal(fineliDisplayName('TOFU, PLAIN'), 'Tofu, Plain');
assert.equal(fineliDisplayName('ÄPPLE, RÅ'), 'Äpple, Rå');
// Import status is derived from an actual value-row count; the importer never defaults it to verified.
assert.equal(fineliFoodStatus([]), 'missing_data');
assert.equal(fineliFoodStatus([{ code: 'enerc', amount: 0 }]), 'verified');
console.log('nutrition data regression tests passed');
