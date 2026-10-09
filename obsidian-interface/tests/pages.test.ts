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
  genesisId: 'f34124f398c6cad5a4f8d23f80834b02b1ee27cb',
  networkId: 'obsidian-devnet-1',
  chainId: 7780,
  protocolVersion: '1.3.0',
  paramsHash: '286b5a6f0bcfef5a3e77ca02e726d260',
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

/** `/params`: what the pages read for the protocol version and the OBS fee table. */
const PARAMS_FIXTURE = {
  protocolVersion: '1.3.0',
  paramsHash: '286b5a6f0bcfef5a3e77ca02e726d260',
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
  consensus: { forkChoice: 'FIXED_BLOCK_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HEADER_HASH', validatorBondObs: '20000.000000000000000000', unbondingBlocks: 20_160, maxReorgDepth: 256 },
  ons: {
    // Field names must match the node exactly: fees are OBS-denominated and
    // the node sends `registrationFeeObs`/`renewalFeeObs`. A fixture that
    // keeps an older name turns this suite into a test of the fixture.
    registrationFeeObs: '0.050000000000000000',
    renewalFeeObs: '0.050000000000000000',
    termSeconds: 31_536_000,
    graceSeconds: 2_592_000,
    minLength: 3,
    maxLength: 63,
  },
  oracle: { maxAgeSeconds: 21_600, minSources: 2, maxDeviationBps: 500 },
  registry: { maxInvitesPerAccount: 5, newAccountBalanceObs: '0.000000000000000000', wacEnabled: false, miningKycRequired: false, nativeExchangeEnabled: false },
  paramsHashBytes: 32,
};

/** `/supply` and `/network`, as the node names them. */
const SUPPLY_FIXTURE = {
  totalSupplyObs: '100166.666666666666000000',
  totalSupplySeals: '100166666666666666000',
  maxSupplyObs: '21000000.000000000000000000',
  maximumRespected: true,
  invariantOk: true,
  genesisIssuedObs: '100000.000000000000000000',
  minedSupplyObs: '166.666666666666000000',
  validatorBonds: '0.000000000000000000',
  poolBalanceObs: '0.000000000000000000',
  issuanceSources: ['GENESIS_ALLOCATION', 'MINING_REWARD'],
};

const NETWORK_FIXTURE = {
  network: { name: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', p2pMagic: 'OBSD', defaultRpcPort: 38630, defaultP2pPort: 38631, displayName: 'OBS Devnet', isProduction: false },
  genesisId: 'f34124f398c6cad5a4f8d23f80834b02b1ee27cb',
  paramsHash: '286b5a6f0bcfef5a3e77ca02e726d260',
  coreVersion: '1.3.0',
  protocolVersion: '1.3.0',
  bootstrap: { hint: 'Query /nodes on several known nodes and cross-check.', seedNodes: [], domains: [] },
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
  weightRule: 'FIXED_BLOCK_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HEADER_HASH',
  explanation: 'Obsidian is a Proof of Time chain; each valid block contributes one weight unit.',
  height: 12,
  protocolTime: 1_790_597_010,
  medianTimePast: 1_790_596_950,
  cumulativePotWeight: '13',
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
  it('renders the product story with three product doors and the app download', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/landing.js');
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('21,000,000 OBS');
    expect(text).toContain('Proof of Time');

    // The scope rule the product owner set: a description page, not a button hub.
    const ctas = [...document.querySelectorAll('a.cta')].map((node) => node.textContent?.trim());
    // Three product doors, then the Android download on its own line below them.
    expect(ctas).toEqual(['Start Mining', 'Create Wallet', 'Explorer', 'Download Obsidian App']);
    expect(document.querySelectorAll('.cta-row:not(.cta-row-app) a')).toHaveLength(3);
    expect(document.querySelectorAll('.cta-row-app a')).toHaveLength(1);
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
    // No price feed anywhere on the landing page: protocol fees are OBS and
    // the page shows the fee itself, from /params.
    expect(stats).toContain('0.05');              // name registration fee, from /params
    expect(stats).not.toMatch(/\$\d/);
    expect(stats).not.toContain('independent sources');
    expect(stats).not.toContain('reading the chain');
    expect(stats).not.toContain('no price yet');
    expect(document.body.textContent ?? '').not.toContain('priced in dollars');
  });

  it('says so when no node answers, rather than showing invented numbers', async () => {
    respond = () => ({ status: 503, body: { error: 'no healthy node', code: 'ERR_NO_NODES' } });
    await import('../web/src/pages/landing.js');
    await settle();

    const stats = document.querySelector('#stats')?.textContent ?? '';
    expect(stats.toLowerCase()).toContain('could not read the chain');
    // The page still renders: an outage of a reader is not an outage of the project.
    expect(document.querySelectorAll('a.cta')).toHaveLength(4);
  });
});

