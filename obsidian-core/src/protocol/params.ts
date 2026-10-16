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
  /**
   * Protocol version that owns these parameters.
   *
   * 2.0.1 closes two gaps in the 2.0.0 rules, both consensus changes: a name inside its grace period can no longer be
   * registered by someone else, and a payment, pointer or grant recipient must be a canonical (lowercase) address, so
   * an all-uppercase bech32 string (which QR codes carry) can no longer credit an account nobody can sign for. A 2.0.0
   * node would accept both and fork, so this is a new protocol identity and a new genesis id.
   *
   * 2.0.0 adds the ONS Marketplace (fixed-price listings, purchases, owner-directed offers with consensus escrow) on top
   * of the 1.9.0 rules below and changes the state root, so it is a new protocol identity and a new genesis id; a 1.9.x
   * node cannot peer with a 2.0.0 node.
   *
   * 1.9.0 was a FRESH-START protocol (new genesis, no migration of earlier chain state). Block production is a
   * deterministic schedule over every registered, mature, live node, with no stake, bond, committee or vote; finality
   * is a pure function of chain history (producer-diversity checkpoints); a node's reward wallet is bound with the
   * node's own identity key (no wallet signature, no gas); node rewards are 90% of the ONS-fee pool by uptime score;
   * ONS names gain two-step transfer, wallet update and delayed recovery. The mining gate (1.7.0/1.8.0: certificates
   * from genesis-committed issuer keys, rotatable on chain) is unchanged. Every earlier release has a different rule
   * set and a different protocol identity: a 1.8.x node cannot peer with a 1.9.0 node. The history of the earlier
   * rules is in the git log and CHANGELOG, not here.
   */
  protocolVersion: '2.0.1',

  /**
   * MINING GATE (1.7.0). A MINING_CLAIM is valid only with a certificate from an issuer key committed in genesis
   * (`GenesisState.miningGateKeys`). The issuer is the account platform: it signs a certificate for one wallet and one
   * claim only after the account behind that wallet is signed in, second-factor confirmed and linked to it. Without
   * this, anyone could skip the account system by submitting a claim straight to a node.
   *
   * The chain decides nothing about WHO an account is, and the issuer decides nothing about WHEN a wallet may claim:
   * eligibility stays a pure function of the wallet's own claim history and the block time.
   */
  miningGate: {
    /** A certificate is valid for this long after `issuedAt`, so a leaked one expires and a revoked account stops. */
    certificateTtlSeconds: 15 * 60,
    /** How far ahead of the including block's time an issuer's clock may be. */
    clockSkewSeconds: 60,
    /** Most issuer keys a genesis may commit, and the most that may be active at once after updates. */
    maxIssuers: 8,
    /**
     * Gate authority (protocol 1.8.0). An update needs approvals from a strict majority of the CURRENT issuer
     * keys (floor(n/2)+1), changes at most `maxChangesPerUpdate` keys in each direction, and may never leave the
     * set empty. Revoked keys are remembered so a compromised key cannot be put back; the list is bounded.
     */
    maxRevoked: 64,
    maxChangesPerUpdate: 8,
  },

  // ── Proof of Time (PoT) ───────────────────────────────────────────────────
  /**
   * PROOF OF TIME — the consensus identity of Obsidian Network.
   *
   * Obsidian does not hold a hash-puzzle race. A block is produced by the
   * registered node whose slot it is, and acceptance depends on TIME, not on how much
   * computation anyone spent:
   *
   *   - the proposer for a height is scheduled deterministically from the
   *     producer set (`proposer = schedulable[(height + round) mod n]`,
   *     where the round counts slots elapsed since the parent), so nobody
   *     competes by spending work, and an absent producer costs one slot
   *     rather than halting the chain;
   *   - a block's timestamp must exceed the median time past of its ancestors
   *     and may not run ahead of the network's time (see `block` below), so a
   *     node cannot manufacture time;
   *   - `PoT Difficulty` observes how actual block spacing compares with the
   *     target and is recomputed from chain history every
   *     `difficultyWindowBlocks` blocks. It is telemetry, not an acceptance
   *     threshold, and never asks anyone to hash harder;
   *   - participation itself is time-based: mining claims open on a 4-hour
   *     protocol-time schedule, six per day per wallet.
   *
   * Cryptographic hashing still happens everywhere (block ids, Merkle roots,
   * state roots, signatures). Computation is not the consensus mechanism: time
   * is. That distinction is the whole point of PoT, and it is documented in
   * /docs/proof-of-time.md.
   */
  proofOfTime: {
    /** Machine-readable consensus identity, reported by every node. */
    consensus: 'PROOF_OF_TIME' as const,
    /** Short name used in APIs and the interface. */
    shortName: 'PoT' as const,
    /**
     * Fork-choice rule. Every valid block contributes exactly one unit;
     * equal-weight/height branches resolve by the lowest block hash, independent
     * of peer arrival order or unauthenticated vote gossip.
     */
    weightRule: 'FINALIZED_PREFIX_THEN_FIXED_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HASH' as const,
    /** Blocks of history used to recompute PoT Difficulty. */
    difficultyWindowBlocks: 720,
    /** Reference spacing in seconds that observational PoT Difficulty compares against. */
    difficultyTargetSeconds: 5,
    /**
     * PoT Difficulty bounds, in basis points of the *time* target
     * (2_500 = 25% of the target spacing, 40_000 = 400%).
     */
    minDifficultyBps: 2_500,
    maxDifficultyBps: 40_000,
    /**
     * PoT Difficulty is published in thousandths of a second as observational
     * spacing telemetry. It is not a consensus-enforced minimum.
     */
    minBlockSpacingMs: 200,
    /** Time-Rate measurement window, seconds (one day). */
    timeRateWindowSeconds: 24 * 60 * 60,
    /**
     * Time-Rate is the protocol's participation metric: verified blocks and
     * verified transactions per minute of protocol time, across the window.
     * It is what an explorer shows where a PoW chain shows hashrate.
     */
    timeRateUnit: 'BLOCKS_AND_TXS_PER_MINUTE' as const,
  },

  // ── Platform revenue split + Node Runner rewards ───────────────────────────
  /**
   * ONS is the only source of protocol revenue. Every accepted registration or
   * renewal fee is split in the state transition:
   *
   *     ONS revenue
   *        ├── 90%  →  Node Runner Reward Pool
   *        └── 10%  →  protocol treasury wallet (genesis-designated)
   *
   * Integer allocation floors the runner share and assigns the exact remainder
   * to treasury, so no seal is lost or duplicated. Gas, issuance,
   * mining rewards and the genesis allocation are not ONS revenue.
   */
  nodeRewards: {
    /** 90% of ONS revenue goes to node runners. */
    nodePoolShareBps: 9_000,
    /** 10% goes to the protocol treasury wallet. */
    treasuryShareBps: 1_000,
    /** Reward period length in seconds (one day of protocol time). */
    periodSeconds: 24 * 60 * 60,
    /**
     * Minimum verified uptime (basis points) for a node to be eligible in a
     * period. Below this the node is scored but receives nothing.
     */
    minUptimeBps: 5_000,
    /** Minimum total score (basis points) required to receive a share. */
    minScoreBps: 1_000,
    /**
     * Attestations needed before a node's liveness is considered independently
     * verified, when enough peers exist. With n registered nodes the protocol
     * requires `min(minAttesters, n - 1)` distinct attesters: a two-node
     * network can verify each other, a single-node network cannot.
     */
    minAttesters: 2,
    /** Uptime component of a single-node network, per mille of the peerless case. */
    bootstrapUptimeBps: 5_000,
    /** Maximum subjects one node may attest in one period. */
    maxAttestationsPerAttester: 64,
    /**
     * Uptime is measured in windows of protocol time: a node is "up" in a window if the chain contains one of its
     * in-sync heartbeats (or a block it produced) inside that window. One accepted heartbeat per window per node.
     */
    uptimeWindowSeconds: 60 * 60,
    uptimeWindowsPerPeriod: 24,
    /** Fault reports accepted per reporter per period. */
    maxFaultReportsPerReporterPerPeriod: 8,
    /** Score weight of one corroborated fault report, basis points. */
    faultPenaltyBps: 2_000,
    /** Maximum block lag still counted as "responsive" in an attestation. */
    responsiveHeightLag: 12,
    /**
     * Score composition (basis points, must sum to 10_000). Every component is
     * computed by each node from chain data; no operator ever reports a number.
     */
    scoreWeights: {
      uptimeBps: 4_000,
      participationBps: 2_500,
      reliabilityBps: 2_000,
      responsivenessBps: 1_500,
    },
    /** Within participation: produced blocks vs. attested peer coverage. */
    participationWeights: { blocksBps: 6_000, coverageBps: 4_000 },
    /**
     * Ceiling on what one node may take from a period's pool (5%). The effective ceiling is never lower than an
     * equal split (`ceil(10_000 / eligibleNodes)`), so a small network is paid in full instead of stranding the pool.
     */
    maxNodeShareBps: 500,
    /** Allocations below this are carried to the next period instead of paid as dust (0.000001 OBS). */
    minPayoutSeals: 1_000_000_000_000n,
    /** Reward-wallet changes take effect after this many periods; the current wallet may cancel before then. */
    walletChangeDelayPeriods: 2,
    /** The bound wallet's owner may release a squatted binding; it takes effect after this many periods. */
    reclaimDelayPeriods: 1,
    /** Evidence kept per node, in periods (older periods are archived). */
    evidenceWindowPeriods: 3,
    /** Minimum registration age, in blocks, before a node can earn. */
    minRegistrationBlocks: 1,
    /**
     * Maximum validity of a signed node statement (registration, deregistration),
     * in seconds of protocol time. Short windows mean a captured statement is
     * useless by the time an attacker can mine it into a block.
     */
    proofMaxValiditySeconds: 3_600,
    /** Endpoint hint length limits (informational field, never an identity). */
    maxEndpointLength: 120,
  },


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
    /** Deeper advisory confirmation threshold; not irreversible or mathematical finality. */
    confirmationDepthHard: 64,
    /** Emission decade length used by the halving-style issuance cap. */
    issuanceDecadeSeconds: 10 * 365.25 * 24 * 60 * 60,
  },

  // ── Producers / consensus (1.9.0) ─────────────────────────────────────────
  /**
   * PRODUCER SCHEDULE AND FINALITY — protocol 1.9.0 (specified in docs/consensus-v1.9.0.md).
   *
   * There are no validators, no bond, no votes and no quorum certificate. Every node that has registered
   * (free, signed only by its own identity key) and is synchronised and live joins ONE deterministic producer
   * schedule; each slot names exactly one producer, derived from committed chain state and the slot's timestamp
   * alone. A producer that misses its slot is skipped by the next round and, after repeated misses, suspended
   * for a deterministic back-off.
   */
  consensus: {
    /**
     * A branch must contain the finalized prefix. Among such branches compare fixed PoT weight, then height, then the
     * lexicographically lowest block hash.
     */
    forkChoice: 'FINALIZED_PREFIX_THEN_FIXED_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HASH' as const,
    /** Maximum reorg depth accepted by the node's ordinary chain reorganiser. */
    maxReorgDepth: 256,
    /** Blocks that may compete for one height before further candidates are refused. */
    maxCandidatesPerHeight: 8,
    producers: {
      /**
       * A node is schedulable only this many blocks after the block that registered it: a freshly minted identity
       * cannot take a slot (or count towards finality) until it has existed, on chain, for this long.
       */
      maturityBlocks: 64,
      /**
       * A node is schedulable only if it has shown life (registered, heartbeat, or produced a block) within this
       * many seconds of protocol time. Heartbeats are hourly uptime windows, so two days of silence ends eligibility.
       */
      activityWindowSeconds: 2 * 24 * 60 * 60,
      /** Consecutive missed scheduled slots after which a producer is suspended. */
      maxConsecutiveMisses: 3,
      /** First suspension term (protocol seconds). Each repeat without a produced block doubles it. */
      baseSuspensionSeconds: 10 * 60,
      /** Ceiling on the back-off (protocol seconds). */
      maxSuspensionSeconds: 24 * 60 * 60,
      /** Admission rate limit: node registrations accepted in one block. */
      maxRegistrationsPerBlock: 2,
      /** Admission rate limit: new nodes per reward period, or one tenth of the registry if that is more. */
      minNewNodesPerPeriod: 16,
      newNodesPerPeriodDivisor: 10,
      /** Equivocation reports a single block may carry (each costs two signature verifications). */
      maxEquivocationReportsPerBlock: 4,
    },
    /**
     * PRODUCER-DIVERSITY CHECKPOINT FINALITY (no voting; see docs/consensus-v1.9.0.md §7).
     *
     * A block B at height h is FINAL on a chain iff the `window(n)` blocks that follow it were produced by at
     * least `quorum(n)` DISTINCT nodes drawn from the n nodes that were registered and mature at height h and are
     * still live (a suspension does not count against it) and unbanned when the window closes, where n >= minProducers. A pure function of chain
     * history, evaluated inside the block state machine and committed in the state root: every node computes the
     * same answer, no message is sent and no local timer participates.
     */
    finality: {
      model: 'PRODUCER_DIVERSITY_CHECKPOINT' as const,
      /** Fewer mature producers than this and the protocol reports that finality is unavailable. */
      minProducers: 2,
      quorumNumerator: 2,
      quorumDenominator: 3,
      /** window(n) = clamp(windowPerProducer * n, windowMin, windowMax) blocks. */
      windowMin: 32,
      windowPerProducer: 3,
      windowMax: 1024,
      /** A node stops counting towards n after this many reward periods without any sign of life. */
      inactivityPeriods: 30,
    },
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
    /**
     * Registration and renewal fees, denominated in OBS itself.
     *
     * Previously $5.00 converted at the oracle price, which made name
     * registration unavailable whenever the oracle was absent or stale. The
     * protocol now prices its own services in its own currency: no external
     * price source participates in consensus at all.
     */
    registrationFee: parseObs('0.05'),
    renewalFee: parseObs('0.05'),
    /** Registration grants ownership for this many seconds (1 year). */
    termSeconds: 365 * 24 * 60 * 60,
    /** A transfer offer lapses this many seconds after it is made (7 days) unless the recipient accepts. */
    transferOfferSeconds: 7 * 24 * 60 * 60,
    /** A recovery started by the preconfigured recovery address takes effect only after this delay (7 days). */
    recoveryDelaySeconds: 7 * 24 * 60 * 60,
    /** Grace period after expiry before the name returns to the pool. */
    graceSeconds: 30 * 24 * 60 * 60,
    /**
     * ONS MARKETPLACE (protocol 2.0.0, docs/marketplace-v2.0.0.md).
     *
     * There is NO marketplace commission: the seller of a listing receives exactly the price, the seller of an
     * accepted offer receives exactly the offered amount. Gas is the ordinary protocol gas, charged to the buyer or
     * offer maker at the moment value enters the protocol (a purchase, an offer) and never taken from escrow.
     */
    market: {
      /** Smallest listing price and smallest offer: 0.001 OBS (anti-spam; not a fee). */
      minPriceSeals: parseObs('0.001'),
      /** A pending offer lapses, and its escrow returns to the maker, this long after it is made (7 days). */
      offerSeconds: 7 * 24 * 60 * 60,
      /** Pending offers one name can hold at once. */
      maxPendingOffersPerName: 16,
      /** Pending offers one account can hold at once (each locks funds). */
      maxPendingOffersPerMaker: 32,
      /** Settled offers stay in state this long as the audit trail (90 days); the chain's events keep them for ever. */
      offerRetentionSeconds: 90 * 24 * 60 * 60,
    },
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
      'developer',
    ] as const,
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
