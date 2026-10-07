import { describe, expect, it } from 'vitest';
import {
  certificateShape,
  finalityQuorum,
  finalityVoteId,
  finalityVoteShape,
  makeVoteEvidence,
  signFinalityVote,
  validatorSetHash,
  verifyFinalityVoteSignature,
} from '../../src/consensus/finality.js';
import { generateKeyPair } from '../../src/crypto/keys.js';
import { getNetwork } from '../../src/protocol/networks.js';
import type { FinalityVote } from '../../src/protocol/types.js';
import { PARAMS_HASH } from '../../src/blockchain/state-root.js';
import { PROTOCOL_VERSION } from '../../src/version.js';

const net=getNetwork('devnet');
function voteFor(key=generateKeyPair(net.addressHrp),blockHash='22'.repeat(32)):FinalityVote {
  return signFinalityVote({protocolVersion:PROTOCOL_VERSION,networkId:net.networkId,chainId:net.chainId,genesisId:'11'.repeat(20),paramsHash:PARAMS_HASH,type:'POT_FINALITY',finalizedHeight:7,finalizedHash:'33'.repeat(32),height:8,round:0,blockHash,parentHash:'33'.repeat(32),validatorSetHash:'44'.repeat(32),validator:key.address,publicKey:key.publicKey},key.privateKey);
}

describe('finality primitives',()=>{
  it('uses an explicit greater-than-two-thirds equal-membership boundary',()=>{
    expect([0,1,2,3,4,5,6,7,8,9,256].map(finalityQuorum)).toEqual([0,1,2,3,3,4,5,5,6,7,171]);
  });

  it('domain-separates votes by network, protocol, anchor, target, round, and validator set',()=>{
    const vote=voteFor();
    expect(finalityVoteShape(vote)).toEqual({ok:true});
    expect(verifyFinalityVoteSignature(vote,net.addressHrp)).toBe(true);
    for(const mutation of [
      {...vote,networkId:'obsidian-testnet-1'},
      {...vote,protocolVersion:'1.4.0'},
      {...vote,finalizedHash:'55'.repeat(32)},
      {...vote,blockHash:'66'.repeat(32)},
      {...vote,round:1},
      {...vote,validatorSetHash:'77'.repeat(32)},
    ]) expect(verifyFinalityVoteSignature(mutation,net.addressHrp)).toBe(false);
  });

  it('canonicalizes conflicting vote evidence independent of delivery order',()=>{
    const key=generateKeyPair(net.addressHrp), first=voteFor(key,'22'.repeat(32)), second=voteFor(key,'55'.repeat(32));
    const a=makeVoteEvidence(first,second), b=makeVoteEvidence(second,first);
    expect(a).toEqual(b); expect(a.firstId<a.secondId).toBe(true); expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(finalityVoteId(first)).not.toBe(finalityVoteId(second));
  });

  it('hashes validator membership in canonical order supplied by the state adapter and bounds certificates',()=>{
    const one=generateKeyPair(net.addressHrp),two=generateKeyPair(net.addressHrp);
    expect(validatorSetHash([{address:one.address,publicKey:one.publicKey},{address:two.address,publicKey:two.publicKey}])).not.toBe(validatorSetHash([{address:two.address,publicKey:two.publicKey},{address:one.address,publicKey:one.publicKey}]));
    const vote=voteFor(one);
    expect(certificateShape({version:1,finalizedHeight:7,finalizedHash:vote.finalizedHash,height:8,blockHash:vote.blockHash,parentHash:vote.parentHash,validatorSetHash:vote.validatorSetHash,quorum:1,validatorCount:1,votes:[vote]})).toEqual({ok:true});
    expect(certificateShape({version:1,finalizedHeight:7,finalizedHash:vote.finalizedHash,height:8,blockHash:vote.blockHash,parentHash:vote.parentHash,validatorSetHash:vote.validatorSetHash,quorum:2,validatorCount:1,votes:[vote]}).ok).toBe(false);
  });
});