const MINER = 'dobs1dgd9d4n89k5hrfvu7ged7nfjz86dmsd3jnwz2e';
const OTHER = 'dobs1w9jdkqpg5ls3sgds4nfgqwu7t9zwxqcfngsm38';

function accountView(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acc-1',
    email: 'miner@gmail.com',
    invitesIssued: 0,
    mfaEnabled: true,
    miningEnabled: true,
    recoveryCodesRemaining: 10,
    walletAddress: MINER,
    ...overrides,
  };
}

/** Put a wallet in this browser the way the wallet page does (address is all the mining page reads). */
function storeWallet(address: string): void {
  window.localStorage.setItem('obsidian.vault.v1', JSON.stringify({ address }));
}

/** The chain answers, and `/api/auth/me` answers with `account` (or 401 when undefined). */
function serve(account: Record<string, unknown> | undefined): void {
  respond = (url) => {
    if (url.includes('/api/auth/me')) {
      return account ? { status: 200, body: { account } } : { status: 401, body: { error: 'sign in required', code: 'ERR_UNAUTHORIZED' } };
    }
    return url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} };
  };
}

/** A signed-in account with a linked wallet and MFA, and that wallet in this browser. */
function readyMiner(): void {
  serve(accountView());
  storeWallet(MINER);
}

describe('mining is gated on the account, not on the browser', () => {
  const panelText = () => document.querySelector('#claim')?.textContent ?? '';
  const asked = (fragment: string) => calls.filter((call) => decodeURIComponent(call.url).includes(fragment));

  it('offers a signed-out visitor nothing but the way in — even with a wallet in the browser', async () => {
    serve(undefined);
    storeWallet(MINER);
    await import('../web/src/pages/mine.js');
    await settle();

    expect(document.querySelector('#claim-button'), 'no claim button').toBeNull();
    expect(panelText()).toContain('Sign in');
    expect(document.querySelector('#claim a[href="/app/"]')).toBeTruthy();
    // Nothing else of the mining interface is on the page, and nothing was
    // requested from the chain on this visitor's behalf.
    for (const id of ['schedule', 'history', 'wallet']) {
      const panel = document.getElementById(id)!;
      expect(panel.hidden, `${id} hidden`).toBe(true);
      expect(panel.textContent, `${id} empty`).toBe('');
    }
    expect(document.body.textContent).not.toContain(MINER);
    expect(asked('/mining/status')).toHaveLength(0);
    expect(asked('/mining/claims')).toHaveLength(0);
  });

  it('asks a signed-in account with no linked wallet to link one, and offers this browser\'s wallet', async () => {
    serve(accountView({ walletAddress: undefined }));
    storeWallet(MINER);
    await import('../web/src/pages/mine.js');
    await settle();

    expect(document.querySelector('#claim-button')).toBeNull();
    expect(panelText()).toContain('Connect a wallet');
    const link = document.querySelector<HTMLButtonElement>('#link-wallet');
    expect(link?.textContent).toContain('Link this wallet');
    expect(asked('/mining/status')).toHaveLength(0);

    // Clicking publishes exactly that address — the server decides whether it is acceptable.
    link!.click();
    await settle();
    const post = calls.find((call) => call.url.includes('/api/wallet/link'));
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ address: MINER });
  });

  it('sends a signed-in account with no wallet anywhere to create one', async () => {
    serve(accountView({ walletAddress: undefined }));
    await import('../web/src/pages/mine.js');
    await settle();
    expect(document.querySelector('#claim-button')).toBeNull();
    expect(document.querySelector('#claim a[href="/wallet/"]')).toBeTruthy();
    expect(document.querySelector('#link-wallet')).toBeNull();
  });

  it('keeps a linked account closed until MFA is confirmed', async () => {
    serve(accountView({ mfaEnabled: false, miningEnabled: false }));
    storeWallet(MINER);
    await import('../web/src/pages/mine.js');
    await settle();
    expect(document.querySelector('#claim-button')).toBeNull();
    expect(panelText()).toContain('two-factor');
    expect(document.querySelector('#claim a[href="/app/"]')).toBeTruthy();
    expect(asked('/mining/status')).toHaveLength(0);
  });

  it('will not sign a claim with a wallet other than the linked one', async () => {
    serve(accountView({ walletAddress: MINER }));
    storeWallet(OTHER);
    await import('../web/src/pages/mine.js');
    await settle();
    expect(document.querySelector('#claim-button')).toBeNull();
    expect(panelText()).toContain('linked wallet only');
    expect(panelText()).toContain(MINER);
    expect(asked('/mining/status')).toHaveLength(0);
  });

  it('shows the claim panel only when signed in, linked, MFA-confirmed and holding the linked wallet', async () => {
    readyMiner();
    await import('../web/src/pages/mine.js');
    await settle();
    const button = document.querySelector<HTMLButtonElement>('#claim-button');
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(false);
    expect(asked('/mining/status')[0]?.url).toContain(MINER);
    expect(document.getElementById('schedule')!.hidden).toBe(false);
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
    ['ons', () => import('../web/src/pages/ons.js')],
    ['node', () => import('../web/src/pages/node.js')],
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
      '/node/',
      '/developer/',
      '/app/',
    ]);
  });
});

