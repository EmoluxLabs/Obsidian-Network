/** Adversarial integration tests for native Proof-of-Time checkpoint finality. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import { blockHash } from '../../src/blockchain/block.js';
import { proposerRound } from '../../src/consensus/proposer.js';
import { signFinalityVote } from '../../src/consensus/finality.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { TxType, ValidatorOp, type Block, type FinalityCertificate, type FinalityVote } from '../../src/protocol/types.js';
import {
  createHarness,
  forkParent,
  makeWallet,
  signedClaim,
  signedPayment,
  validatorBody,
  type Harness,
  type TestWallet,
} from '../helpers/harness.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { parseObs } from '../../src/protocol/amount.js';

const open: Harness[] = [];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));});
afterEach(() => { while (open.length) open.pop()!.close(); vi.useRealTimers(); });
function mine(h:Harness,count:number):void { for(let i=0;i<count;i+=1){vi.advanceTimersByTime(1_000);h.produce();} }
function produceBySchedule(h:Harness,wallets:TestWallet[]) {
  const address=h.chain.scheduledProposerNow();
  const producer=wallets.find(wallet=>wallet.address===address);
  if(!producer) throw new Error(`no test wallet for scheduled proposer ${address}`);
  return h.produce([],{producer});
}
function mineBySchedule(h:Harness,count:number,wallets:TestWallet[]):void {
  for(let i=0;i<count;i+=1){vi.advanceTimersByTime(1_000);produceBySchedule(h,wallets);}
}
/**
 * The round a stored block occupies, derived exactly as the protocol derives it.
 *
 * A vote carries the round it was cast in, and the protocol recomputes that
 * round from the block's own timestamp — so a test that re-points a vote at a
 * sibling block must re-derive the round too. A sibling one second older may
 * stand in the same round; one five seconds older does not, and the vote is
 * then refused as a metadata mismatch.
 */
function blockRound(h:Harness,block:Block):number {
  const parent=h.chain.store.getIndexEntry(block.header.prevHash);
  if(!parent) throw new Error('block parent is not indexed');
  return proposerRound(parent.timestamp,block.header.timestamp);
}

/**
 * Two blocks from the same producer, at the same height, in the SAME proposer round.
 *
 * That last part is the whole point: the protocol derives a round from a block's
 * timestamp (`proposerRound`, one round per 5-second slot), and two blocks by one
 * producer in different rounds are not equivocation — they are two rounds. A
 * sibling built a few seconds later may therefore be perfectly valid and still
 * prove nothing, which is why the pair is searched inside one slot instead of
 * stepping the clock until the hashes order themselves.
 *
 * The sibling is chosen to hash HIGHER than the canonical block, so fork choice
 * (lowest hash wins on equal weight) keeps the canonical block. Only a finality
 * certificate may move the chain onto the sibling, which is what these tests
 * then assert.
 */
function equivocatingSiblings(h:Harness,parent:ReturnType<typeof forkParent>):{canonical:ReturnType<Harness['makeBlockOn']>;alternate:ReturnType<Harness['makeBlockOn']>} {
  const parentEntry=h.chain.store.getIndexEntry(parent.hash);
  if(!parentEntry) throw new Error('fork parent is not indexed');
  const parentTs=Math.max(parentEntry.timestamp,parent.state.s.timestamp);
  const firstSlot=Math.max(1,Math.ceil((h.chain.protocolTime-parentTs)/CONSENSUS_PARAMS.block.targetBlockSeconds));
  for(let slot=firstSlot;slot<=firstSlot+4;slot+=1){
    for(let a=1;a<=4;a+=1){
      const canonicalTs=parentTs+CONSENSUS_PARAMS.block.targetBlockSeconds*slot+a;
      if(canonicalTs<h.chain.protocolTime) continue;
      for(let b=1;b<=4;b+=1){
        if(b===a) continue;
        const siblingTs=parentTs+CONSENSUS_PARAMS.block.targetBlockSeconds*slot+b;
        const canonical=h.makeBlockOn(parent,[],{timestamp:canonicalTs});
        const sibling=h.makeBlockOn(parent,[],{timestamp:siblingTs});
        if(proposerRound(parentTs,canonicalTs)!==proposerRound(parentTs,siblingTs)) continue;
        if(blockHash(sibling.block.header)>blockHash(canonical.block.header)) return {canonical,alternate:sibling};
      }
    }
  }
  throw new Error('could not construct two same-round blocks that hash in the order fork choice needs');
}

