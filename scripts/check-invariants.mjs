#!/usr/bin/env node
/**
 * Economic and protocol invariants that must never drift.
 *
 * These are the numbers the Obsidian Network promised. A refactor is free to
 * move them between files, rename the surrounding types or restructure the
 * params object — but if any of these values changes, the network is no longer
 * the thing that was specified, and that has to be a deliberate, visible act
 * rather than a side effect of a patch.
 *
 * Run from anywhere:   node scripts/check-invariants.mjs
 * Requires obsidian-core to have been built (`npm --prefix obsidian-core run build`).
 *
 * Exit code 0 = every invariant holds. Non-zero = something changed.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// This script runs from three different layouts: the repository (scripts/ next
// to obsidian-core/), the node operator release package (this file at the root,
// obsidian-core/ beside it), and whatever directory an operator happens to be
// standing in. Look in all of them rather than assuming one.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(here, '..', 'obsidian-core', 'dist', 'protocol', 'params.js'), // repository
  join(here, 'obsidian-core', 'dist', 'protocol', 'params.js'),       // release package
  join(here, '..', 'dist', 'protocol', 'params.js'),                  // inside obsidian-core
  join(process.cwd(), 'obsidian-core', 'dist', 'protocol', 'params.js'),
  join(process.cwd(), 'dist', 'protocol', 'params.js'),
];

const built = candidates.find((path) => existsSync(path));

if (!built) {
  console.error('could not find a built obsidian-core. Looked in:');
  for (const path of candidates) console.error(`  ${path}`);
  console.error('\nbuild it first:  npm --prefix obsidian-core run build');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const { CONSENSUS_PARAMS: P } = require(built);

const OBS = 10n ** 18n;

/** @type {{ name: string, expected: unknown, actual: unknown }[]} */
const checks = [];
const check = (name, expected, actual) => checks.push({ name, expected, actual: actual ?? null });

// ── supply ───────────────────────────────────────────────────────────────────
check('hard maximum supply is 21,000,000 OBS', (21_000_000n * OBS).toString(), String(P.maxSupply));
check('genesis allocation is 100,000 OBS', (100_000n * OBS).toString(), String(P.genesisAllocation));
check('the legacy 3,000,000 OBS allocation is gone', '0', String(P.legacyGenesisAllocationRemoved));
check('a new account is credited nothing at registration', '0', String(P.registry.newAccountBalance));

// ── mining ───────────────────────────────────────────────────────────────────
check('a claim is possible every 4 hours', 14_400, P.mining.claimIntervalSeconds);
check('at most 6 claims per 24 hours', 6, P.mining.maxClaimsPerCycle);
check('the cycle is 24 hours', 86_400, P.mining.cycleSeconds);
check('initial rate is 0.001 OBS per day', '1000000000000000', String(P.mining.initialDailyReward));
check('initial claim is 0.000166666666666666 OBS', '166666666666666', String(P.mining.initialClaimReward));
check('an active miner claimed within 30 days', 2_592_000, P.mining.activeMinerWindowSeconds);
check('the rate drops 0.5% per step', 50, P.mining.reductionBasisPointsPerStep);
check('a step is 100,000 active miners', 100_000, P.mining.reductionStepMiners);
check('the daily floor is 0.0002 OBS', '200000000000000', String(P.mining.dailyRewardFloor));
check('one claim per wallet per block', 1, P.mining.maxClaimsPerBlockPerWallet);

// ── gas ──────────────────────────────────────────────────────────────────────
check('gas is 0.02% of the transfer', 2, P.gas.basisPoints);
check('gas is capped at 0.01 OBS', '10000000000000000', String(P.gas.maxGas));
check('gas returns to the mining pool', 'MINING_POOL', P.gas.destination);

// ── consensus: Proof of Time ─────────────────────────────────────────────────
check('consensus is Proof of Time', 'PROOF_OF_TIME', P.proofOfTime.consensus);
check('PoT fork choice', 'POT_WEIGHT_THEN_TIME_THEN_LOWEST_HEADER_HASH', P.proofOfTime.weightRule);
check('fork choice agrees across params', 'POT_WEIGHT_THEN_TIME_THEN_LOWEST_HEADER_HASH', P.consensus.forkChoice);
check('the block target is 5 seconds', 5, P.proofOfTime.difficultyTargetSeconds);
check('the future-drift bound is 60 seconds', 60, P.block.maxFutureDriftSeconds);
check('median time past uses 11 blocks', 11, P.block.medianTimePastWindow);
check('reorgs deeper than 256 blocks are refused', 256, P.consensus.maxReorgDepth);

