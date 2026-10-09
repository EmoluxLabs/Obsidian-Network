export type PlanKind = 'PAYMENT' | 'VALIDATOR_REGISTER' | 'VALIDATOR_UNREGISTER' | 'VALIDATOR_CLAIM';
export type SignerKind = 'wallet' | 'node-identity';

export interface PlanRow {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}

/** What the confirmation dialog shows. Nothing has been signed when this exists. */
export interface PreparedPlan {
  prepareId: string;
  kind: PlanKind;
  network: string;
  signer: SignerKind;
  from: string;
  rows: PlanRow[];
  warnings: string[];
  /** The wallet signer needs the user's passphrase at confirmation. */
  requiresPassphrase: boolean;
  expiresAt: number;
}

export type SubmissionState = 'submitting' | 'submitted' | 'rejected' | 'unknown';

export interface SubmissionRecord {
  txId: string;
  kind: PlanKind;
  network: string;
  from: string;
  summary: string;
  state: SubmissionState;
  duplicate?: boolean;
  error?: string;
  submittedAt: number;
}

export type TxLiveState = 'pending' | 'confirmed' | 'not-found' | 'unavailable';

export interface TxStatus {
  txId: string;
  live: TxLiveState;
  confirmations: number;
  height?: number;
  message?: string;
}

export interface ExecuteResult {
  txId: string;
  state: SubmissionState;
  duplicate: boolean;
  error?: string;
  nonce: number;
}
