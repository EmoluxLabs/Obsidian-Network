/**
 * The mining gate: consensus-level proof that a claim comes through the account system.
 *
 * WHY IT IS IN CONSENSUS
 *   The platform has always refused to relay a claim from a wallet that is not linked to a signed-in, second-factor
 *   confirmed account. But a node accepts a transaction from anyone, so a person could skip the platform by posting a
 *   claim to a node's `/tx/submit`. A rule that only the platform enforces is not a rule of the network.
 *
 * WHAT THE CHAIN CHECKS (and nothing more)
 *   A claim must carry a certificate signed by one of the issuer keys committed in genesis, naming THIS network, THIS
 *   wallet and THIS claim id, signed no more than `certificateTtlSeconds` before the including block and no more than
 *   `clockSkewSeconds` after it. That is all. The chain does not learn who the account is, and the issuer does not
 *   decide when the wallet may claim: timing and the claim limits stay a pure function of the wallet's own history.
 *
 * WHY THE CERTIFICATE IS BOUND TO ONE CLAIM
 *   The claim id is unique per wallet and sequence and is replay-protected, so a certificate cannot be reused, moved to
 *   another wallet, or carried to another network. It also expires in minutes, so a leaked one is nearly worthless and
 *   an account that is disabled stops being able to mine at once.
 *
 * FAIL CLOSED
 *   A chain whose genesis commits no issuer keys cannot accept any claim.
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { DOMAIN } from '../protocol/domains.js';
import { ErrCode, reject } from '../protocol/errors.js';
import { signMessage, verifyMessage } from '../crypto/keys.js';
import { utf8 } from '../crypto/hash.js';
import type { MiningGateCertificate } from '../protocol/types.js';

export interface MiningGateSubject {
  networkId: string;
  chainId: number;
  /** The wallet that will sign and send the claim. */
  address: string;
  /** The canonical claim id the wallet will put in the claim. */
  claimId: string;
}

/** The exact bytes an issuer signs. Every field is fixed-format so no two different subjects share a message. */
export function miningGateMessage(subject: MiningGateSubject, issuedAt: number): Uint8Array {
  return utf8(`GATE|${subject.networkId}|${subject.chainId}|${subject.address}|${subject.claimId}|${issuedAt}`);
}

/** Issue a certificate. Used by the platform (with its issuer key) and by tests and tooling; never by a node. */
export function issueMiningGateCertificate(
  issuerPrivateKeyHex: string,
  issuerPublicKeyHex: string,
  subject: MiningGateSubject,
  issuedAt: number,
): MiningGateCertificate {
  return {
    issuer: issuerPublicKeyHex.toLowerCase(),
    issuedAt,
    signature: signMessage(DOMAIN.MINING_GATE, miningGateMessage(subject, issuedAt), issuerPrivateKeyHex),
  };
}

/**
 * Reject the claim unless `certificate` is valid for `subject` at `protocolTime`.
 * `issuerKeys` are the keys committed in genesis (state.s.genesis.miningGateKeys).
 */
export function assertMiningGate(
  issuerKeys: readonly string[],
  certificate: MiningGateCertificate | undefined,
  subject: MiningGateSubject,
  protocolTime: number,
): void {
  if (issuerKeys.length === 0) {
    reject(ErrCode.MINING_GATE_REQUIRED, 'this chain commits no mining gate issuer key, so no claim can be accepted');
  }
  if (!certificate) {
    reject(ErrCode.MINING_GATE_REQUIRED, 'a mining claim must carry a certificate from the mining gate');
  }
  const { certificateTtlSeconds, clockSkewSeconds } = CONSENSUS_PARAMS.miningGate;
  if (!Number.isSafeInteger(certificate.issuedAt) || certificate.issuedAt <= 0) {
    reject(ErrCode.MINING_GATE_INVALID, 'the gate certificate has no valid issue time');
  }
  if (certificate.issuedAt > protocolTime + clockSkewSeconds) {
    reject(ErrCode.MINING_GATE_INVALID, 'the gate certificate is dated after the block that includes it');
  }
  if (protocolTime > certificate.issuedAt + certificateTtlSeconds) {
    reject(ErrCode.MINING_GATE_INVALID, 'the gate certificate has expired', {
      issuedAt: certificate.issuedAt,
      validForSeconds: certificateTtlSeconds,
    });
  }
  if (!issuerKeys.includes(certificate.issuer)) {
    reject(ErrCode.MINING_GATE_INVALID, 'the gate certificate was not issued by a key this chain committed');
  }
  if (!verifyMessage(DOMAIN.MINING_GATE, miningGateMessage(subject, certificate.issuedAt), certificate.signature, certificate.issuer)) {
    reject(ErrCode.MINING_GATE_INVALID, 'the gate certificate signature does not match this wallet and claim');
  }
}
