/**
 * Validator Centre: only what the protocol supports.
 *
 * The protocol (obsidian-core/src/transactions/executors/validator.ts) has exactly three
 * validator operations — REGISTER, UNREGISTER (starts unbonding) and CLAIM_UNBONDED — plus
 * automatic jailing for missed slots and slashing for provable equivocation. There is no
 * delegation, no commission payout, no rewards claim and no "unjail" transaction (a jail
 * ends by itself after its term), so none of those exist here.
 *
 * Who the validator is: `validatorKey` must be the public key of the registering account, and
 * the node only proposes blocks with its identity key. So the validator account IS this node's
 * identity key (the keystore the core creates on first start). Its address is derived from the
 * keystore's public key; the keystore is opened with the passphrase this app generated, only
 * to sign an operation the user has confirmed.
 *
 * The node publishes validators with masked addresses (first 10 and last 6 characters), so the
 * app finds its own record by that mask and says so.
 */
import { prettyObs } from '../shared/amount.js';
import { existsSync, readFileSync } from 'node:fs';
import type { NetworkName, ValidatorEntry } from '../shared/chain-types.js';
import { AppError } from '../shared/errors.js';
import type { PreparedPlan } from '../shared/tx-types.js';
import type { EligibilityCheck, OperationAvailability, ValidatorPhase, ValidatorView } from '../shared/validator-types.js';
import type { CoreModules } from './core-loader.js';
import type { AppPaths } from './paths.js';
import { RpcClient } from './rpc-client.js';
import type { TxService } from './tx-service.js';
import type { NodeSupervisor } from './node-supervisor.js';

export interface ValidatorDeps {
  core: () => Promise<CoreModules>;
  paths: AppPaths;
  supervisor: NodeSupervisor;
  tx: TxService;
  /** A client when the node of that network is reachable, otherwise null. */
  rpcIfRunning: (network: NetworkName) => RpcClient | null;
}

export class ValidatorService {
  constructor(private readonly deps: ValidatorDeps) {}