describe('wallet page — keys stay in the browser', () => {
  it('generates a wallet locally and never transmits key material', async () => {
    // The page asks which network it is on before deriving anything, so the
    // fixture has to answer /network as a real node would.
    respond = (url) =>
      decodeURIComponent(url).includes('/network')
        ? { status: 200, body: NETWORK_FIXTURE }
        : url.includes('/api/rpc')
          ? { status: 200, body: { balanceSeals: '0', balanceObs: '0', nonce: 0, names: [] } }
          : { status: 404, body: {} };
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
    respond = (url) => (decodeURIComponent(url).includes('/network') ? { status: 200, body: NETWORK_FIXTURE } : { status: 404, body: {} });
    await import('../web/src/pages/wallet.js');
    await settle();

    const passphrase = document.querySelector<HTMLInputElement>('#passphrase')!;
    const confirm = document.querySelector<HTMLInputElement>('#passphrase-confirm')!;
    passphrase.value = 'short';
    confirm.value = 'short';
    document.querySelector<HTMLButtonElement>('#create')!.click();
    await settle();

    expect(document.body.textContent).toContain('at least 12 characters');
    expect(document.querySelector('#phrase')).toBeNull();
  });

  it('offers to unlock an existing vault instead of overwriting it', async () => {
    // A wallet created in a previous session: the page must not silently replace it.
    window.localStorage.setItem('obsidian.vault.v1', JSON.stringify({ version: 1, address: 'dobs1existing…address', addressHrp: 'dobs', salt: 'aa', iterations: 210_000, iv: 'bb', ciphertext: 'cc' }));
    respond = (url) => (decodeURIComponent(url).includes('/network') ? { status: 200, body: NETWORK_FIXTURE } : { status: 404, body: {} });
    await import('../web/src/pages/wallet.js');
    await settle();

    expect(document.querySelector('#unlock'), 'an existing vault must ask for its passphrase').toBeTruthy();
    expect(document.querySelector('#create')).toBeNull();
    expect(document.body.textContent).toContain('Delete vault from this browser');
  });
});

