// @vitest-environment jsdom
/**
 * Browser page tests.
 *
 * Everything else in this repository tests the *server*. These tests import the
 * real page modules into a DOM and drive them, because the browser is where the
 * two claims this project cannot afford to get wrong actually live:
 *
 *   1. keys are created in the browser and never sent anywhere, and
 *   2. a page with no reachable node shows that honestly instead of inventing
 *      numbers.
 *
 * The pages are the same modules `scripts/build-web.mjs` bundles into
 * `public/js/*.js`, so this exercises shipped code, not a copy of it.
 */

import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Everything the pages fetch, answered from fixtures — and every call recorded. */
const calls: Array<{ url: string; init?: RequestInit }> = [];
let respond: (url: string) => { status: number; body: unknown } = () => ({ status: 404, body: { error: 'not found' } });

const STATUS_FIXTURE = {
  height: 12,
  headHash: 'ab'.repeat(32),
  genesisHash: 'cd'.repeat(32),
  genesisId: '7d48c9f211e2c4fe94ee2be4d1a1f734e4b7aba6',
  networkId: 'obsidian-devnet-1',
  chainId: 7780,
  protocolVersion: '1.0.0',
  paramsHash: '8385f8ece803d89f6ce43411db38afce',
  totalBlocks: 12,
  peers: 2,
  syncing: false,
  supply: '100166666666666666000',
  supplyObs: '100166.666666666666000000',
  maxSupplyObs: '21000000.000000000000000000',
  lastBlockTimestamp: 1_790_597_000,
  genesis: {
    allocationClaimed: true,
    recipient: 'dobs1aaaaa…zzzzzz',
    treasuryWallet: 'dobs1aaaaa…zzzzzz',
    allocationObs: '100000.000000000000000000',
    claimedAtHeight: 3,
  },
  mining: { activeMiners: 1, dailyRewardObs: '0.001', nextReductionAt: 100_000 },
  metrics: { transactions: 4, miningClaims: 2, accounts: 2 },
};

/** `/mining/schedule` as the node really sends it — field names included. */
const SCHEDULE_FIXTURE = {
  activeMiners: 1,
  dailyRewardSeals: '1000000000000000',
  dailyRewardObs: '0.001',
  claimRewardSeals: '166666666666666',
  claimRewardObs: '0.000166666666666666',
  reductionPercentPerStep: 0.5,
  reductionStepMiners: 100_000,
  floorDailySeals: '200000000000000',
  floorDailyObs: '0.0002',
  claimsPerCycle: 6,
  intervalSeconds: 14_400,
};

/** `/oracle` as the node sends it: micro-USD plus the usable flag, no `medianPriceUsd`. */
const ORACLE_FIXTURE = {
  priceUsdMicro: '50100000',
  priceUsd: '$50.1',
  updatedAt: 1_790_597_000,
  sourceCount: 2,
  stale: false,
  maxAgeSeconds: 21_600,
  minSources: 2,
  usable: true,
  sources: [
    { source: 'exchange-a', priceUsd: '$50.10', observedAt: 1_790_597_000, submitter: 'dobs1aaaaa…zzzzzz', height: 11 },
  ],
};

/** `/params`: the dollar prices that the pages convert at the protocol median. */
const PARAMS_FIXTURE = {
  protocolVersion: '1.0.0',
  paramsHash: '8385f8ece803d89f6ce43411db38afce',
  maximumSupplyObs: '21000000.000000000000000000',
  genesisAllocationObs: '100000.000000000000000000',
  legacyGenesisAllocationObs: '0.000000000000000000',
  mining: {
    claimIntervalSeconds: 14_400,
    maxClaimsPerCycle: 6,
    cycleSeconds: 86_400,
    initialDailyRewardObs: '0.001000000000000000',
    dailyRewardFloorObs: '0.000200000000000000',
    reductionPercentPerStep: 0.5,
    reductionStepMiners: 100_000,
    activeMinerWindowSeconds: 2_592_000,
  },
  gas: { basisPoints: 2, maxGasObs: '0.010000000000000000', destination: 'MINING_POOL' },
  block: { targetSeconds: 5, maxBytes: 2_097_152, maxTransactions: 2000, confirmationDepthSoft: 12, confirmationDepthHard: 64 },
  consensus: { forkChoice: 'MOST_ACCUMULATED_WORK_THEN_LENGTH_THEN_LOWEST_HEADER_HASH', minValidatorBondObs: '1000.000000000000000000', unbondingBlocks: 20_160, maxReorgDepth: 256 },
  ons: { registrationFeeUsd: '5.000000', termSeconds: 31_536_000, graceSeconds: 2_592_000, minLength: 3, maxLength: 63 },
  capsules: { minCommitmentObs: '0.000100000000000000', timeTravelMultiplier: '1000', previewSeconds: 30, maxContentBytes: 262_144 },
  circle: { parcelSquareMetres: 1, appreciationStepBps: 25, depreciationStepBps: 25, minGlvUsd: '100.00', maxGlvUsd: '30000.00' },
  social: { creatorShareBps: 7000, networkShareBps: 3000, businessPagePriceUsd: '50.00', monetisationMinFollowers: 10_000, monetisationMinMonthlyViews: 100_000 },
  oracle: { maxAgeSeconds: 21_600, minSources: 2, maxDeviationBps: 500 },
  registry: { maxInvitesPerAccount: 5, newAccountBalanceObs: '0.000000000000000000', wacEnabled: false, miningKycRequired: false, nativeExchangeEnabled: false },
  paramsHashBytes: 32,
};