  /** The keystore's public key (the keystore stores it unencrypted; no passphrase needed). */
  async identityPublicKey(network: NetworkName): Promise<string | null> {
    const path = this.deps.paths.forNetwork(network).keystore;
    if (!existsSync(path)) return null;
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { publicKey?: unknown };
      return typeof file.publicKey === 'string' && /^0[23][0-9a-f]{64}$/.test(file.publicKey) ? file.publicKey : null;
    } catch {
      return null;
    }
  }

  /** The node identity's address, from the keystore's public key (no passphrase needed). */
  async identityAddress(network: NetworkName): Promise<string | null> {
    const core = await this.deps.core();
    const publicKey = await this.identityPublicKey(network);
    if (!publicKey) return null;
    try {
      return core.keys.addressFromPublicKey(publicKey, core.networks.NETWORKS[network].addressHrp);
    } catch {
      return null;
    }
  }

  /** Open the identity keystore to sign. Verifies the address matches the public file. */
  async identityKey(network: NetworkName): Promise<{ address: string; publicKey: string; privateKeyHex: string }> {
    const core = await this.deps.core();
    const p = this.deps.paths.forNetwork(network);
    const passphrase = this.deps.supervisor.readKeystorePassphrase(network);
    if (!passphrase) throw new AppError('KEYSTORE_PASSPHRASE_MISSING', 'The node identity passphrase file is missing, so the node key cannot be opened.');
    let pair;
    try {
      pair = core.keystore.Keystore.read(p.keystore, passphrase);
    } catch (error) {
      throw new AppError('KEYSTORE_UNREADABLE', (error as Error).message);
    }
    const hrp = core.networks.NETWORKS[network].addressHrp;
    return { address: core.keys.addressFromPublicKey(pair.publicKey, hrp), publicKey: pair.publicKey, privateKeyHex: pair.privateKey };
  }

  async view(network: NetworkName): Promise<ValidatorView> {
    const core = await this.deps.core();
    const identity = await this.identityAddress(network);
    const client = this.deps.rpcIfRunning(network);
    const jailSeconds = core.params.VALIDATOR_JAIL_SECONDS;
    const maxMissed = core.params.CONSENSUS_PARAMS.consensus.maxMissedSlotsPerWindow;

    const base: ValidatorView = {
      network,
      nodeReachable: client !== null,
      synced: null,
      identityAddress: identity,
      identityBalanceObs: null,
      phase: 'unknown',
      record: null,
      params: null,
      chain: null,
      checks: [],
      operations: {
        register: { allowed: false, reason: 'The node is not running.' },
        unregister: { allowed: false, reason: 'The node is not running.' },
        claim: { allowed: false, reason: 'The node is not running.' },
      },
      notes: [],
    };
    if (!client) {
      base.checks = [
        { label: 'Node running and synchronized', pass: null, detail: 'The node is not running. Start it from the Node screen.' },
        { label: 'Validator account (node identity key)', pass: identity ? true : null, detail: identity ?? 'Created the first time the node starts.' },
      ];
      return base;
    }

    try {
      const [health, params, validators, finality] = await Promise.all([client.health(), client.params(), client.validators(), client.finality()]);
      const balance = identity ? await client.walletBalance(identity).catch(() => null) : null;
      const record = identity ? matchRecord(core, identity, validators.registered) : { entry: null as ValidatorEntry | null, ambiguous: false };
      const phase: ValidatorPhase = !identity ? 'not-registered' : record.ambiguous ? 'unknown' : phaseOf(record.entry);
      const synced = !health.syncing;
      const bondSeals = core.amount.parseObs(params.validatorBondObs);
      const gas = core.helpers.expectedGas(bondSeals);
      const needed = bondSeals + gas;
      const balanceSeals = balance ? BigInt(balance.balanceSeals) : null;
      const capReached = validators.registered.length >= params.maxValidators;

      const checks: EligibilityCheck[] = [
        { label: 'Node running and synchronized', pass: synced, detail: synced ? `Height ${health.height}` : 'The node is still catching up with the network.' },
        { label: 'Validator account (node identity key)', pass: identity !== null, detail: identity ?? 'Created the first time the node starts.' },
        {
          label: 'Balance covers bond and fee',
          pass: balanceSeals === null ? null : balanceSeals >= needed,
          detail: balanceSeals === null ? 'Balance unavailable.' : `${prettyObs(balance?.balanceObs)} OBS available; ${prettyObs(core.amount.formatObs(needed))} OBS needed (bond plus fee).`,
        },
        { label: 'Validator registry has room', pass: !capReached, detail: `${validators.registered.length} of ${params.maxValidators} seats used.` },
        { label: 'Not already registered', pass: phase === 'not-registered', detail: phase === 'not-registered' ? 'No validator record for this account.' : `Current status: ${phase}.` },
      ];

      const reg: OperationAvailability = (() => {
        if (!identity) return { allowed: false, reason: 'The node identity key does not exist yet. Start the node once to create it.' };
        if (phase !== 'not-registered') return { allowed: false, reason: phase === 'unknown' ? 'The validator status could not be determined.' : `This account is already ${phase === 'active' ? 'an active validator' : phase}.${phase === 'unbonding' || phase === 'slashed' ? ' Claim the stake first, then register again.' : ''}` };
        if (!synced) return { allowed: false, reason: 'The node must be fully synchronized before registering.' };
        if (balanceSeals === null) return { allowed: false, reason: 'The account balance could not be read.' };
        if (balanceSeals < needed) return { allowed: false, reason: `The validator account needs ${prettyObs(core.amount.formatObs(needed))} OBS and holds ${prettyObs(balance?.balanceObs)}. Send OBS to ${identity} from your wallet first.` };
        if (capReached) return { allowed: false, reason: 'The validator registry is full.' };
        return { allowed: true };
      })();
      const unreg: OperationAvailability =
        phase === 'active' || phase === 'jailed'
          ? synced
            ? { allowed: true }
            : { allowed: false, reason: 'The node must be fully synchronized.' }
          : { allowed: false, reason: phase === 'not-registered' ? 'This account is not a validator.' : phase === 'unbonding' || phase === 'slashed' ? 'Unbonding is already in progress.' : 'Status unknown.' };
      let claim: OperationAvailability = { allowed: false, reason: 'There is no unbonding stake to claim.' };
      if (phase === 'unbonding' || phase === 'slashed') {
        if (!synced) claim = { allowed: false, reason: 'The node must be fully synchronized.' };
        else {
          // Only the node knows whether the unbonding delay has passed: ask it, and show its answer.
          const verdict = await this.claimReadiness(network, identity);
          claim = verdict.valid ? { allowed: true } : { allowed: false, reason: `The stake cannot be claimed yet — the node says: ${verdict.error ?? 'unbonding has not finished'}.` };
        }
      }

      const notes = [
        'Running a node and being a validator are separate. Stopping the node never unbonds funds.',
        `The validator account is this node's identity key: ${identity ?? 'not created yet'}. It signs blocks and registration, and it must hold the bond.`,
      ];
      if (record.ambiguous) notes.push('Two validators share the same masked address; this app cannot tell which one is yours.');
      if (phase === 'jailed') notes.push(`Jailed for missing too many slots. The chain releases a jail by itself after ${formatDuration(jailSeconds)} of protocol time; there is no unjail transaction.`);
      if (phase === 'slashed') notes.push(`Slashed for provable equivocation (${validators.slashBps / 100}% of the bond). The remaining bond can be claimed after the unbonding delay, and a new registration needs a full bond.`);

      return {
        ...base,
        synced,
        identityBalanceObs: balance?.balanceObs ?? null,
        phase,
        record: record.entry,
        params: {
          bondObs: params.validatorBondObs,
          unbondingBlocks: params.unbondingBlocks,
          maxValidators: params.maxValidators,
          slashBps: validators.slashBps,
          slashObs: validators.slashObs,
          jailSeconds,
          maxMissedSlots: maxMissed,
        },
        chain: { activeValidators: validators.activeCount, registeredValidators: validators.registered.length, finalityBootstrap: finality.bootstrap },
        checks,
        operations: { register: reg, unregister: unreg, claim },
        notes,
      };
    } catch (error) {
      return {
        ...base,
        checks: [{ label: 'Node answered', pass: null, detail: (error as Error).message }],
        operations: {
          register: { allowed: false, reason: 'The node did not answer correctly.' },
          unregister: { allowed: false, reason: 'The node did not answer correctly.' },
          claim: { allowed: false, reason: 'The node did not answer correctly.' },
        },
      };
    }
  }

  private claimCache = new Map<string, { at: number; verdict: { valid: boolean; error: string | null } }>();

  /** Dry-run of CLAIM_UNBONDED against the node (cached for 10 s; the node signs nothing and submits nothing). */
  private async claimReadiness(network: NetworkName, address: string | null): Promise<{ valid: boolean; error: string | null }> {
    const hit = this.claimCache.get(network);
    if (hit && Date.now() - hit.at < 10_000) return hit.verdict;
    let verdict: { valid: boolean; error: string | null };
    try {
      const core = await this.deps.core();
      const publicKey = await this.identityPublicKey(network);
      if (!address || !publicKey) throw new Error('the node identity key does not exist yet');
      verdict = await this.deps.tx.check({
        kind: 'VALIDATOR_CLAIM',
        network,
        signer: 'node-identity',
        from: address,
        type: core.types.TxType.VALIDATOR,
        gas: 0n,
        body: core.validator.encodeValidatorBody({ op: core.types.ValidatorOp.CLAIM_UNBONDED, bond: 0n, validatorKey: publicKey, commissionBps: undefined }),
        summary: 'claim check',
        warnings: [],
        rows: [],
      });
    } catch (error) {
      verdict = { valid: false, error: (error as Error).message };
    }
    this.claimCache.set(network, { at: Date.now(), verdict });
    return verdict;
  }

  async prepare(network: NetworkName, op: 'register' | 'unregister' | 'claim'): Promise<PreparedPlan> {
    const core = await this.deps.core();
    const view = await this.view(network);
    if (!view.nodeReachable) throw new AppError('NODE_NOT_RUNNING', 'The node is not running.');
    const availability = view.operations[op];
    if (!availability.allowed) throw new AppError('OPERATION_NOT_ALLOWED', availability.reason ?? 'This operation is not available right now.');
    const address = view.identityAddress;
    const params = view.params;
    if (!address || !params) throw new AppError('OPERATION_NOT_ALLOWED', 'The validator account or protocol parameters are unavailable.');
    const publicKey = await this.identityPublicKey(network);
    if (!publicKey) throw new AppError('OPERATION_NOT_ALLOWED', 'The node identity key does not exist yet.');
    const bond = core.amount.parseObs(params.bondObs);
    if (bond !== core.params.CONSENSUS_PARAMS.consensus.validatorBond) {
      throw new AppError('PARAMS_MISMATCH', `The node requires a ${prettyObs(params.bondObs)} OBS bond but the staged core expects ${prettyObs(core.amount.formatObs(core.params.CONSENSUS_PARAMS.consensus.validatorBond))} OBS. Update the app and node together.`);
    }
    const common = [
      { label: 'Network', value: network },
      { label: 'Validator account (node identity)', value: address, mono: true },
      { label: 'Validator key', value: shortKey(publicKey), mono: true },
    ];
    const hours = (params.unbondingBlocks * 5) / 3600;
    const delay = `${params.unbondingBlocks.toLocaleString('en-US')} blocks (about ${hours.toFixed(0)} hours)`;
    const body = (opCode: number): Uint8Array =>
      core.validator.encodeValidatorBody({ op: opCode, bond: op === 'register' ? bond : 0n, validatorKey: publicKey, commissionBps: undefined });

    if (op === 'register') {
      const gas = core.helpers.expectedGas(bond);
      const warnings = [
        `The ${prettyObs(params.bondObs)} OBS bond is locked by the protocol. It returns only after you request unbonding and ${delay} have passed.`,
        'Registration is not complete until the transaction is confirmed in a block.',
        `A validator that misses more than ${params.maxMissedSlots} slots is jailed automatically; provable double-signing is slashed (${view.params ? view.params.slashBps / 100 : '?'}% of the bond).`,
      ];
      if ((view.chain?.registeredValidators ?? 0) === 0) {
        warnings.unshift(
          'You would be the FIRST validator on this chain. The first registration permanently ends open block production: afterwards only registered validators may produce blocks, and if none is active the chain halts.',
        );
      }
      return this.deps.tx.register({
        kind: 'VALIDATOR_REGISTER',
        network,
        signer: 'node-identity',
        from: address,
        type: core.types.TxType.VALIDATOR,
        gas,
        body: body(core.types.ValidatorOp.REGISTER),
        summary: `Register ${address} as a validator (bond ${prettyObs(params.bondObs)} OBS)`,
        warnings,
        rows: [
          ...common,
          { label: 'Required bond', value: `${prettyObs(params.bondObs)} OBS`, mono: true },
          { label: 'Network fee', value: `${prettyObs(core.amount.formatObs(gas))} OBS`, mono: true },
          { label: 'Total debited', value: `${prettyObs(core.amount.formatObs(bond + gas))} OBS`, mono: true, strong: true },
        ],
      });
    }

    if (op === 'unregister') {
      const warnings = [
        `Validator duties end and the bond is not claimable until ${delay} have passed.`,
        'This is a consequential action and cannot be cancelled.',
      ];
      if (view.chain && view.chain.activeValidators <= 1) {
        warnings.unshift('You appear to be the ONLY active validator. If you unbond, no validator remains and block production halts.');
      }
      return this.deps.tx.register({
        kind: 'VALIDATOR_UNREGISTER',
        network,
        signer: 'node-identity',
        from: address,
        type: core.types.TxType.VALIDATOR,
        gas: 0n,
        body: body(core.types.ValidatorOp.UNREGISTER),
        summary: `Begin unbonding validator ${address}`,
        warnings,
        rows: [...common, { label: 'Current bond', value: `${prettyObs(view.record?.bond ?? params.bondObs)} OBS`, mono: true }, { label: 'Unbonding delay', value: delay }, { label: 'Network fee', value: '0 OBS', mono: true }],
      });
    }

    // claim: the node decides whether the delay has passed; ask it before offering the dialog.
    const plan = {
      kind: 'VALIDATOR_CLAIM' as const,
      network,
      signer: 'node-identity' as const,
      from: address,
      type: core.types.TxType.VALIDATOR,
      gas: 0n,
      body: body(core.types.ValidatorOp.CLAIM_UNBONDED),
      summary: `Claim unbonded stake for ${address}`,
      warnings: ['The returned stake is credited to the validator account (the node identity), not to your wallet.'],
      rows: [...common, { label: 'Stake being returned', value: `${view.record?.bond ? prettyObs(view.record.bond) : 'the remaining bond'} OBS`, mono: true }, { label: 'Network fee', value: '0 OBS', mono: true }],
    };
    const verdict = await this.deps.tx.check(plan);
    if (!verdict.valid) {
      throw new AppError('CLAIM_NOT_READY', `The node says the stake cannot be claimed yet: ${verdict.error ?? 'unbonding has not finished'}.`);
    }
    return this.deps.tx.register(plan);
  }
}

export function maskAddressLikeNode(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 10)}…${address.slice(-6)}`;
}

function matchRecord(core: CoreModules, address: string, registered: ValidatorEntry[]): { entry: ValidatorEntry | null; ambiguous: boolean } {
  const mask = core.indexer.maskAddress(address);
  const matches = registered.filter((entry) => entry.address === mask);
  if (matches.length > 1) return { entry: null, ambiguous: true };
  return { entry: matches[0] ?? null, ambiguous: false };
}

function phaseOf(entry: ValidatorEntry | null): ValidatorPhase {
  if (!entry) return 'not-registered';
  switch (entry.status) {
    case 'ACTIVE':
      return 'active';
    case 'JAILED':
      return 'jailed';
    case 'UNBONDING':
      return 'unbonding';
    case 'SLASHED':
      return 'slashed';
    default:
      return 'unknown';
  }
}

function shortKey(publicKey: string): string {
  return `${publicKey.slice(0, 8)}…${publicKey.slice(-6)}`;
}

function formatDuration(seconds: number): string {
  const hours = seconds / 3600;
  return hours >= 1 ? `${hours.toFixed(hours % 1 === 0 ? 0 : 1)} hours` : `${Math.round(seconds / 60)} minutes`;
}
