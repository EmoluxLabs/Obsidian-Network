/**
 * Test-only: give a disposable devnet wallet its first coins with a mining claim, signed by the real wallet code and
 * certified by the test's own gate key (see stack.mjs). The wallet app under test has no such feature and needs none.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repo } from './stack.mjs';
import * as bundle from '../../../obsidian-app-web/web/index.mjs';

const imp = (p) => import(pathToFileURL(join(repo, p)).href);

export async function claimDirect({ phrase, rpcUrl, gate }) {
  const { NETWORKS } = await imp('obsidian-core/dist/protocol/networks.js');
  const { issueMiningGateCertificate } = await imp('obsidian-core/dist/mining/gate.js');
  const def = NETWORKS.devnet;
  const wallet = bundle.walletFromPhrase(phrase, def.addressHrp);
  const get = async (p) => (await fetch(rpcUrl + p)).json();
  const post = async (p, b) => {
    const r = await fetch(rpcUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  };
  const st = await get(`/mining/status?address=${wallet.address}`);
  if (!st.eligible) throw new Error(`not eligible to claim: ${JSON.stringify(st)}`);
  const [health, status, nonce, pot] = await Promise.all([get('/health'), get('/status'), get(`/wallet/${wallet.address}/next-nonce`), get('/pot')]);
  const gateCert = issueMiningGateCertificate(
    gate.privateKey, gate.publicKey,
    { networkId: def.networkId, chainId: def.chainId, address: wallet.address, claimId: st.nextClaimId },
    Math.floor(Date.now() / 1000),
  );
  const signed = bundle.sign({
    wallet, chainId: def.chainId, protocolVersion: health.protocolVersion, nonce: nonce.nextNonce,
    type: bundle.TxType.MINING_CLAIM, gas: 0n,
    body: bundle.buildMiningBody({ claimId: st.nextClaimId, claimSequence: st.nextClaimSequence, viaNodeId: '', gate: gateCert }),
    memo: '', validUntil: Math.max(pot.protocolTime, status.lastBlockTimestamp) + 600,
  });
  const res = await post('/tx/submit', { tx: signed.hex });
  if (res.status >= 300) throw new Error(`the funding claim was refused: ${JSON.stringify(res.body)}`);
  return { address: wallet.address, txId: signed.txId, reward: st.rewardPerClaimObs, response: res.body };
}

/** Wait until the node reports a balance for `address` (seals, as a string) satisfying `test`. */
export async function waitBalance(rpcUrl, address, test, ms = 120_000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    const r = await fetch(`${rpcUrl}/wallet/balance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
    last = await r.json();
    if (r.ok && test(BigInt(last.balanceSeals ?? 0))) return last;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`the balance never satisfied the condition; last answer: ${JSON.stringify(last)}`);
}