/** `/supply`, `/network` and the land registry, as the node names them. */
const SUPPLY_FIXTURE = {
  totalSupplyObs: '100166.666666666666000000',
  totalSupplySeals: '100166666666666666000',
  maxSupplyObs: '21000000.000000000000000000',
  maximumRespected: true,
  invariantOk: true,
  genesisIssuedObs: '100000.000000000000000000',
  minedSupplyObs: '166.666666666666000000',
  lockedInCapsules: '0.000000000000000000',
  validatorBonds: '0.000000000000000000',
  poolBalanceObs: '0.000000000000000000',
  issuanceSources: ['GENESIS_ALLOCATION', 'MINING_REWARD'],
};

const NETWORK_FIXTURE = {
  network: { name: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', p2pMagic: 'OBSD', defaultRpcPort: 38630, defaultP2pPort: 38631, displayName: 'OBS Devnet', isProduction: false },
  genesisId: '7d48c9f211e2c4fe94ee2be4d1a1f734e4b7aba6',
  paramsHash: '8385f8ece803d89f6ce43411db38afce',
  coreVersion: '1.0.0',
  protocolVersion: '1.0.0',
  bootstrap: { hint: 'Query /nodes on several known nodes and cross-check.', seedNodes: [], domains: [] },
};

const COUNTRIES_FIXTURE = {
  countries: [
    { code: 'NG', name: 'Nigeria', continent: 'Africa', divisionCount: 37, glvUsd: '20403' },
    { code: 'GB', name: 'United Kingdom', continent: 'Europe', divisionCount: 4, glvUsd: '20347' },
  ],
};

const DIVISIONS_FIXTURE = {
  country: 'NG',
  count: 2,
  note: 'Divisions come from the protocol geography table; GLVs are current chain state.',
  divisions: [
    { divisionId: 'NG-LA', name: 'Lagos', level: 1, weight: 145, baseGlvUsd: '$204.03', glvUsd: '$204.03', protocolPurchases: 0, protocolBuybacks: 0, lastUpdatedAtHeight: null },
    { divisionId: 'NG-KN', name: 'Kano', level: 1, weight: 100, baseGlvUsd: '$140.71', glvUsd: '$140.71', protocolPurchases: 0, protocolBuybacks: 0, lastUpdatedAtHeight: null },
  ],
};

const BLOCKS_FIXTURE = {
  blocks: [
    { hash: 'ef'.repeat(32), height: 12, timestamp: 1_790_597_000, txCount: 3, producer: 'dobs1dgd9d…jnwz2e', size: 606, prevHash: 'cd'.repeat(32) },
  ],
};

/**
 * Everything the landing page reads, answered from the right endpoint. The
 * client asks for `/api/rpc?path=/status`, so the path arrives percent-encoded:
 * decode before routing or every read silently falls through to the empty body.
 */
/** `/pot` exactly as a node serves it. */
const POT_FIXTURE = {
  consensus: 'PROOF_OF_TIME',
  shortName: 'PoT',
  weightRule: 'POT_WEIGHT_THEN_TIME_THEN_LOWEST_HEADER_HASH',
  explanation: 'Obsidian is a Proof of Time chain.',
  height: 12,
  protocolTime: 1_790_597_010,
  medianTimePast: 1_790_596_950,
  cumulativePotWeight: '30',
  difficulty: {
    difficultyBps: 10_000,
    requiredSpacingMs: 5_000,
    observedSpacingMs: 5_000,
    targetSeconds: 5,
    windowBlocks: 12,
    warmingUp: false,
    role: 'MEASUREMENT',
    note: 'PoT Difficulty reports how block spacing tracks the protocol target.',
  },
  timeRate: {
    blocksPerMinute: 12,
    transactionsPerMinute: 4,
    blocks: 12,
    transactions: 4,
    windowSeconds: 55,
    observedSpacingMs: 5_000,
    difficultyBps: 10_000,
    unit: 'BLOCKS_AND_TXS_PER_MINUTE',
    method: '11 verified blocks and 4 verified transactions over 55s of protocol time',
  },
  timeAuthority: {
    authoritative: 'PROTOCOL_TIME_FROM_CHAIN',
    neverAuthoritative: ['BROWSER_CLOCK', 'DEVICE_CLOCK', 'WEBSITE_SERVER'],
    maxFutureDriftSeconds: 60,
    medianTimePastWindow: 11,
  },
};

function chainFixture(url: string): { status: number; body: unknown } {
  const path = decodeURIComponent(url);
  if (path.includes('/mining/schedule')) return { status: 200, body: SCHEDULE_FIXTURE };
  if (path.includes('/mining/status')) {
    return {
      status: 200,
      body: {
        address: 'dobs1dgd9d4n89k5hrfvu7ged7nfjz86dmsd3jnwz2e',
        eligible: true,
        reason: 'eligible',
        protocolTime: 1_790_597_010,
        nextEligibleAt: 1_790_597_000,
        secondsRemaining: 0,
        claimsThisCycle: 0,
        claimsRemainingInCycle: 6,
        cycleStartAt: 1_790_590_000,
        cycleEndsAt: 1_790_676_400,
        nextClaimSequence: 1,
        nextClaimId: 'ab'.repeat(16),
        rewardPerClaimObs: '0.000166666666666666',
      },
    };
  }
  if (path.includes('/mining/claims')) return { status: 200, body: { claims: [], activeMiners: 1 } };
  if (path.includes('/oracle')) return { status: 200, body: ORACLE_FIXTURE };
  if (path.includes('/params')) return { status: 200, body: PARAMS_FIXTURE };
  if (path.includes('/supply')) return { status: 200, body: SUPPLY_FIXTURE };
  if (path.includes('/network')) return { status: 200, body: NETWORK_FIXTURE };
  if (path.includes('/land/divisions')) return { status: 200, body: DIVISIONS_FIXTURE };
  if (path.includes('/land/countries')) return { status: 200, body: COUNTRIES_FIXTURE };
  if (path.includes('/land/search')) return { status: 200, body: { query: 'lagos', results: [{ divisionId: 'NG-LA', countryCode: 'NG', name: 'Lagos, Nigeria', continent: 'Africa', glvUsdMicro: '20403550000', glvUsd: '20403' }] } };
  if (path.includes('/land/parcels')) return { status: 200, body: { parcels: [], total: 0, supplyCapNote: 'One square metre per protocol transaction.' } };
  if (path.includes('/capsules')) return { status: 200, body: { capsules: [], stats: { total: 0, locked: 0, unlocked: 0, totalLockedObs: '0.000000000000000000', totalReturnedToPoolObs: '0.000000000000000000', totalTimeTravelRevenueObs: '0.000000000000000000', nearestUnlock: null, largestCommitmentObs: '0.000000000000000000', mostTimeTravelled: null, upcomingUnlocks: [] } } };
  if (path.includes('/social/feed')) return { status: 200, body: { posts: [], onChain: true, note: 'from chain state' } };
  if (path.includes('/names')) return { status: 200, body: { names: [], count: 0 } };
  if (path.includes('/blocks')) return { status: 200, body: BLOCKS_FIXTURE };
  if (path.includes('/audit/compliance')) return { status: 200, body: { wac: { present: false, detail: 'removed' }, nativeExchange: { present: false, detail: 'removed' } } };
  if (path.includes('/audit/decentralization')) return { status: 200, body: { nodes: 1, activeMiners: 1 } };
  if (path.includes('/peers')) return { status: 200, body: { peers: [], count: 0 } };
  if (path.includes('/validators')) return { status: 200, body: { validators: [], count: 0 } };
  if (path.includes('/pot')) return { status: 200, body: POT_FIXTURE };
  if (path.includes('/status')) return { status: 200, body: STATUS_FIXTURE };
  return { status: 200, body: {} };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  calls.length = 0;
  // jsdom has no WebCrypto; the browser does. Give the page the real thing so
  // PBKDF2/AES-GCM run for real instead of being mocked.
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  document.body.innerHTML = '<div id="app"></div>';
  window.localStorage.clear();
  respond = () => ({ status: 404, body: { error: 'not found' } });
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: target, init });
    let answer = respond(target);
    // The interface's own routes answer like the real server (node list, no
    // session) unless a test overrides them; everything else defaults to 404.
    if (answer.status === 404) answer = defaultInterfaceAnswer(target) ?? answer;
    return jsonResponse(answer.body, answer.status);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Default answers for the interface's own (non-RPC) routes. */
