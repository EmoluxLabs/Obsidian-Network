/**
 * Binary Merkle tree with domain-separated leaves and nodes.
 *
 * Leaf  = H(MERKLE_LEAF | 0x00 | item)
 * Node  = H(MERKLE_NODE | 0x01 | left | right)
 *
 * The 0x00/0x01 prefixes plus distinct domain tags make second-preimage attacks
 * on the tree infeasible (the classic CVE-2012-2459 style issues).
 *
 * Odd levels duplicate the final node (Bitcoin-style) so the tree size is
 * deterministic for any number of leaves, including zero and one.
 */

import { domainHash, utf8 } from '../crypto/hash.js';
import { DOMAIN } from '../protocol/domains.js';
import { toHex, fromHex } from '../crypto/hash.js';

export function merkleLeaf(item: Uint8Array): Uint8Array {
  return domainHash(DOMAIN.MERKLE_LEAF, Uint8Array.of(0x00), item);
}

export function merkleNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return domainHash(DOMAIN.MERKLE_NODE, Uint8Array.of(0x01), left, right);
}

export function merkleRoot(items: Uint8Array[]): Uint8Array {
  if (items.length === 0) return domainHash(DOMAIN.MERKLE_LEAF, utf8('EMPTY'));
  let level: Uint8Array[] = items.map(merkleLeaf);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(merkleNode(left, right));
    }
    level = next;
  }
  return level[0];
}

export function merkleRootHex(items: Uint8Array[]): string {
  return toHex(merkleRoot(items));
}

export interface MerkleProof {
  /** Sibling hashes from leaf to root. */
  path: string[];
  /** Bit i = 1 means the sibling is on the left at level i. */
  left: boolean[];
  root: string;
  leafIndex: number;
  leafCount: number;
}

/** Produce an inclusion proof for `index`. Used by SPV-style light clients. */
export function merkleProof(items: Uint8Array[], index: number): MerkleProof {
  if (index < 0 || index >= items.length) throw new Error('merkle: index out of range');
  let level: Uint8Array[] = items.map(merkleLeaf);
  const path: string[] = [];
  const left: boolean[] = [];
  let idx = index;
  while (level.length > 1) {
    const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sibling = level[siblingIndex < level.length ? siblingIndex : idx];
    path.push(toHex(sibling));
    left.push(idx % 2 === 1);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = i + 1 < level.length ? level[i + 1] : l;
      next.push(merkleNode(l, r));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { path, left, root: toHex(level[0]), leafIndex: index, leafCount: items.length };
}

export function verifyMerkleProof(item: Uint8Array, proof: MerkleProof): boolean {
  let hash = merkleLeaf(item);
  for (let i = 0; i < proof.path.length; i += 1) {
    const sibling = fromHex(proof.path[i]);
    hash = proof.left[i] ? merkleNode(sibling, hash) : merkleNode(hash, sibling);
  }
  return toHex(hash) === proof.root;
}
