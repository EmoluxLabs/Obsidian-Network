/**
 * Prepare → confirm → sign → submit → track.
 *
 * Consequential actions (payments and validator operations) go through one pipeline:
 *
 *   1. `register` stores a PLAN (what would be signed) and returns a summary for the
 *      confirmation dialog. Nothing is signed and nothing leaves the machine.
 *   2. `execute` runs only after the user confirmed that exact plan. It reads the nonce
 *      and chain context from the node, signs with the core's own signer, asks the node to
 *      SIMULATE the signed transaction, and submits it only if the node says it is valid.
 *   3. `status` reports what the node says about the transaction. "Submitted" is not
 *      "confirmed": a transaction is confirmed only when the node reports it included in a
 *      block.
 *
 * A plan can be executed once (it is consumed before anything is sent), one transaction per
 * signer may be in flight at a time, and re-sending the identical signed bytes is idempotent
 * at the node, so an interrupted submission can be retried without risk of a double spend.
 */
import { randomUUID } from 'node:crypto';
import type { NetworkName } from '../shared/chain-types.js';
import { AppError } from '../shared/errors.js';
import type { ExecuteResult, PlanKind, PlanRow, PreparedPlan, SignerKind, SubmissionRecord, TxStatus } from '../shared/tx-types.js';
import type { CoreModules } from './core-loader.js';
import type { LogBuffer } from './log-buffer.js';
import { RpcClient, RpcError } from './rpc-client.js';
import type { WalletService } from './wallet-service.js';
import { redactText } from './redact.js';

/** How long a signed transaction stays valid, in protocol seconds. The core allows up to 240 blocks × target. */
export const VALIDITY_SECONDS = 600;
const PLAN_TTL_MS = 5 * 60_000;
const SUBMISSION_LIMIT = 100;

export interface InternalPlan {
  kind: PlanKind;
  network: NetworkName;
  signer: SignerKind;
  from: string;
  type: number;
  gas: bigint;
  body: Uint8Array;
  memo?: string;
  rows: PlanRow[];
  warnings: string[];
  summary: string;
}

interface StoredPlan extends InternalPlan {
  id: string;
  expires: number;
  consumed: boolean;
}

export interface TxServiceDeps {
  core: () => Promise<CoreModules>;
  wallets: WalletService;
  /** A client for the node of that network, or throws NODE_NOT_RUNNING. */
  rpc: (network: NetworkName) => RpcClient;
  /** Open the node identity key (validator operations). */
  nodeIdentity: (network: NetworkName) => Promise<{ address: string; publicKey: string; privateKeyHex: string }>;
  logs: LogBuffer;
}

export class TxService {
  private plans = new Map<string, StoredPlan>();
  private submissions = new Map<string, SubmissionRecord & { signedHex?: string }>();
  private inFlight = new Set<string>();

  constructor(private readonly deps: TxServiceDeps) {}

  register(plan: InternalPlan): PreparedPlan {
    this.sweep();
    const id = randomUUID();
    const expires = Date.now() + PLAN_TTL_MS;
    this.plans.set(id, { ...plan, id, expires, consumed: false });
    return {
      prepareId: id,
      kind: plan.kind,
      network: plan.network,
      signer: plan.signer,
      from: plan.from,
      rows: plan.rows,
      warnings: plan.warnings,
      requiresPassphrase: plan.signer === 'wallet',
      expiresAt: expires,
    };
  }

  cancel(prepareId: string): void {
    this.plans.delete(prepareId);
  }

  async execute(prepareId: string, input: { passphrase?: string }): Promise<ExecuteResult> {
    this.sweep();
    const plan = this.plans.get(prepareId);
    if (!plan) throw new AppError('PLAN_EXPIRED', 'This confirmation expired or was already used. Review the details and start again.');
    if (plan.consumed) throw new AppError('PLAN_ALREADY_USED', 'This transaction was already sent. Check the Transactions screen for its status.');
    if (this.inFlight.has(`${plan.network}:${plan.from}`)) {
      throw new AppError('SENDER_BUSY', 'Another transaction from this account is still being sent. Wait for it to finish.');
    }
    // The in-flight lock is taken before the first await, so a double click cannot start two runs.
    const lockKey = `${plan.network}:${plan.from}`;
    this.inFlight.add(lockKey);
    try {
      return await this.run(plan, input.passphrase);
    } finally {
      this.inFlight.delete(lockKey);
    }
  }