function defaultInterfaceAnswer(url: string): { status: number; body: unknown } | undefined {
  if (url.includes('/api/nodes')) {
    return {
      status: 200,
      body: {
        nodes: [
          { url: 'http://127.0.0.1:38630', healthy: true, height: 12, latestBlockHash: 'ef'.repeat(32), chainId: 7780, networkId: 'obsidian-devnet-1', peers: 1, latencyMs: 1 },
        ],
        consensusHeight: 12,
        genesisMismatch: false,
      },
    };
  }
  if (url.includes('/api/auth/')) return { status: 401, body: { error: 'sign in required', code: 'ERR_UNAUTHORIZED' } };
  return undefined;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('landing page', () => {
  it('renders the product story with exactly three calls to action', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/landing.js');
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('21,000,000 OBS');
    expect(text).toContain('Proof of Time');

    // The scope rule the product owner set: a description page, not a button hub.
    const ctas = [...document.querySelectorAll('a.cta')].map((node) => node.textContent?.trim());
    expect(ctas).toEqual(['Start Mining', 'Create Wallet', 'Explorer']);
    expect(document.querySelectorAll('.cta-row a')).toHaveLength(3);
  });

  it('reads the chain and shows live numbers instead of placeholders', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/landing.js');
    await settle();

    const stats = document.querySelector('#stats')?.textContent ?? '';
    // The page formats for humans (grouped digits, trimmed zeros) but every
    // number must come from the node, not from a placeholder.
    expect(stats).toContain('100,166');            // supply, from /status
    expect(stats).toContain('0.001');             // reward per day, from /mining/schedule
    expect(stats).toContain('0.00016666');        // reward per claim, exact seals
    expect(stats).toContain('$50.1');             // protocol price, from /oracle (priceUsd)
    expect(stats).toContain('2 independent sources');
    expect(stats).not.toContain('reading the chain');
    expect(stats).not.toContain('no price yet');
  });

  it('says so when no node answers, rather than showing invented numbers', async () => {
    respond = () => ({ status: 503, body: { error: 'no healthy node', code: 'ERR_NO_NODES' } });
    await import('../web/src/pages/landing.js');
    await settle();

    const stats = document.querySelector('#stats')?.textContent ?? '';
    expect(stats.toLowerCase()).toContain('could not read the chain');
    // The page still renders: an outage of a reader is not an outage of the project.
    expect(document.querySelectorAll('a.cta')).toHaveLength(3);
  });
});

