/**
 * Consensus parameters — the Obsidian Protocol Specification in constant form.
 *
 * RULE (spec §75): consensus-critical configuration must be deterministic
 * across nodes. Therefore every value in this file is a compile-time constant
 * of the protocol version, NOT an operator setting. Operators configure only
 * application-level items (ports, data directory, log level, RPC bind address).
 *
 * Changing any value below requires a protocol version bump and a documented
 * consensus upgrade — it is a hard fork.
 *
 * Values are documented in /docs/consensus.md and /docs/economics.md.
 */

import { parseObs, MAX_SUPPLY_SEALS } from './amount.js';

export const CONSENSUS_PARAMS = {
  /** Protocol version that owns these parameters. */
  protocolVersion: '1.0.0',

  // ── Supply ────────────────────────────────────────────────────────────────
  /** Hard cap. Issuance of ANY kind is rejected if it would exceed this. */
  maxSupply: MAX_SUPPLY_SEALS,
  /** One-time genesis allocation reserved for the first protocol-valid miner. */
  genesisAllocation: parseObs('100000'),
  /**
   * The legacy 3,000,000 OBS genesis allocation is REMOVED and MUST NOT exist.
   * This constant exists purely so the automated compliance checklist can
   * assert its value is zero. Nothing may ever read it for issuance.
   */
  legacyGenesisAllocationRemoved: 0n,

  // ── Mining ────────────────────────────────────────────────────────────────
  mining: {
    /** Minimum seconds between two accepted claims by the same wallet. */
    claimIntervalSeconds: 4 * 60 * 60,
    /** Maximum accepted claims per wallet per rolling 24-hour cycle. */
    maxClaimsPerCycle: 6,
    /** Length of the claim cycle in seconds. */
    cycleSeconds: 24 * 60 * 60,
    /** Genesis-era total daily reward across the whole network. */
    initialDailyReward: parseObs('0.001'),
    /** Per-claim reward while the network is at genesis participation. */
    initialClaimReward: parseObs('0.000166666666666666'),
    /** Owner of a claim must have been registered at least this recent... */
    activeMinerWindowSeconds: 30 * 24 * 60 * 60,
    /**
     * Reward reduction: 0.5% per 100,000 active miners.
     * Implemented with exact integer arithmetic (see mining/schedule.ts).
     */
    reductionBasisPointsPerStep: 50, // 0.50%
    reductionStepMiners: 100_000,
    /** Absolute floor: 0.0002 OBS per 24 hours. Never crossed. */
    dailyRewardFloor: parseObs('0.0002'),
    /**
     * Grace applied to a wallet's very first claim so a miner is never forced
     * to wait for a full interval after registering the wallet on-chain.
     */
    firstClaimGraceSeconds: 0,
    /** Maximum claims accepted from one wallet inside a single block. */
    maxClaimsPerBlockPerWallet: 1,
  },

  // ── Gas ───────────────────────────────────────────────────────────────────
  gas: {
    /** 0.02% of the transferred amount, in basis points. */
    basisPoints: 2,
    /** Absolute ceiling on gas per transaction: 0.01 OBS. */
    maxGas: parseObs('0.01'),
    /** Minimum gas charged on any value-bearing transaction (anti-spam dust). */
    minGas: 0n,
    /**
     * Gas destination. Protocol rule: gas is remitted to the Mining Pool.
     * The Mining Pool is protocol state, not a wallet; see treasury/pool.ts.
     */
    destination: 'MINING_POOL' as const,
  },

  // ── Blocks ────────────────────────────────────────────────────────────────
  block: {
    /** Target spacing between blocks, seconds. */
    targetBlockSeconds: 5,
    /** Maximum serialized block size in bytes. */
    maxBlockBytes: 2 * 1024 * 1024,
    /** Maximum number of transactions in one block including the reward claim batch. */
    maxBlockTransactions: 2_000,
    /** Allowed future drift for a block timestamp relative to local node time. */
    maxFutureDriftSeconds: 60,
    /** Minimum number of parents considered when computing median time past. */
    medianTimePastWindow: 11,
    /** Blocks after which a transaction is considered buried (soft finality hint). */
    confirmationDepthSoft: 12,
    /** Depth at which an interface may show "final" (irreversible for practical use). */
    confirmationDepthHard: 64,
    /** Emission decade length used by the halving-style issuance cap. */
    issuanceDecadeSeconds: 10 * 365.25 * 24 * 60 * 60,
  },

  // ── Validators / consensus ────────────────────────────────────────────────
  consensus: {
    /** Slots per producer rotation (proposer = validators[height % validatorCount]). */
    validatorSlotsPerRotation: 1,
    /** A validator must be bonded with at least this much OBS. */
    minValidatorBond: parseObs('1000'),
    /** Unbonding delay in blocks before bond funds return. */
    unbondingBlocks: 20_160, // ~28 hours at 5s blocks
    /** Missed slots tolerated in a 100-block window before jailing. */
    maxMissedSlotsPerWindow: 40,
    /** Jailing period in blocks. */
    jailBlocks: 10_080,
    /**
     * Fork-choice weight: accumulated work then chain length then lowest hash.
     * See consensus/fork-choice.ts for the exact deterministic tie-break.
     */
    forkChoice: 'MOST_ACCUMULATED_WORK_THEN_LENGTH_THEN_LOWEST_HEADER_HASH' as const,
    /** Maximum reorg depth accepted by the node's chain reorganiser. */
    maxReorgDepth: 256,
  },

  // ── Accounts / transactions ───────────────────────────────────────────────
  tx: {
    /** Replay window: a transaction is invalid if included after this many blocks. */
    expiryBlocks: 240,
    /** Maximum memo length in bytes. */
    maxMemoBytes: 256,
    /** Maximum signed transaction size in bytes. */
    maxTxBytes: 16 * 1024,
    /** Maximum number of out-messages a transaction executor may enqueue. */
    maxEventsPerTx: 64,
    /** Minimum transfer amount enforced by the protocol (anti-dust). */
    minTransfer: 1n, // one seal = 1e-18 OBS
  },

  // ── ONS (Obsidian Name Service) ───────────────────────────────────────────
  ons: {
    minLength: 3,
    maxLength: 63,
    /** Registration fee in USD micro-units, paid in OBS at oracle price. */
    registrationFeeUsd: 5_000_000n, // $5.00
    renewalFeeUsd: 5_000_000n, // $5.00
    /** Registration grants ownership for this many seconds (1 year). */
    termSeconds: 365 * 24 * 60 * 60,
    /** Grace period after expiry before the name returns to the pool. */
    graceSeconds: 30 * 24 * 60 * 60,
    /** Protocol-reserved names that can never be registered by users. */
    reserved: [
      'obs',
      'www',
      'admin',
      'root',
      'treasury',
      'foundation',
      'blackseal',
      'core',
      'node',
      'genesis',
      'support',
      'api',
      'wallet',
      'explorer',
      'social',
      'capsule',
      'circle',
      'developer',
    ] as const,
  },

  // ── Time Capsule ──────────────────────────────────────────────────────────
  capsules: {
    /** Minimum OBS commitment. */
    minCommitment: parseObs('0.0001'),
    /** Time Travel preview price multiplier (price = 1000 * commitment). */
    timeTravelMultiplier: 1000n,
    /** Preview window, in seconds. */
    previewSeconds: 30,
    /** Minimum lock duration from creation, in seconds (1 hour). */
    minLockSeconds: 60 * 60,
    /** Maximum lock duration (100 years) — a sanity bound, not a limit on ambition. */
    maxLockSeconds: 100 * 365.25 * 24 * 60 * 60,
    /** Maximum encrypted payload size per capsule, in bytes. */
    maxContentBytes: 256 * 1024,
    /** One Time Travel preview per capsule per account. */
    maxPreviewsPerAccount: 1,
  },

  // ── Obsidian Circle (land) ────────────────────────────────────────────────
  circle: {
    /**
     * Every parcel is 1 square metre at the level of the protocol market:
     * "one plot or one square metre, or less, per protocol transaction".
     */
    parcelSquareMetres: 1,
    /** Protocol purchase and buyback are executed one parcel per transaction. */
    maxParcelsPerProtocolTx: 1,
    /**
     * GLV (Global Location Value) multiplier applied to the location's base
     * value for each protocol purchase: GLV_next = GLV * (1 + step).
     * The buyer of a purchase never retroactively benefits — see docs.
     */
    protocolPurchaseMultiplierBps: 10_000, // rebuilt dynamically; see land/pricing.ts
    /** Step applied to GLV after each protocol purchase, in basis points (0.25%). */
    appreciationStepBps: 25,
    /** Step applied to GLV after each protocol buyback, in basis points (0.25%). */
    depreciationStepBps: 25,
    /** GLV bounds in USD micro-units. */
    minGlvUsd: 100_000_000n, // $100
    maxGlvUsd: 30_000_000_000n, // $30,000
    /** A buyback is only permitted when the protocol land reserve can fund it. */
    requireReserveForBuyback: true,
  },

  // ── Social ────────────────────────────────────────────────────────────────
  social: {
    /** Post body limit, bytes. */
    maxPostBytes: 8 * 1024,
    maxCommentBytes: 2 * 1024,
    maxUsernameLength: 24,
    /** Creator monetisation eligibility thresholds. */
    monetisationMinFollowers: 10_000,
    monetisationMinMonthlyViews: 100_000,
    /** Revenue split in basis points: 70% creator, 30% Obsidian Network. */
    creatorShareBps: 7_000,
    networkShareBps: 3_000,
    /** Business page activation price in USD micro-units ($50). */
    businessPagePriceUsd: 50_000_000n,
    /** Tip minimum (one seal). */
    minTip: 1n,
    /** Feed page size ceiling enforced by the node. */
    maxPageSize: 100,
  },

  // ── Oracle ────────────────────────────────────────────────────────────────
  oracle: {
    /** Price is invalid if older than this many seconds. */
    maxAgeSeconds: 6 * 60 * 60,
    /** Quorum: observations required to form a median price. */
    minSources: 2,
    /** Sanity bound: reject any single observation this far from local median. */
    maxDeviationBps: 2_500, // 25%
    /** Absolute bounds on OBS/USD price in micro-USD. */
    minPriceUsdMicro: 1n, // $0.000001
    maxPriceUsdMicro: 1_000_000_000_000n, // $1,000,000
    /** Maximum observation age accepted from a single source, seconds. */
    maxSourceAgeSeconds: 36 * 60 * 60,
  },

  // ── Registry / application bridge ────────────────────────────────────────
  registry: {
    /**
     * Invite-only registration is an APPLICATION policy, never consensus.
     * Each application account may invite at most this many new accounts.
     */
    maxInvitesPerAccount: 5,
    /** New accounts always begin at exactly this balance. */
    newAccountBalance: 0n,
    /**
     * WAC is removed. These constants exist so the compliance checklist can
     * assert the removal programmatically.
     */
    wacPriceUsd: 0n,
    wacEnabled: false,
    miningKycRequired: false,
    miningWithdrawalRequiresWac: false,
    nativeExchangeEnabled: false,
  },
} as const;

/** Convenience: reward floor per claim derived from the daily floor. */
export const MIN_CLAIM_REWARD = CONSENSUS_PARAMS.mining.dailyRewardFloor;