  /** Context from the node + signature. Used by `run` and by `check`. */
  private async buildSigned(plan: InternalPlan, passphrase: string | undefined): Promise<{ signed: { hex: string; txId: string }; nonce: number; client: RpcClient }> {
    const core = await this.deps.core();
    const client = this.deps.rpc(plan.network);
    const expected = core.networks.NETWORKS[plan.network];

    // Chain context comes from the node, and is held against the network the user chose.
    const [health, pot, status] = await Promise.all([client.health(), client.pot(), client.status()]);
    if (health.network !== plan.network || health.chainId !== expected.chainId) {
      throw new AppError('WRONG_NETWORK', `The node reports ${health.network} (chain ${health.chainId}), but this action is for ${plan.network}. Nothing was signed.`);
    }
    if (health.syncing) throw new AppError('NODE_SYNCING', 'The node is still synchronising. Wait until it has caught up before sending anything.');
    const nonce = await client.nextNonce(plan.from);
    const validUntil = Math.max(pot.protocolTime, status.lastBlockTimestamp) + VALIDITY_SECONDS;

    const sign = async (key: { address: string; publicKey: string; privateKeyHex: string }): Promise<{ hex: string; txId: string }> => {
      if (key.address !== plan.from) {
        throw new AppError('SIGNER_MISMATCH', 'The signing key does not belong to the account this transaction was prepared for. Nothing was signed.');
      }
      const envelope = core.encode.signTransaction({
        sender: key.address,
        privateKeyHex: key.privateKeyHex,
        publicKeyHex: key.publicKey,
        chainId: expected.chainId,
        protocolVersion: health.protocolVersion,
        nonce,
        type: plan.type,
        gas: plan.gas,
        body: plan.body,
        memo: plan.memo,
        validUntil,
      });
      return { hex: Buffer.from(core.encode.encodeSignedTx(envelope)).toString('hex'), txId: core.encode.txIdOf(envelope) };
    };

    let signed: { hex: string; txId: string };
    if (plan.signer === 'wallet') {
      if (!passphrase) throw new AppError('PASSPHRASE_REQUIRED', 'Enter your wallet passphrase to sign.');
      signed = await this.deps.wallets.withWallet(plan.network, passphrase, sign);
    } else {
      signed = await sign(await this.deps.nodeIdentity(plan.network));
    }
    return { signed, nonce, client };
  }

  /**
   * Ask the node whether it would accept this operation right now, WITHOUT sending it. Only for the
   * node identity signer (no passphrase involved); the signed bytes are discarded.
   */
  async check(plan: InternalPlan): Promise<{ valid: boolean; error: string | null }> {
    if (plan.signer !== 'node-identity') throw new AppError('CHECK_NOT_SUPPORTED', 'Pre-checks are only available for node identity operations.');
    const { signed, client } = await this.buildSigned(plan, undefined);
    return client.simulate(signed.hex);
  }

  private async run(plan: StoredPlan, passphrase: string | undefined): Promise<ExecuteResult> {
    const { signed, nonce, client } = await this.buildSigned(plan, passphrase);

    // Consumed the moment a signature exists and before anything is sent: from here on this plan can
    // never produce a second transaction. (A wrong passphrase fails earlier and leaves the plan usable.)
    plan.consumed = true;
    this.plans.delete(plan.id);

    const record: SubmissionRecord & { signedHex?: string } = {
      txId: signed.txId,
      kind: plan.kind,
      network: plan.network,
      from: plan.from,
      summary: plan.summary,
      state: 'submitting',
      submittedAt: Date.now(),
      signedHex: signed.hex,
    };
    this.remember(record);

    // The node simulates the exact signed bytes. A transaction it calls invalid is never submitted.
    try {
      const simulation = await client.simulate(signed.hex);
      if (!simulation.valid) {
        record.state = 'rejected';
        record.error = redactText(simulation.error ?? 'The node rejected this transaction.');
        record.signedHex = undefined;
        this.deps.logs.app('WARN', `transaction ${signed.txId} rejected by simulation: ${record.error}`, 'tx');
        return { txId: signed.txId, state: 'rejected', duplicate: false, error: record.error, nonce };
      }
    } catch (error) {
      return this.interrupted(record, error, nonce, 'could not be checked by the node');
    }

    try {
      const result = await client.submit(signed.hex);
      record.state = 'submitted';
      record.duplicate = result.duplicate;
      record.signedHex = undefined;
      this.deps.logs.app('INFO', `transaction ${signed.txId} (${plan.kind}) accepted by the node${result.duplicate ? ' (already known)' : ''}`, 'tx');
      return { txId: signed.txId, state: 'submitted', duplicate: result.duplicate, nonce };
    } catch (error) {
      if (error instanceof RpcError && error.kind === 'http') {
        record.state = 'rejected';
        record.error = redactText(error.message);
        record.signedHex = undefined;
        this.deps.logs.app('WARN', `transaction ${signed.txId} refused by the node: ${record.error}`, 'tx');
        return { txId: signed.txId, state: 'rejected', duplicate: false, error: record.error, nonce };
      }
      return this.interrupted(record, error, nonce, 'may or may not have reached the node');
    }
  }