describe('every page renders', () => {
  // Static importers, one per page: a bundler cannot analyse a computed
  // specifier, and a test that skips a page because of a build quirk would be
  // worse than no test.
  const pages: Array<[string, () => Promise<unknown>]> = [
    ['landing', () => import('../web/src/pages/landing.js')],
    ['mine', () => import('../web/src/pages/mine.js')],
    ['wallet', () => import('../web/src/pages/wallet.js')],
    ['explorer', () => import('../web/src/pages/explorer.js')],
    ['social', () => import('../web/src/pages/social.js')],
    ['capsule', () => import('../web/src/pages/capsule.js')],
    ['ons', () => import('../web/src/pages/ons.js')],
    ['circle', () => import('../web/src/pages/circle.js')],
    ['developer', () => import('../web/src/pages/developer.js')],
    ['app', () => import('../web/src/pages/app.js')],
    ['audit', () => import('../web/src/pages/audit.js')],
  ];

  it.each(pages)('%s mounts a header, a main region and a heading', async (page, load) => {
    respond = () => ({ status: 503, body: { error: 'node down' } });
    await load();
    await settle();

    const app = document.querySelector('#app');
    expect(app?.querySelector('header.masthead'), `${page} has no masthead`).toBeTruthy();
    expect(app?.querySelector('main.page'), `${page} has no main region`).toBeTruthy();
    const heading = app?.querySelector('h1')?.textContent?.trim() ?? '';
    expect(heading.length, `${page} has an empty h1`).toBeGreaterThan(2);
    // Nothing in a page may inline script or an event handler: the interface
    // ships `script-src 'self'` with no 'unsafe-inline'.
    expect(app?.querySelectorAll('script')).toHaveLength(0);
    for (const node of app?.querySelectorAll('*') ?? []) {
      for (const attribute of node.getAttributeNames()) {
        expect(attribute.startsWith('on'), `${page} uses an inline handler (${attribute})`).toBe(false);
      }
    }
  });

  it('navigates to every site from the shared navigation', async () => {
    respond = () => ({ status: 503, body: {} });
    await import('../web/src/pages/landing.js');
    await settle();

    const links = [...document.querySelectorAll('nav.nav a')].map((node) => node.getAttribute('href'));
    expect(links).toEqual([
      '/mine/',
      '/wallet/',
      '/explorer/',
      '/ons/',
      '/circle/',
      '/capsule/',
      '/social/',
      '/node/',
      '/developer/',
      '/app/',
    ]);
  });
});