async function finalityHarness(): Promise<{h:Harness;validator:TestWallet}> {
  const validator=makeWallet();
  const h=await createHarness({producer:validator,bootstrapValidatorPublicKeys:[validator.publicKey]}); open.push(h);
  h.produce();
  h.produce([signedClaim(h,validator)]);
  const bond=CONSENSUS_PARAMS.consensus.validatorBond;
  h.produce([h.sign(validator,TxType.VALIDATOR,validatorBody(ValidatorOp.REGISTER,bond,validator.publicKey),{gas:expectedGas(bond)})]);
  return {h,validator};
}

function identity(wallet:TestWallet) { return {address:wallet.address,publicKey:wallet.publicKey,privateKey:wallet.privateKey}; }

/** Reach the first bootstrap-eligible target, while retaining a valid competing proposal. */
function bootstrapCandidates(h:Harness) {
  mine(h,CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks);
  const parent=forkParent(h,h.chain.height);
  const {canonical:canonicalBlock,alternate}=equivocatingSiblings(h,parent);
  const canonical=h.chain.addBlock(canonicalBlock.block);
  expect(canonical.accepted).toBe(true);
  const admitted=h.chain.addBlock(alternate.block);
  expect(admitted.accepted).toBe(true);
  expect(h.chain.canonicalHashAt(canonicalBlock.block.header.height)).toBe(blockHash(canonicalBlock.block.header));
  return {canonical:canonicalBlock.block,alternate,parent};
}

