/** Blockchain Explorer: thin, validated reads of the node's own explorer routes. Adds no data of its own. */
import type { AddressHistory, BlockDetail, BlockSummary, MempoolInfo, NetworkName, TxRecord } from '../shared/chain-types.js';
import { AppError } from '../shared/errors.js';
import type { SearchResult } from '../shared/view-types.js';
import type { ChainService } from './chain-service.js';
import type { CoreModules } from './core-loader.js';
import { RpcError } from './rpc-client.js';

export class ExplorerService {
  constructor(
    private readonly chain: ChainService,
    private readonly core: () => Promise<CoreModules>,
    private readonly network: () => NetworkName,
  ) {}

  /** Newest first. `beforeHeight` pages backwards (exclusive). */
  async blocks(input: { beforeHeight?: number; limit?: number }): Promise<{ blocks: BlockSummary[]; head: number }> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 100);
    const status = await this.chain.read('status', (c) => c.status());
    const top = input.beforeHeight === undefined ? status.height : Math.min(status.height, Math.trunc(input.beforeHeight) - 1);
    if (top < 0) return { blocks: [], head: status.height };
    const from = Math.max(0, top - limit + 1);
    const ascending = await this.chain.rpc(this.network()).blocks({ from, limit: top - from + 1 });
    return { blocks: ascending.filter((b) => b.height <= top).reverse(), head: status.height };
  }

  async block(query: string): Promise<BlockDetail> {
    const q = String(query).trim();
    if (!/^\d{1,12}$/.test(q) && !/^[0-9a-fA-F]{64}$/.test(q)) throw new AppError('BAD_QUERY', 'Enter a block height or a 64-character block hash.');
    try {
      return await this.chain.rpc(this.network()).block(q);
    } catch (error) {
      if (error instanceof RpcError && error.status === 404) throw new AppError('NOT_FOUND', 'No block with that height or hash.');
      throw error;
    }
  }

  async tx(txId: string): Promise<TxRecord> {
    const q = String(txId).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(q)) throw new AppError('BAD_QUERY', 'A transaction id is 64 hexadecimal characters.');
    try {
      return await this.chain.rpc(this.network()).tx(q.toLowerCase());
    } catch (error) {
      if (error instanceof RpcError && error.status === 404) throw new AppError('NOT_FOUND', 'The node does not know that transaction.');
      throw error;
    }
  }

  async address(address: string, limit = 25): Promise<AddressHistory> {
    const core = await this.core();
    const a = String(address).trim();
    if (!core.keys.isValidAddress(a, core.networks.NETWORKS[this.network()].addressHrp)) throw new AppError('BAD_QUERY', 'That is not a valid address for this network.');
    return this.chain.rpc(this.network()).addressHistory(a, Math.min(Math.max(Math.trunc(limit), 1), 100));
  }

  mempool(): Promise<MempoolInfo> {
    return this.chain.read('mempool', (c) => c.mempool());
  }

  /** Classify a search box entry. Does not guess: an unrecognised entry is reported as such. */
  async search(query: string): Promise<SearchResult> {
    const q = String(query ?? '').trim();
    if (!q) return { kind: 'none', query: q, message: 'Enter a block height, block hash, transaction id or address.' };
    const core = await this.core();
    if (/^\d{1,12}$/.test(q)) return { kind: 'block', query: q };
    if (/^[0-9a-fA-F]{64}$/.test(q)) {
      // A 64-hex string is either a block hash or a transaction id; the node knows which.
      const client = this.chain.rpc(this.network());
      try {
        await client.block(q);
        return { kind: 'block', query: q };
      } catch (error) {
        if (!(error instanceof RpcError && error.status === 404)) throw error;
      }
      return { kind: 'tx', query: q.toLowerCase() };
    }
    if (core.keys.isValidAddress(q, core.networks.NETWORKS[this.network()].addressHrp)) return { kind: 'address', query: q };
    return { kind: 'none', query: q, message: 'That is not a block height, a 64-character hash or id, or an address on this network.' };
  }
}