describe('wallet page — keys stay in the browser', () => {
  it('generates a wallet locally and never transmits key material', async () => {
    respond = (url) => (url.includes('/api/rpc') ? { status: 200, body: { balanceSeals: '0', balanceObs: '0', nonce: 0, names: [] } } : { status: 404, body: {} });
    await import('../web/src/pages/wallet.js');
    await settle();

    const passphrase = document.querySelector<HTMLInputElement>('#passphrase');
    const confirm = document.querySelector<HTMLInputElement>('#passphrase-confirm');
    expect(passphrase, 'the create form must render for a visitor with no vault').toBeTruthy();
    passphrase!.value = 'correct horse battery staple';
    confirm!.value = 'correct horse battery staple';

    document.querySelector<HTMLButtonElement>('#create')!.click();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const phrase = document.querySelector<HTMLTextAreaElement>('#phrase')?.value ?? '';
    const privateKey = document.querySelector<HTMLInputElement>('#private-key')?.value ?? '';
    expect(phrase.split(/\s+/).length).toBeGreaterThanOrEqual(12);
    expect(privateKey).toMatch(/^[0-9a-f]{64}$/i);

    // The vault is encrypted in localStorage and the plaintext key is not in it.
    expect(Object.keys(window.localStorage)).toEqual(['obsidian.vault.v1']);
    const stored = window.localStorage.getItem('obsidian.vault.v1') ?? '';
    expect(stored).not.toContain(privateKey);
    expect(stored).not.toContain(phrase);

    // Nothing that left the browser contained the key, the phrase or the passphrase.
    for (const call of calls) {
      const payload = `${call.url} ${String(call.init?.body ?? '')}`;
      expect(payload).not.toContain(privateKey);
      expect(payload).not.toContain('correct horse battery staple');
      expect(payload).not.toContain(phrase);
    }
  });

  it('refuses a passphrase it cannot honour the promise of', async () => {
    respond = () => ({ status: 404, body: {} });
    await import('../web/src/pages/wallet.js');
    await settle();

    const passphrase = document.querySelector<HTMLInputElement>('#passphrase')!;
    const confirm = document.querySelector<HTMLInputElement>('#passphrase-confirm')!;
    passphrase.value = 'short';
    confirm.value = 'short';
    document.querySelector<HTMLButtonElement>('#create')!.click();
    await settle();

    expect(document.body.textContent).toContain('at least 8 characters');
    expect(document.querySelector('#phrase')).toBeNull();
  });

  it('offers to unlock an existing vault instead of overwriting it', async () => {
    // A wallet created in a previous session: the page must not silently replace it.
    window.localStorage.setItem('obsidian.vault.v1', JSON.stringify({ version: 1, address: 'dobs1existing…address', salt: 'aa', iterations: 210_000, iv: 'bb', ciphertext: 'cc' }));
    respond = () => ({ status: 404, body: {} });
    await import('../web/src/pages/wallet.js');
    await settle();

    expect(document.querySelector('#unlock'), 'an existing vault must ask for its passphrase').toBeTruthy();
    expect(document.querySelector('#create')).toBeNull();
    expect(document.body.textContent).toContain('Delete vault from this browser');
  });
});

