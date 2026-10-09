import type { ValidatorEntry } from './chain-types.js';

export type ValidatorPhase = 'unknown' | 'not-registered' | 'active' | 'jailed' | 'unbonding' | 'slashed';

export interface OperationAvailability {
  allowed: boolean;
  /** Why not, in plain language, when `allowed` is false. */
  reason?: string;
}

export interface EligibilityCheck {
  label: string;
  /** null = could not be determined (node not reachable). Never shown as a pass. */
  pass: boolean | null;
  detail: string;
}

export interface ValidatorView {
  network: string;
  nodeReachable: boolean;
  synced: boolean | null;
  /** The validator account is this node's identity key. null until the node has created it. */
  identityAddress: string | null;
  identityBalanceObs: string | null;
  phase: ValidatorPhase;
  record: ValidatorEntry | null;
  params: {
    bondObs: string;
    unbondingBlocks: number;
    maxValidators: number;
    slashBps: number;
    slashObs: string;
    jailSeconds: number;
    maxMissedSlots: number;
  } | null;
  chain: { activeValidators: number; registeredValidators: number; finalityBootstrap: boolean | null } | null;
  checks: EligibilityCheck[];
  operations: { register: OperationAvailability; unregister: OperationAvailability; claim: OperationAvailability };
  notes: string[];
}