  /** The node did not answer: the outcome is unknown, which is never reported as success. */
  private interrupted(record: SubmissionRecord & { signedHex?: string }, error: unknown, nonce: number, what: string): ExecuteResult {
    record.state = 'unknown';
    record.error = `The transaction ${what}: ${redactText((error as Error).message)}. Check its status before sending again.`;
    this.deps.logs.app('WARN', `transaction ${record.txId} outcome unknown: ${record.error}`, 'tx');
    return { txId: record.txId, state: 'unknown', duplicate: false, error: record.error, nonce };
  }

  /** Re-send the identical signed bytes of an interrupted submission. Idempotent at the node. */
  async resubmit(txId: string): Promise<ExecuteResult> {
    const record = this.submissions.get(txId);
    if (!record || record.state !== 'unknown' || !record.signedHex) {
      throw new AppError('NOT_RESUBMITTABLE', 'Only a submission whose outcome is unknown can be sent again.');
    }
    const client = this.deps.rpc(record.network as NetworkName);
    try {
      const result = await client.submit(record.signedHex);
      record.state = 'submitted';
      record.duplicate = result.duplicate;
      record.error = undefined;
      record.signedHex = undefined;
      return { txId, state: 'submitted', duplicate: result.duplicate, nonce: -1 };
    } catch (error) {
      if (error instanceof RpcError && error.kind === 'http') {
        record.state = 'rejected';
        record.error = redactText(error.message);
        record.signedHex = undefined;
        return { txId, state: 'rejected', duplicate: false, error: record.error, nonce: -1 };
      }
      return this.interrupted(record, error, -1, 'still could not be sent');
    }
  }

  list(network: NetworkName): SubmissionRecord[] {
    return [...this.submissions.values()]
      .filter((s) => s.network === network)
      .map(({ signedHex: _hidden, ...rest }) => rest)
      .sort((a, b) => b.submittedAt - a.submittedAt);
  }

  /** What the node says about a transaction right now. */
  async status(network: NetworkName, txId: string): Promise<TxStatus> {
    if (!/^[0-9a-f]{64}$/i.test(txId)) throw new AppError('BAD_TXID', 'A transaction id is 64 hexadecimal characters.');
    let client: RpcClient;
    try {
      client = this.deps.rpc(network);
    } catch {
      return { txId, live: 'unavailable', confirmations: 0, message: 'The node is not running, so the status cannot be checked.' };
    }
    try {
      const record = await client.tx(txId.toLowerCase());
      if (record.status === 'PENDING') return { txId, live: 'pending', confirmations: 0, message: 'Waiting in the node\'s mempool for the next block.' };
      return { txId, live: 'confirmed', confirmations: record.confirmations ?? 1, height: record.height };
    } catch (error) {
      if (error instanceof RpcError && error.kind === 'http' && error.status === 404) {
        return { txId, live: 'not-found', confirmations: 0, message: 'The node does not know this transaction (not pending, not in a block).' };
      }
      return { txId, live: 'unavailable', confirmations: 0, message: redactText((error as Error).message) };
    }
  }

  private remember(record: SubmissionRecord & { signedHex?: string }): void {
    this.submissions.set(record.txId, record);
    if (this.submissions.size > SUBMISSION_LIMIT) {
      const oldest = [...this.submissions.keys()][0];
      if (oldest) this.submissions.delete(oldest);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, plan] of this.plans) if (plan.expires < now) this.plans.delete(id);
  }
}