describe('pages read the field names the node really sends', () => {
  it('explorer renders block transaction counts and sizes, not undefined', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/explorer.js');
    await settle();

    const blocks = document.querySelector('#blocks')!.textContent ?? '';
    expect(blocks).toContain('12');       // height
    expect(blocks).toContain('3');        // txCount — the node calls it txCount, not transactionCount
    expect(blocks).toContain('606 B');    // size, not sizeBytes
    expect(document.body.textContent).not.toContain('undefined');

    const stats = document.querySelector('#chain-stats')!.textContent ?? '';
    expect(stats).toContain('100,166.66666666 OBS of 21,000,000 OBS');
    expect(stats).toContain('claimed · 100,000 OBS');
    expect(stats).toContain('0 OBS');   // the mining pool balance, from /supply.poolBalanceObs
  });

  it('ONS computes the registration fee from the protocol price and the protocol table', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/ons.js');
    await settle();

    const panel = document.querySelector('#register')!.textContent ?? '';
    expect(panel).toContain('$50.1');                       // oracle median, from /oracle
    expect(panel).toContain('2 independent oracle submissions');
    expect(panel).toContain('$5');                          // registrationFeeUsd, from /params
    // $5.00 at $50.10/OBS, exact integer maths: 0.099800399201596806 OBS
    expect(panel).toContain('0.099800399201596806 OBS');
    expect(panel).not.toContain('undefined');
  });

  it('ONS closes registration honestly when the feed is unusable', async () => {
    respond = (url) => {
      if (!url.includes('/api/rpc')) return { status: 404, body: {} };
      if (decodeURIComponent(url).includes('/oracle')) {
        return { status: 200, body: { ...ORACLE_FIXTURE, usable: false, stale: true, priceUsd: '$0', priceUsdMicro: '0', sourceCount: 0 } };
      }
      return chainFixture(url);
    };
    await import('../web/src/pages/ons.js');
    await settle();

    const panel = document.querySelector('#register')!.textContent ?? '';
    expect(panel).toContain('closed right now');
    expect(panel).not.toContain('0.0998');
  });

  it('Circle lists countries with their GLV in dollars and drills into divisions', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/circle.js');
    await settle();

    const atlas = document.querySelector('section.card')!.textContent ?? '';
    expect(atlas).toContain('Nigeria');
    expect(atlas).toContain('37 divisions');
    expect(atlas).toContain('$20,403');   // whole dollars, not $0.02
    expect(document.body.textContent).not.toContain('$0.02');

    document.querySelector<HTMLButtonElement>('#country-NG')!.click();
    await settle();

    const detail = document.querySelector('#parcel-detail')!.textContent ?? '';
    expect(detail).toContain('Lagos');
    expect(detail).toContain('NG-LA');
    expect(detail).toContain('$204.03');
    expect(detail).not.toContain('undefined');
  });

  it('Capsule wall reads the node aggregate block instead of re-summing strings', async () => {
    respond = (url) => {
      if (!url.includes('/api/rpc')) return { status: 404, body: {} };
      const path = decodeURIComponent(url);
      if (path.includes('/capsules')) {
        return {
          status: 200,
          body: {
            capsules: [
              { capsuleId: 'cap1', owner: 'dobs1aaaa…zzzz', commitmentObs: '0.000100000000000000', teaser: 'for 2030', unlockAt: 1_893_456_000, createdAt: 1_790_597_000, status: 'LOCKED', previewCount: 0, timeTravelRevenue: '0.000000000000000000', timeTravelPriceObs: '0.100000000000000000', contentBytes: 32 },
            ],
            stats: { total: 1, locked: 1, unlocked: 0, totalLockedObs: '0.000100000000000000', totalReturnedToPoolObs: '0.000000000000000000', totalTimeTravelRevenueObs: '0.000000000000000000', nearestUnlock: 1_893_456_000, largestCommitmentObs: '0.000100000000000000', mostTimeTravelled: null, upcomingUnlocks: [] },
          },
        };
      }
      return chainFixture(url);
    };
    await import('../web/src/pages/capsule.js');
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('0.0001 OBS');            // the commitment from chain state
    expect(text).toContain('sealed');                // status LOCKED, not "unlocked"
    expect(text).toContain('1000×');                 // Time Travel price, from /params
    expect(text).not.toContain('undefined');
  });
});

