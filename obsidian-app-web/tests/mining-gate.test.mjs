/**
 * The Mine screen says what is missing before it offers a claim.
 *
 * The platform refuses a claim unless the account has the signing wallet linked and MFA
 * confirmed (and the claim is signed by that wallet). This screen is only the courtesy
 * in front of that rule: it must never offer the passphrase field and the sign button to
 * an account the platform would refuse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCREENS } from '../public/screens.mjs';

const ME = 'dobs1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'dobs1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const mining = { eligible: true, secondsRemaining: 0, rewardPerClaimObs: '0.000166666666666666', claimsThisCycle: 0, claimsRemainingInCycle: 6, totalClaims: 0 };
const screen = (account, walletAddress = ME) =>
  SCREENS.mine({ status: { height: 1 }, mining, walletAddress, account, balance: null, params: null, schedule: null, busy: null, error: '', notice: '' });

const account = (over = {}) => ({ id: 'a', email: 'm@gmail.com', mfaEnabled: true, miningEnabled: true, walletAddress: ME, ...over });
const offersClaim = (html) => html.includes('SIGN &amp; SUBMIT CLAIM') || html.includes('SIGN & SUBMIT CLAIM');

test('an account with no linked wallet is asked to link one, and offered no claim', () => {
  const html = screen(account({ walletAddress: undefined }));
  assert.match(html, /LINK YOUR WALLET TO MINE/);
  assert.match(html, /ObsidianLinkAddress\(\)/);
  assert.ok(!offersClaim(html));
  assert.ok(!html.includes('id="pp"'), 'no passphrase field for a claim that would be refused');
});

test('a device wallet that is not the linked one is named as such, and offered no claim', () => {
  const html = screen(account({ walletAddress: OTHER }));
  assert.match(html, /LINKED WALLET/);
  assert.ok(html.includes(OTHER));
  assert.ok(!offersClaim(html));
});

test('a linked account whose mining is closed is sent to confirm two-factor', () => {
  const html = screen(account({ miningEnabled: false, mfaEnabled: false }));
  assert.match(html, /CONFIRM TWO-FACTOR TO MINE/);
  assert.match(html, /ObsidianGo\('menu'\)/);
  assert.ok(!offersClaim(html));
});

test('an account that is linked, MFA-confirmed and holds the linked wallet may claim', () => {
  const html = screen(account());
  assert.ok(offersClaim(html));
  assert.ok(!/LINK YOUR WALLET|CONFIRM TWO-FACTOR/.test(html));
});