describe('wallet addresses follow the connected network', () => {
  it('derives the connected network\'s prefix, not mainnet', async () => {
    respond = (url) => (decodeURIComponent(url).includes('/network') ? { status: 200, body: NETWORK_FIXTURE } : { status: 404, body: {} });
    await import('../web/src/pages/wallet.js');
    await settle();

    document.querySelector<HTMLInputElement>('#passphrase')!.value = 'correct horse battery staple';
    document.querySelector<HTMLInputElement>('#passphrase-confirm')!.value = 'correct horse battery staple';
    document.querySelector<HTMLButtonElement>('#create')!.click();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const vault = JSON.parse(window.localStorage.getItem('obsidian.vault.v1') ?? '{}') as {
      address: string;
      addressHrp?: string;
    };
    // NETWORK_FIXTURE is devnet.
    expect(vault.addressHrp).toBe('dobs');
    expect(vault.address.startsWith('dobs1'), `got ${vault.address}`).toBe(true);
    expect(document.body.textContent).toContain('devnet');
  });

  it('explains itself, and offers no form, where the browser withholds cryptography', async () => {
    // Opened at http://192.168.x.x (another phone on the Wi-Fi) browsers do not
    // expose crypto.subtle. The page used to die with "undefined" after the form
    // had been filled in; it must say what is wrong before that.
    respond = (url) => (decodeURIComponent(url).includes('/network') ? { status: 200, body: NETWORK_FIXTURE } : { status: 404, body: {} });
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
      configurable: true,
      writable: true,
    });
    await import('../web/src/pages/wallet.js');
    await settle();

    expect(document.querySelector('#create'), 'no create form without WebCrypto').toBeNull();
    const notice = document.querySelector('#insecure-context')?.textContent ?? '';
    expect(notice).toContain('http://127.0.0.1');
    expect(notice).toContain('HTTPS');
    expect(window.localStorage.getItem('obsidian.vault.v1')).toBeNull();
  });

  it('refuses to create a wallet at all when it cannot learn the network', async () => {
    // Deriving blind is how a mainnet-prefixed address ended up on devnet.
    respond = () => ({ status: 503, body: { error: 'no healthy node' } });
    await import('../web/src/pages/wallet.js');
    await settle();

    expect(document.querySelector('#create'), 'no create form without a known network').toBeNull();
    expect(document.body.textContent).toContain('which network');
    expect(window.localStorage.getItem('obsidian.vault.v1')).toBeNull();
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

  it('ONS shows the protocol fee in OBS, with no dollar price and no oracle', async () => {
    respond = (url) => (url.includes('/api/rpc') ? chainFixture(url) : { status: 404, body: {} });
    await import('../web/src/pages/ons.js');
    await settle();

    const panel = document.querySelector('#register')!.textContent ?? '';
    expect(panel).toContain('0.050000000000000000 OBS');
    expect(panel).toContain('consensus parameter');
    expect(panel).not.toMatch(/\$\d/);
    expect(panel).not.toContain('oracle');
    expect(panel).not.toContain('undefined');
    expect(panel).not.toContain('NaN');
    expect(document.querySelector<HTMLButtonElement>('#ons-register')!.disabled).toBe(false);
  });

  it('ONS stays open when the price feed is unusable, because it does not use one', async () => {
    // Registration used to be gated on an oracle median. Repricing in OBS
    // removed that dependency, and this asserts the gate is really gone: a
    // dead feed must not close a feature it no longer prices.
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
    expect(panel).toContain('0.050000000000000000 OBS');
    expect(panel).not.toContain('closed');
    expect(document.querySelector<HTMLButtonElement>('#ons-register')!.disabled).toBe(false);
  });

  it('ONS refuses to guess a fee when no node answers', async () => {
    respond = () => ({ status: 503, body: { error: 'no healthy node' } });
    await import('../web/src/pages/ons.js');
    await settle();

    const panel = document.querySelector('#register')!.textContent ?? '';
    expect(panel).toContain('could not reach a node');
    expect(document.querySelector<HTMLButtonElement>('#ons-register')!.disabled).toBe(true);
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
  onsRevenueObs: '100.000000000000000000',
  split: {
    nodeRunnerPoolObs: '90.000000000000000000',
    treasuryObs: '10.000000000000000000',
    treasuryCreditedObs: '10.000000000000000000',
    treasuryUnclaimedObs: '0.000000000000000000',
    nodePoolBps: 9000,
    treasuryBps: 1000,
    sumsBack: true,
  },
  bySource: [{ source: 'ONS_REGISTRATION', totalObs: '100.000000000000000000' }],
  accounts: {
    miningPoolObs: '3.500000000000000000',
    nodeRunnerPoolObs: '90.000000000000000000',
    nodeBondsObs: '20000.000000000000000000',
    unclaimedTreasuryRevenueObs: '0.000000000000000000',
    treasuryWallet: 'dobs1aaaaa…zzzzzz',
  },
  treasury: {
    designated: true,
    wallet: 'dobs1aaaaa…zzzzzz',
    lifetimeCreditedObs: '10.000000000000000000',
    credited: 'each designated share is credited in the same block as its ONS fee',
  },
  timing: {
    treasuryShare: { paid: 'credited to the designated treasury wallet in the same block as the ONS fee', bps: 1000 },
    nodeRunnerShare: {
      paid: 'once per protocol period, in the first block after the period closes',
      bps: 9000,
      periodSeconds: 86400,
      currentPeriod: 20726,
      lastSettledPeriod: 0,
      nextSettlementAt: 1_790_683_200,
      secondsUntilNextSettlement: 3600,
      registeredNodes: 1,
      poolBalanceObs: '90.000000000000000000',
      carriedWhenNoNodes: false,
      note: 'each registered node is paid in proportion to the score its recorded evidence earned in the period that closed',
    },
  },
  notOnsRevenue: [{ kind: 'user-to-user transfer', because: 'the sender owns the funds' }],
  gas: { destination: 'MINING_POOL', note: 'gas funds the Mining Pool', lifetimeObs: '0.020000000000000000' },
};

const REWARDS_FIXTURE = {
  split: { nodePoolBps: 9000, treasuryBps: 1000, description: '90% node runners, 10% treasury' },
  pool: {
    balanceObs: '90.000000000000000000',
    bondedObs: '20000.000000000000000000',
    lifetimeInflowObs: '90.000000000000000000',
    lifetimeDistributedObs: '0.000000000000000000',
    unclaimedTreasuryRevenueObs: '0.000000000000000000',
    lastSettledPeriod: 0,
    currentPeriod: 20726,
    periodSeconds: 86400,
  },
  scoring: {
    nodePoolBps: 9000,
    treasuryBps: 1000,
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
  it('shows the 90/10 ONS split with the amounts the node reported', async () => {
    respond = (url) => nodeAnswer(url) ?? { status: 404, body: {} };
    await import('../web/src/pages/node.js');
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('90%');
    expect(text).toContain('10%');
    expect(text).toContain('ONS revenue');
    expect(text).toContain('Node Runner Reward Pool');
    // The amounts come from the node, not from a percentage the page computed.
    // Read the two branches out of the DOM so the assertion is about what an
    // operator actually sees, not about where the string happens to land.
    const branches = [...document.querySelectorAll('.flow-branch')].map((node) => node.textContent ?? '');
    expect(branches).toHaveLength(2);
    expect(branches[0]).toContain('90%');
    expect(branches[0]).toContain('Node Runner Reward Pool');
    expect(branches[0]).toMatch(/\b90\b/);
    expect(branches[1]).toContain('10%');
    expect(branches[1]).toContain('Treasury');
    expect(branches[1]).toMatch(/\b10\b/);
    expect(text).toContain('verified'); // the sums-back check
    // The unclaimed obligation is shown separately from what has been credited.
    expect(text).toContain('Treasury share still owed');
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
    readyMiner();
    await import('../web/src/pages/mine.js');
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('protocol time from chain');
    expect(text).toContain('changing your device clock changes the countdown you see and nothing the protocol accepts');
  });
});
