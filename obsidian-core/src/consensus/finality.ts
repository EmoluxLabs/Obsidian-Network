/** Native equal-membership checkpoint finality for Proof of Time. */
import type { WorldState } from '../blockchain/state.js';
import { Writer } from '../protocol/encoding.js';
import { DOMAIN } from '../protocol/domains.js';
import { domainHash, fromHex, toHex, utf8 } from '../crypto/hash.js';
import { addressFromPublicKey, signDigest, verifyDigest } from '../crypto/keys.js';
import type {
  EquivocationEvidence, FinalityCertificate, FinalityVote,
  ProposerEquivocationEvidence, VoteEquivocationEvidence,
} from '../protocol/types.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';

export interface FinalityValidator { address: string; publicKey: string }

/** Active registry records with the exact protocol bond, sorted and equally weighted. */
export function finalityValidators(state: WorldState): FinalityValidator[] {
  const out: FinalityValidator[] = [];
  for (const address of [...state.s.validators].sort()) {
    const validator = state.s.accounts.get(address)?.validator;
    if (validator?.status === 'ACTIVE' && validator.bond === CONSENSUS_PARAMS.consensus.validatorBond) out.push({ address, publicKey: validator.validatorKey });
  }
  return out;
}

/**
 * Initial finality committee: exactly the keys committed by this network's
 * genesis, and only after every committed key has registered and bonded through
 * the ordinary validator transaction. Additional registrations are excluded
 * until the bootstrap committee certifies the first checkpoint.
 */
export function bootstrapFinalityValidators(state: WorldState, genesisKeys: readonly string[]): FinalityValidator[] {
  const committed = state.s.genesis.bootstrapValidatorKeys;
  if (!Array.isArray(genesisKeys) || !Array.isArray(committed) || genesisKeys.length === 0 || genesisKeys.length !== committed.length) return [];
  const configured = [...genesisKeys].sort();
  const stateCommitment = [...committed].sort();
  if (configured.some((key, index) => typeof key !== 'string' || key !== stateCommitment[index] || (index > 0 && key === configured[index - 1]))) return [];
  const activeByKey = new Map(finalityValidators(state).map((validator) => [validator.publicKey, validator]));
  const selected = configured.map((key) => activeByKey.get(key));
  if (selected.some((validator) => validator === undefined)) return [];
  return (selected as FinalityValidator[]).sort((a, b) => a.address.localeCompare(b.address));
}

export function finalityQuorum(count: number): number {
  if (!Number.isSafeInteger(count) || count <= 0) return 0;
  return Math.floor((2 * count) / 3) + 1;
}

export function validatorSetHash(validators: FinalityValidator[]): string {
  const w = new Writer(); w.u32(validators.length);
  for (const validator of validators) { w.string(validator.address); w.string(validator.publicKey); }
  return toHex(domainHash(DOMAIN.FINALITY_VALIDATOR_SET, w.finish()));
}

export function encodeFinalityVoteForSigning(vote: Omit<FinalityVote, 'signature'> | FinalityVote): Uint8Array {
  const w = new Writer();
  w.string(vote.protocolVersion); w.string(vote.networkId); w.u32(vote.chainId);
  w.string(vote.genesisId); w.string(vote.paramsHash); w.string(vote.type);
  w.u32(vote.finalizedHeight); w.string(vote.finalizedHash); w.u32(vote.height); w.u32(vote.round);
  w.string(vote.blockHash); w.string(vote.parentHash); w.string(vote.validatorSetHash);
  w.string(vote.validator); w.string(vote.publicKey); return w.finish();
}
export function finalityVoteDigest(vote: Omit<FinalityVote, 'signature'> | FinalityVote): Uint8Array {
  return domainHash(DOMAIN.FINALITY_VOTE, encodeFinalityVoteForSigning(vote));
}
export function finalityVoteId(vote: FinalityVote): string {
  const w = new Writer(); w.raw(encodeFinalityVoteForSigning(vote)); w.string(vote.signature);
  return toHex(domainHash(DOMAIN.EQUIVOCATION_EVIDENCE, w.finish()));
}
export function signFinalityVote(unsigned: Omit<FinalityVote, 'signature'>, privateKey: string): FinalityVote {
  return { ...unsigned, signature: toHex(signDigest(finalityVoteDigest(unsigned), privateKey)) };
}
export function verifyFinalityVoteSignature(vote: FinalityVote, hrp: string): boolean {
  if (!verifyDigest(finalityVoteDigest(vote), vote.signature, vote.publicKey)) return false;
  try { return addressFromPublicKey(vote.publicKey, hrp) === vote.validator; } catch { return false; }
}