/**
 * The node runner page.
 *
 * The rule this page has to honour is the one an operator cannot verify by
 * looking: it must never display a metric the protocol did not compute. These
 * tests drive the real module and check both halves — the economics it shows
 * everyone, and what it does when the evidence is empty or the node is unknown.
 */
const REVENUE_FIXTURE = {
  qualifyingPlatformRevenueObs: '100.000000000000000000',
  split: {
    nodeRunnerPoolObs: '40.000000000000000000',
    treasuryObs: '60.000000000000000000',
    nodePoolBps: 4000,
    treasuryBps: 6000,
    sumsBack: true,
  },
  bySource: [{ source: 'ONS_REGISTRATION', totalObs: '100.000000000000000000' }],
  accounts: {
    miningPoolObs: '3.500000000000000000',
    nodeRunnerPoolObs: '40.000000000000000000',
    nodeBondsObs: '100.000000000000000000',
    unclaimedTreasuryRevenueObs: '0.000000000000000000',
    treasuryWallet: 'dobs1aaaaa…zzzzzz',
  },
  notPlatformRevenue: [{ kind: 'user-to-user transfer', because: 'the sender owns the funds' }],
  gas: { destination: 'MINING_POOL', note: 'gas funds the Mining Pool', lifetimeObs: '0.020000000000000000' },
};

const REWARDS_FIXTURE = {
  split: { nodePoolBps: 4000, treasuryBps: 6000, description: '40% node runners, 60% treasury' },
  pool: {
    balanceObs: '40.000000000000000000',
    bondedObs: '100.000000000000000000',
    lifetimeInflowObs: '40.000000000000000000',
    lifetimeDistributedObs: '0.000000000000000000',
    unclaimedTreasuryRevenueObs: '0.000000000000000000',
    lastSettledPeriod: 0,
    currentPeriod: 20726,
    periodSeconds: 86400,
  },
  scoring: {
    nodePoolBps: 4000,
    treasuryBps: 6000,
    periodSeconds: 86400,
    minUptimeBps: 5000,
    minScoreBps: 1000,
    maxNodeShareBps: 500,
    minAttesters: 2,
    walletChangeDelayPeriods: 1,
    evidenceWindowPeriods: 3,
    scoreWeights: { uptimeBps: 4000, participationBps: 2500, reliabilityBps: 2000, responsivenessBps: 1500 },
  },
  settlements: [],
};

const REGISTRY_FIXTURE = {
  period: 20726,
  count: 1,
  registeredNodes: 1,
  nodes: [
    {
      nodeId: 'a1'.repeat(20),
      rewardWallet: 'dobs1aaaaa…zzzzzz',
      endpoint: '203.0.113.10:8631',
      registeredAtHeight: 5,
      bondObs: '100.000000000000000000',
      lifetimeRewardObs: '0.000000000000000000',
      pendingWallet: null,
      pendingWalletEffectivePeriod: null,
      currentPeriod: { period: 20726, heartbeats: 1, attesters: 0, blocksProduced: 2, attestationsMade: 0, faults: 0, staleHeartbeats: 0 },
    },
  ],
  note: 'every field is recomputed from chain state',
};

function nodeAnswer(url: string): { status: number; body: unknown } | undefined {
  if (url.includes('path=%2Frevenue')) return { status: 200, body: REVENUE_FIXTURE };
  if (url.includes('path=%2Fnodes%2Frewards')) return { status: 200, body: REWARDS_FIXTURE };
  if (url.includes('path=%2Fnodes%2Fregistry')) return { status: 200, body: REGISTRY_FIXTURE };
  return undefined;
}

