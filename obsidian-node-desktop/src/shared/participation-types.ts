import type { NodeStatusInfo } from './chain-types.js';

/**
 * Where this node stands in the node-participation protocol (1.9.0).
 *
 *   no-wallet   no reward wallet has been chosen; the node still verifies and relays, and earns nothing
 *   waiting     a wallet is chosen; the node registers itself once it is synchronized and producing
 *   registered  the chain holds the registration
 *   changing    a different wallet was chosen; the chain applies it after its delay
 *   banned      the chain banned this node permanently (provable double-signing)
 *   left        the node deregistered
 *   unknown     the node is not answering, so the chain cannot be read; nothing is guessed
 */
export type ParticipationPhase = 'unknown' | 'no-wallet' | 'waiting' | 'registered' | 'changing' | 'banned' | 'left';

export interface ParticipationCheck {
  label: string;
  /** null = could not be determined (node not reachable). Never shown as a pass. */
  pass: boolean | null;
  detail: string;
}

export interface ParticipationView {
  network: string;
  nodeReachable: boolean;
  synced: boolean | null;
  /** hash(node public key): the identity the chain knows this node by. null until the node has created its key. */
  nodeId: string | null;
  /** The reward wallet the operator pasted (the local file). Not proof of anything until the chain holds it. */
  chosenWallet: string | null;
  /** The chain's own record of this node, or null when it holds none. */
  record: NodeStatusInfo | null;
  phase: ParticipationPhase;
  /** The block-production setting: a node that does not produce does not register or send heartbeats. */
  participating: boolean;
  chain: {
    tier: string;
    eligibleProducers: number;
    registeredNodes: number;
    bannedNodes: number;
    finalityAvailable: boolean;
    finalizedHeight: number;
    headHeight: number;
    finalityReason: string;
  } | null;
  checks: ParticipationCheck[];
  notes: string[];
}

export interface BindResult {
  rewardWallet: string;
  /** Restart is not needed: the running node reads the file on its next cycle. */
  appliesTo: 'running-node' | 'next-start';
}
