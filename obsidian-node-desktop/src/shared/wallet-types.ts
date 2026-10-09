import type { NetworkName } from './chain-types.js';

export interface WalletStatus {
  network: NetworkName;
  exists: boolean;
  address: string | null;
  addressHrp: string;
  createdAt: number | null;
}
