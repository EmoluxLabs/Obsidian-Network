/**
 * Linking this device's wallet to the account, client side.
 *
 * The platform binds an address to an account for good, and only on proof that the device
 * holds the key. These tests pin the client's half against the real vault and the real core:
 * the signature must verify under the link domain the CLIENT fixes (never one the server
 * names), the passphrase must never leave the device, and every refusal must come before a
 * key is touched where it can.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.localStorage = (() => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
})();

const { createVault, saveVault, loadVault } = await import('../web/vault.mjs');
const { linkWalletProven } = await import('../web/ops.mjs');
const { walletFromPhrase, signLinkChallenge, WALLET_LINK_DOMAIN } = await import('../web/signing.mjs');
const { verifyMessage, addressFromPublicKey } = await import('../../obsidian-interface/web/core/crypto/keys.js');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'correct horse battery staple';
const OTHER_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const wallet = walletFromPhrase(PHRASE, 'dobs');
const stranger = walletFromPhrase(OTHER_PHRASE, 'dobs');

before(async () => {
  saveVault(await createVault(PHRASE, PASSPHRASE, 'dobs'));
});

const challengeFor = (address) =>
  ['OBSIDIAN WALLET LINK v1', 'network: devnet', 'account: acc_1', `address: ${address}`, 'nonce: ab12', 'expires: later'].join('\n');

function deps(over = {}) {
  const calls = { challenge: [], submitted: [], asked: 0 };
  return {
    calls,
    loadVault: () => loadVault(),
    loadAddress: () => wallet.address,
    requestPassphrase: async () => {
      calls.asked += 1;
      return PASSPHRASE;
    },
    getContext: async () => ({ addressHrp: 'dobs' }),
    linkChallenge: async (address) => {
      calls.challenge.push(address);
      return { message: challengeFor(address), domain: 'OBSIDIAN:EVIL:v1' };
    },
    linkSubmit: async (proof) => {
      calls.submitted.push(proof);
      return { linked: true, account: { walletAddress: proof.address } };
    },
    ...over,
  };
}

test('the link proof is signed by the wallet key under the domain the client fixes, ignoring the server\'s', async () => {
  const d = deps();
  const result = await linkWalletProven(d);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.already, false);
  const [proof] = d.calls.submitted;
  assert.deepEqual(Object.keys(proof).sort(), ['address', 'publicKey', 'signature']);
  assert.equal(proof.address, wallet.address);
  assert.equal(addressFromPublicKey(proof.publicKey, 'dobs'), wallet.address);
  const bytes = new TextEncoder().encode(challengeFor(wallet.address));
  assert.equal(verifyMessage(WALLET_LINK_DOMAIN, bytes, proof.signature, proof.publicKey), true);
  assert.equal(verifyMessage('OBSIDIAN:EVIL:v1', bytes, proof.signature, proof.publicKey), false, 'the server\'s domain was not used');
  assert.ok(!JSON.stringify(proof).includes(PASSPHRASE));
  assert.ok(!JSON.stringify(proof).toLowerCase().includes('private'));
});

test('the domain is the platform\'s own, byte for byte', () => {
  assert.equal(WALLET_LINK_DOMAIN, 'OBSIDIAN:WALLET_LINK:v1');
  // Both products and the server each hold the tag; read them from source so they cannot drift.
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const tag = /WALLET_LINK_DOMAIN\s*=\s*'([^']+)'/;
  assert.equal(read('../../obsidian-interface/web/src/lib/link-wallet.ts').match(tag)?.[1], WALLET_LINK_DOMAIN);
  assert.equal(read('../../obsidian-interface/server/index.ts').match(tag)?.[1], WALLET_LINK_DOMAIN);
});

test('a wallet the account already has is a no-op: no passphrase, no signature', async () => {
  const d = deps({ linkChallenge: async () => ({ alreadyLinked: true, account: { walletAddress: wallet.address } }) });
  const result = await linkWalletProven(d);
  assert.deepEqual({ ok: result.ok, already: result.already }, { ok: true, already: true });
  assert.equal(d.calls.asked, 0);
  assert.equal(d.calls.submitted.length, 0);
});

test('a refusal from the platform (wallet taken, account locked) arrives before any passphrase is asked', async () => {
  for (const code of ['ERR_WALLET_TAKEN', 'ERR_WALLET_LOCKED']) {
    const d = deps({
      linkChallenge: async () => {
        throw Object.assign(new Error(`refused: ${code}`), { code });
      },
    });
    const result = await linkWalletProven(d);
    assert.equal(result.ok, false);
    assert.equal(result.reason, code);
    assert.match(result.message, /refused/);
    assert.equal(d.calls.asked, 0);
    assert.equal(d.calls.submitted.length, 0);
  }
});

test('a dismissed prompt and a wrong passphrase send nothing', async () => {
  const cancelled = deps({ requestPassphrase: async () => '' });
  assert.equal((await linkWalletProven(cancelled)).reason, 'CANCELLED');
  const wrong = deps({ requestPassphrase: async () => 'definitely not the passphrase' });
  assert.equal((await linkWalletProven(wrong)).reason, 'BAD_PASSPHRASE');
  assert.equal(cancelled.calls.submitted.length + wrong.calls.submitted.length, 0);
});

test('a challenge for some other address is never signed', async () => {
  const d = deps({ linkChallenge: async () => ({ message: challengeFor(stranger.address) }) });
  const result = await linkWalletProven(d);
  assert.equal(result.ok, false);
  assert.match(result.message, /not a link challenge for this wallet/);
  assert.equal(d.calls.submitted.length, 0);
  assert.throws(() => signLinkChallenge({ wallet, message: 'OBSIDIAN WALLET LINK v1\naddress: someone-else' }), /not a link challenge/);
  assert.throws(() => signLinkChallenge({ wallet, message: `transfer everything\naddress: ${wallet.address}` }), /not a link challenge/);
});

test('a vault whose wallet is not the cached address links nothing', async () => {
  const d = deps({ loadAddress: () => stranger.address, linkChallenge: async (a) => ({ message: challengeFor(a) }) });
  const result = await linkWalletProven(d);
  assert.equal(result.reason, 'WRONG_WALLET');
  assert.equal(d.calls.submitted.length, 0);
});

test('with no wallet on this device there is nothing to link', async () => {
  assert.equal((await linkWalletProven(deps({ loadVault: () => null }))).reason, 'NO_VAULT');
  assert.equal((await linkWalletProven(deps({ loadAddress: () => null }))).reason, 'NO_WALLET');
});