// ── node runner revenue split ────────────────────────────────────────────────
check('node runners receive 40% of platform revenue', 4000, P.nodeRewards.nodePoolShareBps);
check('the treasury receives 60% of platform revenue', 6000, P.nodeRewards.treasuryShareBps);
check('the split totals 100%', 10_000, P.nodeRewards.nodePoolShareBps + P.nodeRewards.treasuryShareBps);
check('no node may take more than 5% of a period', 500, P.nodeRewards.maxNodeShareBps);
check('the registration bond is 100 OBS', (100n * OBS).toString(), String(P.nodeRewards.registrationBond));
check('a reward period is 24 hours', 86_400, P.nodeRewards.periodSeconds);
check('scoring weights total 100%',
  10_000,
  P.nodeRewards.scoreWeights.uptimeBps + P.nodeRewards.scoreWeights.participationBps +
  P.nodeRewards.scoreWeights.reliabilityBps + P.nodeRewards.scoreWeights.responsivenessBps);
check('participation weights total 100%',
  10_000,
  P.nodeRewards.participationWeights.blocksBps + P.nodeRewards.participationWeights.coverageBps);

// ── applications ─────────────────────────────────────────────────────────────
check('a capsule locks at least 0.0001 OBS', '100000000000000', String(P.capsules.minCommitment));
check('time travel costs 1000x the commitment', '1000', String(P.capsules.timeTravelMultiplier));
check('a time travel preview lasts 30 seconds', 30, P.capsules.previewSeconds);
check('one preview per capsule per account', 1, P.capsules.maxPreviewsPerAccount);
check('creators keep 70% of monetisation', 7000, P.social.creatorShareBps);
check('the network takes 30% of monetisation', 3000, P.social.networkShareBps);
check('creator and network shares total 100%', 10_000, P.social.creatorShareBps + P.social.networkShareBps);
check('a business page costs 0.005 OBS', '5000000000000000', String(P.social.businessPagePrice));
check('an ONS name costs 0.05 OBS', '50000000000000000', String(P.ons.registrationFee));
check('an ONS renewal costs 0.05 OBS', '50000000000000000', String(P.ons.renewalFee));
check('a validator bond is 50 OBS', '50000000000000000000', String(P.consensus.minValidatorBond));
// Protocol services are denominated in OBS: no oracle price participates in
// pricing any more, so none of these can be blocked by a missing feed.
check('no USD-denominated service prices remain', 'true',
  String(P.ons.registrationFeeUsd === undefined && P.social.businessPagePriceUsd === undefined));
check('an account may issue at most 5 invites', 5, P.registry.maxInvitesPerAccount);
check('land starts no lower than $100', '100000000', String(P.circle.minGlvUsd));
check('land starts no higher than $30,000', '30000000000', String(P.circle.maxGlvUsd));
check('a protocol land sale issues one parcel', 1, P.circle.maxParcelsPerProtocolTx);
check('a parcel is at most one square metre', 1, P.circle.parcelSquareMetres);

// ── things that were removed and must stay removed ───────────────────────────
check('WAC is disabled', false, P.registry.wacEnabled);
check('WAC has no price', '0', String(P.registry.wacPriceUsd));
check('mining requires no KYC', false, P.registry.miningKycRequired);
check('withdrawal does not require WAC', false, P.registry.miningWithdrawalRequiresWac);
check('there is no native exchange', false, P.registry.nativeExchangeEnabled);

// ── report ───────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => String(c.expected) !== String(c.actual));

for (const c of checks) {
  const ok = String(c.expected) === String(c.actual);
  if (!ok) console.error(`  FAIL  ${c.name}\n        expected ${c.expected}, found ${c.actual}`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} of ${checks.length} protocol invariants have drifted.`);
  process.exit(1);
}

console.log(`protocol ${P.protocolVersion}: all ${checks.length} invariants hold.`);
