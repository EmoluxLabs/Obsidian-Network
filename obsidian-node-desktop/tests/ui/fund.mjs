// Test-only: fund a disposable devnet wallet with a mining claim sent straight to the node,
// using the same core encoders the app uses. The app itself has no mining feature.
//
// Protocol 1.7.0: the chain accepts a claim only with a certificate from the mining gate, so the test network is started
// with an issuer key the test holds (`gate`), and signs the certificate itself — as a real operator's platform does for
// a signed-in account. Without `gate` the claim goes without a certificate and the chain refuses it.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = new URL('../../', import.meta.url).pathname;
const imp = (p) => import(pathToFileURL(join(root, p)).href);

export async function claimDirect({ phrase, rpcUrl, network = 'devnet', gate }) {
  const { loadCore } = await imp('dist/core/core-loader.js');
  const core = await loadCore();
  const mining = await imp('vendor/obsidian-core/dist/transactions/executors/mining.js');
  const gateModule = await imp('vendor/obsidian-core/dist/mining/gate.js');
  const def = core.networks.NETWORKS[network];
  const w = core.mnemonic.deriveWallet(phrase, 0, 0, undefined, def.addressHrp);
  const address = w.address ?? core.keys.addressFromPublicKey(w.publicKey, def.addressHrp);
  const get = async (p) => (await fetch(rpcUrl + p)).json();
  const post = async (p, b) => (await fetch(rpcUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
  const st = await get(`/mining/status?address=${address}`);
  if (!st.eligible) throw new Error('not eligible: ' + JSON.stringify(st));
  const health = await get('/health');
  const pot = await get('/pot');
  const status = await get('/status');
  const nonce = (await get(`/wallet/${address}/next-nonce`)).nextNonce;
  const env = core.encode.signTransaction({
    sender: address, privateKeyHex: w.privateKey, publicKeyHex: w.publicKey, chainId: def.chainId, protocolVersion: health.protocolVersion,
    nonce, type: core.types.TxType.MINING_CLAIM, gas: 0n,
    body: mining.encodeMiningBody({
      claimId: st.nextClaimId,
      claimSequence: st.nextClaimSequence,
      viaNodeId: '',
      gate: gate
        ? gateModule.issueMiningGateCertificate(gate.privateKey, gate.publicKey, { networkId: def.networkId, chainId: def.chainId, address, claimId: st.nextClaimId }, Math.floor(Date.now() / 1000))
        : undefined,
    }),
    validUntil: Math.max(pot.protocolTime, status.lastBlockTimestamp) + 600,
  });
  const hex = Buffer.from(core.encode.encodeSignedTx(env)).toString('hex');
  const res = await post('/tx/submit', { tx: hex });
  return { address, txId: core.encode.txIdOf(env), res, mining: st };
}
