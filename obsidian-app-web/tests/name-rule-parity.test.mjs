/**
 * The app's name search must accept exactly the names the protocol accepts. It used to say 3–24 characters while the
 * chain allows 3–63, so a valid 30-character name could not be searched, bought or offered on. This pins the app's rule
 * to obsidian-core's own `validateNameFormat` over a corpus that covers every clause of the rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseName, RESERVED_NAMES } from '../public/data.mjs';
import { validateNameFormat, normalizeName } from '../../obsidian-interface/web/core/transactions/executors/ons.js';
import { CONSENSUS_PARAMS } from '../../obsidian-interface/web/core/protocol/params.js';

const protocolAccepts = (name) => {
  try {
    validateNameFormat(normalizeName(name));
    return true;
  } catch {
    return false;
  }
};

const corpus = [
  '', 'a', 'ab', 'abc', 'abcd', 'a-b', 'a--b', '-abc', 'abc-', 'a-bc', 'ab-c', 'abc.def', 'abc def', 'ab_c', 'ünï',
  'a'.repeat(24), 'a'.repeat(25), 'a'.repeat(32), 'a'.repeat(33), 'a'.repeat(62), 'a'.repeat(63), 'a'.repeat(64),
  `a${'-b'.repeat(30)}`, `a${'-b'.repeat(31)}c`, '123', '1-2', 'x'.repeat(61) + '-y', ...CONSENSUS_PARAMS.ons.reserved, 'obsidian', 'time', 'a.obs',
];

test('the app accepts exactly the names the protocol accepts', () => {
  for (const name of corpus) {
    const expected = protocolAccepts(name);
    assert.equal(normaliseName(name) !== null, expected, `"${name}" (${name.length} chars): protocol ${expected}, app ${normaliseName(name)}`);
    if (expected) assert.equal(normaliseName(`${name}.obs`), `${name}.obs`);
  }
});

test('the app trims and lower-cases like the protocol normaliser', () => {
  assert.equal(normaliseName('  Alpha.OBS '), 'alpha.obs');
});

test('the reserved list is the protocol\'s, in full', () => {
  assert.deepEqual([...RESERVED_NAMES].sort(), [...CONSENSUS_PARAMS.ons.reserved].sort());
});
