/**
 * ONS owner actions on the platform's ONS page: who may do what, and what is refused before a passphrase is asked for.
 * The chain makes every check again; these tests hold the plain-words refusals and the page wiring in place. The real flow
 * against a real chain in a real browser is `obsidian-app-web/tests/e2e-browser-platform-ons.mjs`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addressOf, addressProblem, ownerRoles, ownerSnapshot, targetProblem, type OwnerNameRecord } from '../web/src/lib/ons-owner.js';
import { makeWallet } from '../../obsidian-core/tests/helpers/harness.js';

const hrp = 'dobs';
const ME = makeWallet().address;
const OTHER = makeWallet().address;
const THIRD = makeWallet().address;
const NOW = 1_700_000_000;
const base: OwnerNameRecord = { name: 'mine', owner: ME, expiresAt: NOW + 1000 };

describe('addressProblem', () => {
  it('refuses an email address, a .obs name, an empty field and a wrong-network address, each in its own words', () => {
    expect(addressProblem('', hrp, 'the recipient')).toMatch(/Enter the recipient/);
    expect(addressProblem('someone@gmail.com', hrp, 'the recipient')).toMatch(/not an email address/);
    expect(addressProblem('friend.obs', hrp, 'the recipient')).toMatch(/\.obs name is not accepted/);
    expect(addressProblem('dobs1notanaddress', hrp, 'the recipient')).toMatch(/not a valid dobs1/);
    expect(addressProblem(OTHER.replace(/^dobs/, 'obs'), hrp)).toMatch(/not a valid/);
    expect(addressProblem(OTHER, hrp)).toBeNull();
    expect(addressProblem(`  ${OTHER}  `, hrp)).toBeNull();
  });
  it('lower-cases an all-uppercase address (a QR code) to the one spelling the chain keys on', () => {
    expect(addressOf(OTHER.toUpperCase())).toBe(OTHER);
    expect(addressProblem(OTHER.toUpperCase(), hrp)).toBeNull();
  });
});

describe('ownerRoles', () => {
  it('knows the owner, the recipient of an open offer, the recovery address and the parties to a recovery', () => {
    expect(ownerRoles(base, ME, NOW)).toMatchObject({ isOwner: true, involved: true, locked: false });
    expect(ownerRoles(base, OTHER, NOW).involved).toBe(false);
    const offered = { ...base, pendingTransfer: { to: OTHER, offerExpiresAt: NOW + 100 } };
    expect(ownerRoles(offered, OTHER, NOW)).toMatchObject({ offeredToMe: true, involved: true, isOwner: false });
    expect(ownerRoles(offered, THIRD, NOW).involved).toBe(false);
    const recovery = { ...base, recoveryAddress: OTHER };
    expect(ownerRoles(recovery, OTHER, NOW)).toMatchObject({ canStartRecovery: true, involved: true });
    const inFlight = { ...recovery, pendingRecovery: { by: OTHER, newAddress: THIRD, effectiveAt: NOW + 500 } };
    expect(ownerRoles(inFlight, OTHER, NOW)).toMatchObject({ canStartRecovery: false, inRecovery: true, recoveryWaitSeconds: 500 });
    expect(ownerRoles(inFlight, THIRD, NOW).inRecovery).toBe(true);
    expect(ownerRoles(inFlight, ME, NOW)).toMatchObject({ recoveryInFlight: true, isOwner: true });
  });
  it('an offer that has lapsed is not open, cannot be accepted, and is said to have lapsed', () => {
    const lapsed = { ...base, pendingTransfer: { to: OTHER, offerExpiresAt: NOW - 1 } };
    expect(ownerRoles(lapsed, OTHER, NOW)).toMatchObject({ offerOpen: false, offeredToMe: false, offerLapsedForMe: true });
    expect(ownerRoles(lapsed, ME, NOW).offerOpen).toBe(false);
  });
  it('completing a recovery waits for its delay', () => {
    const wait = { ...base, recoveryAddress: OTHER, pendingRecovery: { by: OTHER, newAddress: OTHER, effectiveAt: NOW + 60 } };
    expect(ownerRoles(wait, OTHER, NOW).recoveryWaitSeconds).toBe(60);
    expect(ownerRoles(wait, OTHER, NOW + 60).recoveryWaitSeconds).toBe(0);
  });
  it('a listed name is locked however the node says so', () => {
    expect(ownerRoles({ ...base, marketStatus: 'LISTED' }, ME, NOW).locked).toBe(true);
    expect(ownerRoles({ ...base, locked: true }, ME, NOW).locked).toBe(true);
    expect(ownerRoles({ ...base, listing: { priceSeals: '1' } }, ME, NOW).locked).toBe(true);
  });
});

describe('targetProblem', () => {
  it('refuses what consensus refuses, with the reason', () => {
    expect(targetProblem('transfer', ME, hrp, base, NOW)).toMatch(/already owns/);
    expect(targetProblem('transfer', OTHER, hrp, { ...base, pendingTransfer: { to: THIRD, offerExpiresAt: NOW + 5 } }, NOW)).toMatch(/already open/);
    expect(targetProblem('transfer', OTHER, hrp, { ...base, pendingTransfer: { to: THIRD, offerExpiresAt: NOW - 5 } }, NOW)).toBeNull();
    expect(targetProblem('recoverySet', ME, hrp, base, NOW)).toMatch(/different wallet/);
    expect(targetProblem('recoverySet', OTHER, hrp, { ...base, pendingRecovery: { by: THIRD, newAddress: THIRD } }, NOW)).toMatch(/in flight/);
    expect(targetProblem('recoveryStart', ME, hrp, base, NOW)).toMatch(/already the owner/);
    expect(targetProblem('transfer', 'a@b.com', hrp, base, NOW)).toMatch(/email/);
    expect(targetProblem('update', OTHER, hrp, base, NOW)).toBeNull();
  });
});

describe('ownerSnapshot', () => {
  it('changes whenever something a review depends on changes, and not otherwise', () => {
    const a = ownerSnapshot(base);
    expect(ownerSnapshot({ ...base })).toBe(a);
    expect(ownerSnapshot({ ...base, address: OTHER })).not.toBe(a);
    expect(ownerSnapshot({ ...base, pendingTransfer: { to: OTHER } })).not.toBe(a);
    expect(ownerSnapshot({ ...base, recoveryAddress: OTHER })).not.toBe(a);
    expect(ownerSnapshot({ ...base, marketStatus: 'LISTED' })).not.toBe(a);
    expect(ownerSnapshot(null)).not.toBe(a);
  });
});

describe('the ONS page wiring', () => {
  const page = readFileSync(new URL('../web/src/pages/ons.ts', import.meta.url), 'utf8');
  it('every owner action has a button that opens its review, and the review signs through the shipped operation', () => {
    for (const kind of ['update', 'transfer', 'withdraw', 'accept', 'recoverySet', 'recoveryClear', 'recoveryStart', 'recoveryCancel', 'recoveryFinalize']) {
      // a button opens it: written out, or through the page's `addressForm(id, label, '<kind>', …)` helper
      expect(page, kind).toMatch(new RegExp(`reviewOwner\\('${kind}'|addressForm\\('[a-z-]+', '[^']+', '${kind}'`));
    }
    for (const operation of ['updateNameAddress', 'offerNameTransfer', 'cancelNameTransfer', 'acceptNameTransfer', 'setNameRecovery', 'startNameRecovery', 'cancelNameRecovery', 'finalizeNameRecovery']) {
      expect(page, operation).toContain(`operations.${operation}(`);
    }
  });
  it('re-reads the name before signing, and says done only after the chain shows it', () => {
    const confirm = page.slice(page.indexOf("const confirm = button('Confirm and sign', async () => {\n    await perform(\n      `${OWNER_TITLES"));
    expect(confirm.indexOf('ownerSnapshot(now) !== snapshot')).toBeGreaterThan(0);
    expect(confirm.indexOf('ownerSnapshot(now) !== snapshot')).toBeLessThan(confirm.indexOf('return act.sign(wallet)'));
    expect(confirm).toContain('act.done(await client.name(full))');
  });
});