describe('node runner page', () => {
  it('shows the 40/60 split with the amounts the node reported', async () => {
    respond = (url) => nodeAnswer(url) ?? { status: 404, body: {} };
    await import('../web/src/pages/node.js');
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('40%');
    expect(text).toContain('60%');
    expect(text).toContain('Node Runner Reward Pool');
    // The amounts come from the node, not from a percentage the page computed.
    // Read the two branches out of the DOM so the assertion is about what an
    // operator actually sees, not about where the string happens to land.
    const branches = [...document.querySelectorAll('.flow-branch')].map((node) => node.textContent ?? '');
    expect(branches).toHaveLength(2);
    expect(branches[0]).toContain('40%');
    expect(branches[0]).toContain('Node Runner Reward Pool');
    expect(branches[0]).toMatch(/\b40\b/);
    expect(branches[1]).toContain('60%');
    expect(branches[1]).toContain('Treasury wallet');
    expect(branches[1]).toMatch(/\b60\b/);
    expect(text).toContain('verified'); // the sums-back check
  });

  it('lists a registered node with the evidence recorded about it', async () => {
    respond = (url) => nodeAnswer(url) ?? { status: 404, body: {} };
    await import('../web/src/pages/node.js');
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('a1'.repeat(20));
    expect(text).toContain('Registered nodes (1)');
    expect(text).toContain('every field is recomputed from chain state');
  });

  it('says a period has not settled instead of rendering an empty payout table', async () => {
    respond = (url) => nodeAnswer(url) ?? { status: 404, body: {} };
    await import('../web/src/pages/node.js');
    await settle();

    expect(document.body.textContent).toContain('No reward period has closed on this chain yet');
  });

  it('reports the failure when the node is unreachable, and invents nothing', async () => {
    respond = () => ({ status: 503, body: { error: 'no healthy node' } });
    await import('../web/src/pages/node.js');
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Could not read the reward economics');
    // No fabricated score, percentage or payout may appear.
    expect(text).not.toMatch(/\b100%\b/);
    expect(text).not.toContain('efficiency: 100');
  });

  it('refuses a malformed node id before making a request', async () => {
    respond = (url) => nodeAnswer(url) ?? { status: 404, body: {} };
    await import('../web/src/pages/node.js');
    await settle();

    const input = document.querySelector<HTMLInputElement>('#node-id')!;
    input.value = 'not-a-node-id';
    calls.length = 0;
    document.querySelector<HTMLFormElement>('form.stack')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await settle();

    expect(calls.some((call) => call.url.includes('nodes%2Fstatus'))).toBe(false);
  });
});

describe('Proof of Time in the interface', () => {
  it('shows the chain\'s PoT state on the explorer, with the real numbers', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/explorer.js');
    await settle();

    const stats = document.querySelector('#chain-stats')!.textContent ?? '';
    expect(stats).toContain('proof of time (PoT)');
    expect(stats).toContain('100.00% of target');
    expect(stats).toContain('12.00 blocks/min');
    expect(stats).toContain('protocol time from chain — never your browser clock');
    expect(stats).not.toContain('hashrate');
    expect(stats).not.toContain('undefined');
  });

  it('never describes Obsidian as a proof-of-work chain on the landing page', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/landing.js');
    await settle();

    const text = (document.body.textContent ?? '').toLowerCase();
    expect(text).toContain('proof of time');

    // "Proof of Time, not Proof of Work" is an allowed contrast — what is
    // forbidden is any sentence that calls THIS network proof-of-work, or that
    // sells its security as computation.
    expect(text).not.toMatch(/(is|as)\s+a\s+proof[- ]of[- ]work/);
    expect(text).not.toMatch(/proof[- ]of[- ]work\s+(blockchain|chain|network|consensus)/);
    expect(text).not.toContain('hash rate');
    expect(text).not.toContain('hashrate');
    expect(text).not.toContain('mining rig');
    expect(text).not.toContain('energy-intensive');
  });

  it('degrades honestly on a node that has no /pot route', async () => {
    respond = (url) => {
      if (!url.includes('/api/rpc')) return { status: 404, body: {} };
      if (decodeURIComponent(url).includes('/pot')) return { status: 404, body: { error: 'not found', code: 'ERR_NOT_FOUND' } };
      return chainFixture(url);
    };
    await import('../web/src/pages/explorer.js');
    await settle();

    const stats = document.querySelector('#chain-stats')!.textContent ?? '';
    // The panel still renders, the consensus name is still correct, and the
    // measurements say "—" instead of pretending to a number.
    expect(stats).toContain('Proof of Time (PoT)');
    expect(stats).toContain('Height');
    expect(stats).not.toContain('undefined');
    expect(stats).not.toContain('NaN');
  });

  it('tells a miner which clock decides, on the mining page', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/mine.js');
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('protocol time from chain');
    expect(text).toContain('changing your device clock changes the countdown you see and nothing the protocol accepts');
  });
});
