import { prettyObs } from '../shared/amount.js';
import type { NetworkName } from '../shared/chain-types.js';
import { AppError } from '../shared/errors.js';
import type { PreparedPlan } from '../shared/tx-types.js';
import type { CoreModules } from './core-loader.js';
import type { Resolved, ResolveDeps } from '../../vendor/obsidian-core/dist/protocol/recipient.js';
import type { RpcClient } from './rpc-client.js';
import type { TxService } from './tx-service.js';
import type { WalletService } from './wallet-service.js';

/** Plans a PAYMENT. Amount, fee and recipient rules are the core's; this only builds the plan. */
export class PaymentService {
  constructor(
    private readonly deps: {
      core: () => Promise<CoreModules>;
      wallets: WalletService;
      tx: TxService;
      rpc: (network: NetworkName) => RpcClient;
    },
  ) {}

  async prepare(network: NetworkName, input: { to: string; amountObs: string; memo?: string }): Promise<PreparedPlan> {
    const core = await this.deps.core();
    const wallet = await this.deps.wallets.status(network);
    if (!wallet.exists || !wallet.address) throw new AppError('NO_WALLET', `Create or import a ${network} wallet first.`);
    const hrp = core.networks.NETWORKS[network].addressHrp;

    // What was typed is an address or a `.obs` name. A name is resolved from the node's ONS record (held against this
    // network, expiry-checked, its address validated) and only the resolved address goes into the transaction; the plan
    // shows both and is looked up again at signing. An address is validated exactly as before.
    const typed = String(input.to ?? '').trim();
    let to = typed;
    let ons: { name: string; address: string; resolved: Resolved } | undefined;
    if (core.recipient.recipientKind(typed) === 'name') {
      const resolved = await core.recipient.resolveOnsName(typed, this.resolverDeps(core, network));
      if (!resolved.ok) throw new AppError(`ONS_${resolved.code}`, resolved.message);
      to = resolved.address;
      ons = { name: resolved.name, address: resolved.address, resolved };
    }
    if (!core.keys.isValidAddress(to, hrp)) {
      throw new AppError('INVALID_ADDRESS', `That is not a valid ${network} address. ${network} addresses start with "${hrp}1".`);
    }
    let amount: bigint;
    try {
      amount = core.amount.parseObs(String(input.amountObs ?? '').trim());
    } catch (error) {
      throw new AppError('INVALID_AMOUNT', (error as Error).message);
    }
    if (amount <= 0n) throw new AppError('INVALID_AMOUNT', 'The amount must be greater than zero.');
    const memo = input.memo?.trim() ? input.memo.trim() : undefined;
    if (memo && Buffer.byteLength(memo, 'utf8') > core.params.CONSENSUS_PARAMS.tx.maxMemoBytes) {
      throw new AppError('INVALID_MEMO', `The note is longer than ${core.params.CONSENSUS_PARAMS.tx.maxMemoBytes} bytes.`);
    }

    const gas = core.helpers.expectedGas(amount);
    const total = amount + gas;
    const balance = await this.deps.rpc(network).walletBalance(wallet.address);
    if (BigInt(balance.balanceSeals) < total) {
      throw new AppError(
        'INSUFFICIENT_FUNDS',
        `Your balance is ${prettyObs(balance.balanceObs)} OBS but this needs ${prettyObs(core.amount.formatObs(total))} OBS (amount plus the ${prettyObs(core.amount.formatObs(gas))} OBS network fee).`,
      );
    }
    const warnings: string[] = [];
    if (to === wallet.address) warnings.push('The recipient is your own address.');
    if (core.networks.NETWORKS[network].isProduction) warnings.push('This is the mainnet. These are real funds and a transfer cannot be reversed.');
    else warnings.push('This is a test network. Its coins have no monetary value.');

    const body = core.payment.encodePaymentBody({ to, amount, memo });
    return this.deps.tx.register({
      kind: 'PAYMENT',
      network,
      signer: 'wallet',
      from: wallet.address,
      type: core.types.TxType.PAYMENT,
      gas,
      body,
      memo,
      summary: `Send ${prettyObs(core.amount.formatObs(amount))} OBS to ${ons ? `${ons.name} (${to})` : to}`,
      warnings,
      recheck: ons
        ? async () => {
            const again = await core.recipient.reconfirmOnsName(ons.resolved, this.resolverDeps(core, network));
            if (!again.ok) throw new AppError(`ONS_${again.code}`, `${again.message} Nothing was signed.`);
          }
        : undefined,
      rows: [
        { label: 'Network', value: network },
        { label: 'From', value: wallet.address, mono: true },
        ...(ons
          ? [
              { label: 'ONS name', value: ons.name, mono: true },
              { label: 'Resolves to', value: to, mono: true },
              { label: 'ONS status', value: 'Registered on-chain' },
            ]
          : [{ label: 'To', value: to, mono: true }]),
        { label: 'Amount', value: `${prettyObs(core.amount.formatObs(amount))} OBS`, mono: true },
        { label: 'Network fee', value: `${prettyObs(core.amount.formatObs(gas))} OBS`, mono: true },
        { label: 'Total debited', value: `${prettyObs(core.amount.formatObs(total))} OBS`, mono: true, strong: true },
        ...(memo ? [{ label: 'Note', value: memo }] : []),
      ],
    });
  }

  /**
   * The three reads the core's resolver needs, from THIS network's node: the ONS record, the node's own chain identity and
   * head-block time, and what the app expects (the core's network table — the user's chosen network, not the node's claim).
   */
  private resolverDeps(core: CoreModules, network: NetworkName): ResolveDeps {
    const client = this.deps.rpc(network);
    const expected = core.networks.NETWORKS[network];
    return {
      lookup: (name) => client.nameRecord(name),
      context: async () => {
        const [health, status] = await Promise.all([client.health(), client.status()]);
        // The node says which network it is; its prefix comes from the core's own table for that name.
        const reported = (core.networks.NETWORKS as Record<string, { addressHrp: string } | undefined>)[health.network];
        return { chainId: health.chainId, addressHrp: reported?.addressHrp ?? '', protocolTime: status.lastBlockTimestamp };
      },
      expected: async () => ({ chainId: expected.chainId, addressHrp: expected.addressHrp }),
    };
  }
}
