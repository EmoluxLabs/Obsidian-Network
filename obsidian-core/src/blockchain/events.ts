/**
 * Protocol event encoding.
 *
 * Events are the machine-readable audit trail of a block. They are committed to
 * by the block header (eventsRoot) and rebuilt by every node, so an indexer or
 * an explorer can verify that the events it shows really belong to the chain.
 */

import { Writer } from '../protocol/encoding.js';
import type { ProtocolEvent } from '../protocol/types.js';

export function encodeEvent(event: ProtocolEvent): Uint8Array {
  const w = new Writer();
  w.string(event.type);
  w.u32(event.height);
  w.string(event.txId ?? '');
  const keys = Object.keys(event.data).sort();
  w.u32(keys.length);
  for (const key of keys) {
    const value = event.data[key];
    w.string(key);
    if (value === null) {
      w.u8(0);
    } else if (typeof value === 'boolean') {
      w.u8(1);
      w.boolean(value);
    } else if (typeof value === 'number') {
      w.u8(2);
      w.i128(BigInt(Math.trunc(value)));
    } else {
      w.u8(3);
      w.string(String(value));
    }
  }
  return w.finish();
}

export function encodeEventForRoot(event: ProtocolEvent): Uint8Array {
  return encodeEvent(event);
}