export function finalityVoteShape(vote: FinalityVote): { ok: true } | { ok: false; reason: string } {
  if (!vote || typeof vote !== 'object' || Array.isArray(vote)) return { ok: false, reason: 'vote is not an object' };
  const allowedFields = new Set(['protocolVersion','networkId','chainId','genesisId','paramsHash','type','finalizedHeight','finalizedHash','height','round','blockHash','parentHash','validatorSetHash','validator','publicKey','signature']);
  if (Object.keys(vote).some((key) => !allowedFields.has(key))) return { ok: false, reason: 'vote contains unsupported fields' };
  if (vote.type !== 'POT_FINALITY') return { ok: false, reason: 'unknown finality vote type' };
  for (const [name, value] of [['finalizedHeight', vote.finalizedHeight], ['height', vote.height], ['round', vote.round]] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) return { ok: false, reason: `${name} is not bounded` };
  }
  if (vote.height <= vote.finalizedHeight) return { ok: false, reason: 'target is not above anchor' };
  for (const [name, value, pattern] of [
    ['genesisId', vote.genesisId, /^[0-9a-f]{40}$/], ['paramsHash', vote.paramsHash, /^[0-9a-f]{32}$/],
    ['finalizedHash', vote.finalizedHash, /^[0-9a-f]{64}$/], ['blockHash', vote.blockHash, /^[0-9a-f]{64}$/],
    ['parentHash', vote.parentHash, /^[0-9a-f]{64}$/], ['validatorSetHash', vote.validatorSetHash, /^[0-9a-f]{64}$/],
    ['publicKey', vote.publicKey, /^0[23][0-9a-f]{64}$/], ['signature', vote.signature, /^[0-9a-f]{128}$/],
  ] as const) if (typeof value !== 'string' || !pattern.test(value)) return { ok: false, reason: `${name} is malformed` };
  if (typeof vote.validator !== 'string' || vote.validator.length < 8 || vote.validator.length > 128) return { ok: false, reason: 'validator malformed' };
  if (typeof vote.protocolVersion !== 'string' || vote.protocolVersion.length > 32) return { ok: false, reason: 'protocol malformed' };
  if (typeof vote.networkId !== 'string' || vote.networkId.length > 64) return { ok: false, reason: 'network malformed' };
  if (!Number.isSafeInteger(vote.chainId) || vote.chainId < 0) return { ok: false, reason: 'chain malformed' };
  return { ok: true };
}

export function certificateShape(c: FinalityCertificate): { ok: true } | { ok: false; reason: string } {
  if (!c || c.version !== 1 || !Array.isArray(c.votes)) return { ok: false, reason: 'unsupported or missing certificate' };
  if (c.votes.length === 0 || c.votes.length > CONSENSUS_PARAMS.consensus.finality.maxValidators) return { ok: false, reason: 'vote count outside bounds' };
  if (!Number.isSafeInteger(c.validatorCount) || c.validatorCount <= 0 || c.validatorCount > CONSENSUS_PARAMS.consensus.finality.maxValidators || c.quorum !== finalityQuorum(c.validatorCount) || c.votes.length < c.quorum) return { ok: false, reason: 'quorum metadata invalid' };
  return { ok: true };
}

function evidenceId(parts: string[]): string { return toHex(domainHash(DOMAIN.EQUIVOCATION_EVIDENCE, utf8(parts.join('|')))); }
export function makeProposerEvidence(input: Omit<ProposerEquivocationEvidence, 'version'|'id'|'type'|'messageType'>): ProposerEquivocationEvidence {
  const [firstId, secondId] = [input.firstId, input.secondId].sort();
  const headers = input.firstId === firstId ? [input.firstHeader, input.secondHeader] : [input.secondHeader, input.firstHeader];
  return { version: 1, id: evidenceId(['PROPOSER_EQUIVOCATION', input.validator, String(input.height), String(input.round), firstId, secondId]), type: 'PROPOSER_EQUIVOCATION', validator: input.validator, height: input.height, round: input.round, messageType: 'BLOCK_PROPOSAL', firstId, secondId, firstHeader: headers[0]!, secondHeader: headers[1]! };
}
export function makeVoteEvidence(first: FinalityVote, second: FinalityVote): VoteEquivocationEvidence {
  const a = finalityVoteId(first), b = finalityVoteId(second); const ordered = a < b ? [first, second] : [second, first]; const ids = [a,b].sort();
  return { version:1, id:evidenceId(['VOTE_EQUIVOCATION',first.validator,first.finalizedHash,ids[0]!,ids[1]!]), type:'VOTE_EQUIVOCATION', validator:first.validator, height:Math.min(first.height,second.height), round:Math.min(first.round,second.round), messageType:'POT_FINALITY', firstId:ids[0]!, secondId:ids[1]!, firstVote:ordered[0]!, secondVote:ordered[1]! };
}
export function evidenceSerializedBytes(e: EquivocationEvidence): number { return Buffer.byteLength(JSON.stringify(e), 'utf8'); }
export function digestBytes(hex: string): Uint8Array | null { try { const b=fromHex(hex); return b.length===32?b:null; } catch { return null; } }
