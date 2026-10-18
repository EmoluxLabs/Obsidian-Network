/**
 * ONS owner actions in the Web App: every consensus action the owner, recipient or recovery address can take has a screen,
 * and every screen reaches the operation that signs it. The behaviour itself is proven against a real devnet in a real
 * browser (tests/e2e-ons-owner.mjs); these guards keep the wiring from rotting between those runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const real = read('../public/real.mjs');
const screens = read('../public/screens.mjs');
const wallet = read('../public/wallet.mjs');
const ops = read('../web/ops.mjs');

const KINDS = ['update', 'transfer', 'withdraw', 'accept', 'recoverySet', 'recoveryClear', 'recoveryStart', 'recoveryCancel', 'recoveryFinalize'];
const PAIRS = [
  ['updateNameAddress', 'submitNameUpdate'],
  ['transferName', 'submitNameTransfer'],
  ['acceptNameTransfer', 'submitNameTransferAccept'],
  ['cancelNameTransfer', 'submitNameTransferCancel'],
  ['setNameRecovery', 'submitNameRecoverySet'],
  ['startNameRecovery', 'submitNameRecoveryStart'],
  ['cancelNameRecovery', 'submitNameRecoveryCancel'],
  ['finalizeNameRecovery', 'submitNameRecoveryFinalize'],
];

test('every owner action has a review title, a confirm button, a handler and a button that opens it', () => {
  const block = real.slice(real.indexOf('const OWNER_ACTIONS = {'), real.indexOf('g.ObsidianOwnerManage'));
  for (const kind of KINDS) {
    assert.match(block, new RegExp(`\\n    ${kind}: \\{`), `${kind} is a handler in real.mjs`);
    assert.match(screens, new RegExp(`\\n  ${kind}: \\{ title: '[^']+', button: '[^']+' \\}`), `${kind} has review wording`);
    // a button opens it: either written out, or through the screen's `button('<kind>', …)` helper
    const opened = new RegExp(`ObsidianOwnerReview\\('${kind}'\\)|\\bbutton\\('${kind}',`).test(screens);
    assert.ok(opened, `a button opens the ${kind} review`);
  }
});

test('every wallet wrapper reaches its operation, and every handler signs through one', () => {
  for (const [wrapper, operation] of PAIRS) {
    assert.match(wallet, new RegExp(`export (async )?function ${wrapper}\\b|export const ${wrapper}\\b`), `${wrapper} is exported by wallet.mjs`);
    assert.ok(wallet.includes(operation), `${wrapper} calls ${operation}`);
    assert.match(ops, new RegExp(`export async function ${operation}\\b`), `${operation} exists in ops.mjs`);
    assert.ok(real.includes(`${wrapper}(`), `real.mjs calls ${wrapper}`);
  }
});

test('the three entry points are exposed, and the owner block is shown only to the right wallet', () => {
  for (const name of ['ObsidianOwnerManage', 'ObsidianOwnerReview', 'ObsidianOwnerConfirm']) {
    assert.ok(real.includes(`g.${name} = `), `${name} is exposed`);
  }
  assert.match(screens, /MANAGE THIS NAME/);
  assert.match(screens, /OFFERED TO YOUR WALLET/);
  assert.match(screens, /This wallet is the recovery address/);
  assert.match(screens, /A RECOVERY IS IN FLIGHT/);
  assert.match(screens, /NAME_LISTED/, 'a listed name says why its owner actions are off');
});

test('the fields are read BEFORE anything repaints, and a review is checked against the chain again before signing', () => {
  const review = real.slice(real.indexOf('g.ObsidianOwnerReview = '), real.indexOf('g.ObsidianOwnerConfirm = '));
  assert.ok(review.indexOf('field(spec.field)') > 0 && !review.includes('withBusy('), 'the review reads the typed address before it repaints');
  const confirm = real.slice(real.indexOf('g.ObsidianOwnerConfirm = '), real.indexOf('g.ObsidianRegisterName = '));
  assert.ok(confirm.includes('nameSnapshot(await getName(review.name)'), 'the confirm re-reads the name');
  assert.ok(confirm.indexOf('JSON.stringify(now)') < confirm.indexOf('spec.sign('), 'and refuses before it signs when the name changed');
  assert.match(confirm, /confirmThen|marketAction/, 'and shows success only after the node confirms');
});

test('a bad address is refused on the page before a review exists, with no email and no name accepted', () => {
  assert.ok(real.includes('checkAddressText(typed)'), 'the review checks the typed address first');
  assert.match(ops, /must be a wallet address, not an email address/);
  assert.match(ops, /a \.obs name is not accepted here/);
});