describe('PoT checkpoint finality',()=>{
  it('bootstraps only after a stable authoritative validator set and advances sequentially',async()=>{
    const {h,validator}=await finalityHarness();
    expect(h.chain.createFinalityVote(identity(validator))).toBeNull();
    mine(h,CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks-1);
    expect(h.chain.createFinalityVote(identity(validator))).toBeNull();
    const target=h.produce();
    const vote=h.chain.createFinalityVote(identity(validator));
    expect(vote?.blockHash).toBe(blockHash(target.header));
    const accepted=h.chain.addFinalityVote(vote!);
    expect(accepted).toMatchObject({accepted:true,finalized:true,code:ErrCode.OK});
    expect(h.chain.finalityStatus()).toMatchObject({finalizedHeight:target.header.height,finalizedHash:blockHash(target.header),quorum:1,validatorCount:1,bootstrap:false});

    const next=h.produce();
    const nextVote=h.chain.createFinalityVote(identity(validator));
    expect(nextVote?.height).toBe(next.header.height);
    expect(h.chain.addFinalityVote(nextVote!).finalized).toBe(true);
    expect(h.chain.finalityStatus().finalizedHeight).toBe(next.header.height);

    const transition=h.produce([h.sign(validator,TxType.VALIDATOR,validatorBody(ValidatorOp.UNREGISTER,0n,validator.publicKey),{gas:0n})]);
    const transitionVote=h.chain.createFinalityVote(identity(validator));
    expect(transitionVote?.height).toBe(transition.header.height);
    expect(h.chain.addFinalityVote(transitionVote!).finalized).toBe(true);
    h.produce();
    expect(h.chain.createFinalityVote(identity(validator))).toBeNull();
    expect(h.chain.finalityStatus()).toMatchObject({validatorCount:0,quorum:0});
  });

  it('never reorganizes finalized history and detects signed proposer and vote equivocation',async()=>{
    const {h,validator}=await finalityHarness();
    const {canonical,alternate}=bootstrapCandidates(h);
    expect(h.chain.equivocationEvidence().some(e=>e.type==='PROPOSER_EQUIVOCATION')).toBe(true);

    const honest=h.chain.createFinalityVote(identity(validator),blockHash(canonical.header))!;
    expect(h.chain.addFinalityVote(honest).finalized).toBe(true);
    const {signature: _honestSignature,...honestUnsigned}=honest;
    const unsigned:Omit<FinalityVote,'signature'>={...honestUnsigned,blockHash:blockHash(alternate.block.header),round:blockRound(h,alternate.block)};
    const conflicting=signFinalityVote(unsigned,validator.privateKey);
    const equivocation=h.chain.addFinalityVote(conflicting);
    expect(equivocation.accepted).toBe(true);
    expect(equivocation.evidence?.type).toBe('VOTE_EQUIVOCATION');

    const child=h.makeBlockOn({hash:blockHash(alternate.block.header),height:alternate.block.header.height,cumulativePotWeight:alternate.block.header.cumulativePotWeight,state:alternate.state},[],{timestamp:alternate.block.header.timestamp+1});
    const rejected=h.chain.addBlock(child.block);
    expect(rejected).toMatchObject({accepted:false,code:ErrCode.FINALITY_CONFLICT});
    expect(h.chain.canonicalHashAt(canonical.header.height)).toBe(blockHash(canonical.header));
  });

  it('adopts a valid certified branch after a partition deeper than the ordinary reorg bound',async()=>{
    const {h,validator}=await finalityHarness();
    mine(h,CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks-1);
    const bootstrap=h.produce(), bootstrapVote=h.chain.createFinalityVote(identity(validator))!;
    expect(h.chain.addFinalityVote(bootstrapVote).finalized).toBe(true);
    const parent=forkParent(h,bootstrap.header.height);
    const {canonical:canonicalBuilt,alternate}=equivocatingSiblings(h,parent);
    const canonical=canonicalBuilt.block;
    expect(h.chain.addBlock(canonical).accepted).toBe(true);
    expect(h.chain.addBlock(alternate.block).accepted).toBe(true);
    expect(h.chain.canonicalHashAt(canonical.header.height)).toBe(blockHash(canonical.header));
    const template=h.chain.createFinalityVote(identity(validator),blockHash(canonical.header))!;
    const {signature: _templateSignature,...templateUnsigned}=template;
    const alternateVote=signFinalityVote({...templateUnsigned,blockHash:blockHash(alternate.block.header),round:blockRound(h,alternate.block)},validator.privateKey);
    const certificate:FinalityCertificate={version:1,finalizedHeight:alternateVote.finalizedHeight,finalizedHash:alternateVote.finalizedHash,height:alternateVote.height,blockHash:alternateVote.blockHash,parentHash:alternateVote.parentHash,validatorSetHash:alternateVote.validatorSetHash,quorum:1,validatorCount:1,votes:[alternateVote]};
    mine(h,CONSENSUS_PARAMS.consensus.maxReorgDepth+1);
    expect(h.chain.height-bootstrap.header.height).toBeGreaterThan(CONSENSUS_PARAMS.consensus.maxReorgDepth);
    expect(h.chain.addFinalityCertificate(certificate)).toMatchObject({accepted:true,finalized:true});
    expect(h.chain.finalityStatus()).toMatchObject({finalizedHeight:alternate.block.header.height,finalizedHash:blockHash(alternate.block.header)});
    expect(h.chain.tip?.hash).toBe(blockHash(alternate.block.header));
    expect(h.chain.world.s.genesis).toMatchObject({allocationClaimed:true,recipient:validator.address,treasuryWallet:validator.address});
  });

  it('recovers a checksummed finality lock and refuses corrupted safety state',async()=>{
    const {h,validator}=await finalityHarness();
    const {canonical}=bootstrapCandidates(h);
    expect(h.chain.addFinalityVote(h.chain.createFinalityVote(identity(validator),blockHash(canonical.header))!).finalized).toBe(true);
    const restored=new ChainManager({dataDir:h.dir,net:h.net,genesisDocument:h.chain.genesisDocument,enforceProposerRotation:true});
    await restored.init();
    expect(restored.finalityStatus()).toMatchObject({finalizedHeight:canonical.header.height,finalizedHash:blockHash(canonical.header)});
    expect(restored.verifyIntegrity().ok).toBe(true);

    const path=join(h.dir,'finality','state.json');
    const envelope=JSON.parse(readFileSync(path,'utf8')) as {state:{finalizedHash:string}};
    envelope.state.finalizedHash='0'.repeat(64);
    writeFileSync(path,`${JSON.stringify(envelope)}\n`);
    const corrupt=new ChainManager({dataDir:h.dir,net:h.net,genesisDocument:h.chain.genesisDocument,enforceProposerRotation:true});
    await expect(corrupt.init()).rejects.toThrow(/checksum mismatch/);
  });

  it('fails closed when the finality journal is missing for a non-genesis chain', async () => {
    const { h, validator } = await finalityHarness();
    const { canonical } = bootstrapCandidates(h);
    expect(h.chain.addFinalityVote(h.chain.createFinalityVote(identity(validator), blockHash(canonical.header))!).finalized).toBe(true);
    rmSync(join(h.dir, 'finality', 'state.json'));

    const restored = new ChainManager({ dataDir: h.dir, net: h.net, genesisDocument: h.chain.genesisDocument, enforceProposerRotation: true });
    await expect(restored.init()).rejects.toThrow(/finality state is missing.*non-genesis chain/i);
  });

  it('fails closed when the locally finalized block is missing on restart',async()=>{
    const {h,validator}=await finalityHarness(); const {canonical}=bootstrapCandidates(h);
    expect(h.chain.addFinalityVote(h.chain.createFinalityVote(identity(validator),blockHash(canonical.header))!).finalized).toBe(true);
    const entry=h.chain.store.getIndexEntry(blockHash(canonical.header))!;
    rmSync(join(h.dir,'chain','blocks',entry.file));
    await expect(async()=>{
      const restored=new ChainManager({dataDir:h.dir,net:h.net,genesisDocument:h.chain.genesisDocument,enforceProposerRotation:true});
      await restored.init();
    }).rejects.toThrow(/missing|finality|block/i);
  });

  it('requires exactly three of four equal validator memberships under reordered and replayed delivery',async()=>{
    const validators=[makeWallet(),makeWallet(),makeWallet(),makeWallet()];
    const h=await createHarness({producer:validators[0],bootstrapValidatorPublicKeys:validators.map(wallet=>wallet.publicKey)}); open.push(h);
    h.produce(); h.produce([signedClaim(h,validators[0]!)]);
    const bond=CONSENSUS_PARAMS.consensus.validatorBond, funding=bond+expectedGas(bond);
    const payerNonce=h.chain.world.getAccount(validators[0]!.address)!.nonce;
    h.produce(validators.slice(1).map((wallet,index)=>signedPayment(h,validators[0]!,wallet.address,funding,{nonce:payerNonce+index})));
    const registrations=validators.map((wallet,index)=>h.sign(wallet,TxType.VALIDATOR,validatorBody(ValidatorOp.REGISTER,bond,wallet.publicKey),{gas:expectedGas(bond),nonce:index===0?payerNonce+3:0}));
    h.produce(registrations);
    const byAddress=new Map(validators.map(wallet=>[wallet.address,wallet]));
    for(let i=0;i<CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks;i+=1){
      vi.advanceTimersByTime(1_000); const scheduled=h.chain.scheduledProposerNow(); expect(scheduled).not.toBeNull(); h.produce([],{producer:byAddress.get(scheduled!)!});
    }
    const votes=validators.map(wallet=>h.chain.createFinalityVote(identity(wallet))!);
    expect(h.chain.finalityStatus()).toMatchObject({validatorCount:4,quorum:3,finalizedHeight:0});
    expect(h.chain.addFinalityVote(votes[2]!).finalized).not.toBe(true);
    expect(h.chain.addFinalityVote(votes[2]!)).toMatchObject({accepted:false,duplicate:true,code:ErrCode.REPLAY});
    expect(h.chain.addFinalityVote(votes[0]!).finalized).not.toBe(true);
    expect(h.chain.finalityStatus().finalizedHeight).toBe(0);
    expect(h.chain.addFinalityVote(votes[3]!)).toMatchObject({accepted:true,finalized:true});
    expect(h.chain.finalityStatus().finalizedHeight).toBe(votes[0]!.height);
    expect(h.chain.addFinalityVote(votes[1]!)).toMatchObject({accepted:false});
  });


  it('fails closed for an empty bootstrap set and excludes uncommitted validators',async()=>{
    const committed=makeWallet(), additional=makeWallet();
    const empty=await createHarness({producer:committed}); open.push(empty);
    empty.produce(); empty.produce([signedClaim(empty,committed)]);
    const bond=CONSENSUS_PARAMS.consensus.validatorBond;
    empty.produce([empty.sign(committed,TxType.VALIDATOR,validatorBody(ValidatorOp.REGISTER,bond,committed.publicKey),{gas:expectedGas(bond)})]);
    mine(empty,CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks+1);
    expect(empty.chain.finalityStatus()).toMatchObject({bootstrap:true,bootstrapConfigured:false,validatorCount:0,quorum:0});
    expect(empty.chain.createFinalityVote(identity(committed))).toBeNull();

    const h=await createHarness({producer:committed,bootstrapValidatorPublicKeys:[committed.publicKey]}); open.push(h);
    h.produce(); h.produce([signedClaim(h,committed)]);
    const gift=parseObs('25000');
    h.produce([signedPayment(h,committed,additional.address,gift)]);
    h.produce([
      h.sign(committed,TxType.VALIDATOR,validatorBody(ValidatorOp.REGISTER,bond,committed.publicKey),{gas:expectedGas(bond)}),
      h.sign(additional,TxType.VALIDATOR,validatorBody(ValidatorOp.REGISTER,bond,additional.publicKey),{gas:expectedGas(bond)}),
    ]);
    mineBySchedule(h,CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks,[committed,additional]);
    produceBySchedule(h,[committed,additional]);
    const vote=h.chain.createFinalityVote(identity(committed));
    expect(vote).not.toBeNull();
    expect(h.chain.finalityStatus()).toMatchObject({bootstrapConfigured:true,validatorCount:1,quorum:1});
    expect(h.chain.createFinalityVote(identity(additional))).toBeNull();
    expect(h.chain.genesisDocument.bootstrapValidatorPublicKeys).toEqual([committed.publicKey]);
  });

  it('rejects signed vote objects with uncommitted fields',async()=>{
    const {h,validator}=await finalityHarness();
    const {canonical}=bootstrapCandidates(h);
    const vote=h.chain.createFinalityVote(identity(validator),blockHash(canonical.header))!;
    expect(h.chain.addFinalityVote({...vote,validatorSupport:99} as FinalityVote)).toMatchObject({accepted:false,code:ErrCode.BAD_SIGNATURE});
    expect(h.chain.finalityStatus().finalizedHeight).toBe(0);
  });

  it('rejects unknown validators, invalid signatures, replay, and malformed accusations without mutating finality',async()=>{
    const {h,validator}=await finalityHarness();
    const {canonical}=bootstrapCandidates(h);
    const vote=h.chain.createFinalityVote(identity(validator),blockHash(canonical.header))!;
    const outsider=makeWallet();
    const {signature: _voteSignature,...voteUnsigned}=vote;
    const ineligible=signFinalityVote({...voteUnsigned,validator:outsider.address,publicKey:outsider.publicKey},outsider.privateKey);
    expect(h.chain.addFinalityVote(ineligible)).toMatchObject({accepted:false,code:ErrCode.BAD_SIGNATURE});
    const forged={...vote,signature:'0'.repeat(128)};
    expect(h.chain.addFinalityVote(forged)).toMatchObject({accepted:false,code:ErrCode.BAD_SIGNATURE});
    expect(h.chain.addFinalityVote(vote).finalized).toBe(true);
    expect(h.chain.addFinalityVote(vote)).toMatchObject({accepted:false,duplicate:true,code:ErrCode.REPLAY});
    const malformed={version:1,id:'0'.repeat(64),type:'VOTE_EQUIVOCATION',validator:validator.address,height:vote.height,round:vote.round,messageType:'POT_FINALITY',firstId:'0'.repeat(64),secondId:'1'.repeat(64),firstVote:null,secondVote:null};
    expect(h.chain.addEquivocationEvidence(malformed as never)).toMatchObject({accepted:false});
  });
});
