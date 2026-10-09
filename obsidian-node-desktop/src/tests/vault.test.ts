import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCore } from '../core/core-loader.js';
import { PassphraseError, openVaultPhrase, sealVault } from '../core/vault.js';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASS = 'correct horse battery staple';

test('vault: round trip, wrong passphrase, tamper detection', async () => {
  const core = await loadCore();
  const v = await sealVault(core, PHRASE, PASS, 'dobs');
  assert.equal(v.address, 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0', 'standard test phrase → known devnet address');
  assert.equal(v.kdf, 'PBKDF2-SHA256');
  assert.equal(v.iterations, 600_000);
  assert.ok(!JSON.stringify(v).includes('abandon'), 'phrase is not in the envelope');
  assert.equal(await openVaultPhrase(v, PASS), PHRASE);
  await assert.rejects(openVaultPhrase(v, 'wrong passphrase!!'), PassphraseError);
  const flipped = { ...v, ciphertext: Buffer.from(Buffer.from(v.ciphertext, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b))).toString('base64') };
  await assert.rejects(openVaultPhrase(flipped, PASS), PassphraseError, 'a modified vault does not open');
  await assert.rejects(openVaultPhrase({ ...v, iterations: 10 }, PASS), /key-derivation cost/);
  await assert.rejects(sealVault(core, PHRASE, 'short', 'dobs'), /at least 12/);
  await assert.rejects(sealVault(core, 'not a valid phrase at all', PASS, 'dobs'));
});

test('vault: the same envelope is opened by the web app (interop), when the monorepo is present', async (t) => {
  // Inside the Obsidian-Network repository the web app is a sibling of this directory.
  const web = process.env.OBSIDIAN_APP_WEB_VAULT ?? fileURLToPath(new URL('../../../obsidian-app-web/web/vault.mjs', import.meta.url));
  if (!existsSync(web)) return t.skip('monorepo not present');
  let mod: any;
  try {
    mod = await import(pathToFileURL(web).href);
  } catch (error) {
    return t.skip(`web vault module cannot be loaded here: ${(error as Error).message}`);
  }
  const core = await loadCore();
  const ours = await sealVault(core, PHRASE, PASS, 'dobs');
  const opened = await mod.openVault(ours, PASS);
  assert.equal(typeof opened === 'string' ? opened : opened.phrase ?? opened, PHRASE, 'web app opens our vault');
  const theirs = await mod.createVault(PHRASE, PASS, 'dobs');
  assert.equal(await openVaultPhrase(theirs, PASS), PHRASE, 'we open the web app’s vault');
});
