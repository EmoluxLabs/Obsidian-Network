/**
 * Reads of the chain, through the node routes the platform's gateway already allows.
 *
 * Nothing is computed here that the node knows. A read that fails is reported as a failure: it is never turned into
 * zero, an empty list or a plausible default, because a balance of "0" that really means "I could not ask" is the
 * most expensive lie a wallet can tell.
 */

import { getBalance, getAddressHistory, getStatus, getTransaction } from '/js/shared/data.mjs';
import { getContext } from '/js/shared/wallet.mjs';

const isSeals = (v) => typeof v === 'string' && /^\d+$/.test(v);

/** The node's own record of this address' balance, in exact seals. */
export async function fetchBalance(address) {
  const record = await getBalance(address);
  const seals = record?.balanceSeals ?? record?.balance;
  if (!isSeals(String(seals ?? ''))) throw new Error('The node did not report a balance for this address.');
  return { seals: BigInt(seals), nonce: Number.isInteger(record?.nonce) ? record.nonce : null };
}

/** Recent transactions of this address as the node's indexer lists them (counterparties masked by the node). */
export async function fetchHistory(address, limit = 50) {
  const answer = await getAddressHistory(address, limit);
  if (!Array.isArray(answer?.transactions)) throw new Error('The node did not return a history.');
  return answer.transactions.filter((t) => t && typeof t === 'object');
}

/** Head height and clock of the node, with the network identity check done by the shared context. */
export async function fetchNode() {
  const status = await getStatus();
  const height = Number(status?.height);
  const lastBlockTimestamp = Number(status?.lastBlockTimestamp);
  if (!Number.isInteger(height)) throw new Error('The node did not report its height.');
  return {
    height,
    lastBlockTimestamp: Number.isFinite(lastBlockTimestamp) ? lastBlockTimestamp : null,
    syncing: Boolean(status?.syncing),
    peers: Number.isInteger(status?.peers) ? status.peers : null,
  };
}

/**
 * Verify, and return, which network this page and its node are. Throws when they disagree or when the page cannot
 * tell: the wallet signs nothing in that state.
 */
export async function verifyNetwork() {
  const context = await getContext();
  return context;
}

/**
 * What one transaction id looks like to the node right now: confirmed (with the node's confirmation count), pending
 * in its mempool, missing, or unreachable. A 404 is "missing", every other failure is "error".
 */
export async function observeTx(txId) {
  try {
    const record = await getTransaction(txId);
    if (record?.status === 'PENDING') return { kind: 'pending', record };
    if (record?.confirmed === true && Number.isInteger(record?.height)) {
      return { kind: 'confirmed', confirmations: Math.max(1, Number(record.confirmations) || 1), record };
    }
    return { kind: 'error', error: new Error('The node answered with something this wallet does not recognise.') };
  } catch (error) {
    if (error?.status === 404) return { kind: 'missing' };
    return { kind: 'error', error };
  }
}

/**
 * The node's quote for a payment. The wallet signs the protocol's fee from its own copy of the rule
 * (`expectedGas`) and compares it with this one: a disagreement means this page and that node do not run the
 * same fee rule, and nothing is signed.
 */
export async function fetchQuote(address, amountObs) {
  const response = await fetch(`/api/rpc?path=${encodeURIComponent('/wallet/quote')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ address, amountObs }),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data || typeof data !== 'object') {
    throw new Error(data?.error || `The node could not quote this payment (HTTP ${response.status}).`);
  }
  return data;
}
