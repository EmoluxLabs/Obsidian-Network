/**
 * Canonical binary encoding.
 *
 * Consensus rule: two nodes agree on a hash if and only if they encode the same
 * object identically. Obsidian therefore uses ONE canonical encoder and no JSON
 * in any hashing or signing path. JSON is used only for RPC/UI payloads.
 *
 * Encoder rules:
 *   - Every integer is big-endian two's-complement fixed width, minimal width
 *     that fits with sign preserved (u8/u16/u32/u64/u128).
 *   - Every byte string is length-prefixed with a u32.
 *   - Every string is UTF-8, length-prefixed with a u32 (byte length).
 *   - Every list is length-prefixed with a u32.
 *   - Booleans are a single byte 0x00/0x01.
 *   - No implicit field ordering: writes happen in the order the schema defines.
 *
 * Domain separation: protocol/domains.ts lists the ASCII domain tag that is
 * prepended (length-prefixed) to every hash preimage.
 */

export class Writer {
  private chunks: Uint8Array[] = [];
  private length = 0;

  bytes(data: Uint8Array): this {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, data.length, false);
    this.chunks.push(len, data);
    this.length += 4 + data.length;
    return this;
  }

  raw(data: Uint8Array): this {
    this.chunks.push(data);
    this.length += data.length;
    return this;
  }

  string(value: string): this {
    return this.bytes(new TextEncoder().encode(value));
  }

  boolean(value: boolean): this {
    this.chunks.push(Uint8Array.of(value ? 1 : 0));
    this.length += 1;
    return this;
  }

  u8(value: number): this {
    assertInteger(value, 0, 0xff, 'u8');
    this.chunks.push(Uint8Array.of(value));
    this.length += 1;
    return this;
  }

  u16(value: number): this {
    assertInteger(value, 0, 0xffff, 'u16');
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, value, false);
    this.chunks.push(buf);
    this.length += 2;
    return this;
  }

  u32(value: number): this {
    assertInteger(value, 0, 0xffffffff, 'u32');
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value, false);
    this.chunks.push(buf);
    this.length += 4;
    return this;
  }

  /** Fixed-width 8-byte unsigned integer (satoshis-style amount field). */
  u64(value: bigint): this {
    assertBigInteger(value, 0n, (1n << 64n) - 1n, 'u64');
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, value, false);
    this.chunks.push(buf);
    this.length += 8;
    return this;
  }

  /** Fixed-width 16-byte unsigned integer — OBS base units (seals). */
  u128(value: bigint): this {
    assertBigInteger(value, 0n, (1n << 128n) - 1n, 'u128');
    const buf = new Uint8Array(16);
    let v = value;
    for (let i = 15; i >= 0; i -= 1) {
      buf[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.chunks.push(buf);
    this.length += 16;
    return this;
  }

  /** Signed 16-byte integer for oracle/price deltas. */
  i128(value: bigint): this {
    const min = -(1n << 127n);
    const max = (1n << 127n) - 1n;
    assertBigInteger(value, min, max, 'i128');
    const buf = new Uint8Array(16);
    const v = value < 0n ? (1n << 128n) + value : value;
    let tmp = v;
    for (let i = 15; i >= 0; i -= 1) {
      buf[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    this.chunks.push(buf);
    this.length += 16;
    return this;
  }

  /** Length-prefixed list of already-encoded items. */
  list(items: Uint8Array[]): this {
    this.u32(items.length);
    for (const item of items) this.bytes(item);
    return this;
  }

  bytesList(items: Uint8Array[]): this {
    this.u32(items.length);
    for (const item of items) this.bytes(item);
    return this;
  }

  stringList(items: string[]): this {
    this.u32(items.length);
    for (const item of items) this.string(item);
    return this;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export class Reader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset;
  }

  private take(n: number): Uint8Array {
    if (this.remaining < n) throw new Error('canonical encoding: unexpected end of data');
    const slice = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  bytes(): Uint8Array {
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4);
    const len = view.getUint32(0, false);
    this.offset += 4;
    return this.take(len);
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  boolean(): boolean {
    const b = this.take(1)[0];
    if (b !== 0 && b !== 1) throw new Error('canonical encoding: invalid boolean');
    return b === 1;
  }

  u8(): number {
    return this.take(1)[0];
  }

  u16(): number {
    const b = this.take(2);
    return new DataView(b.buffer, b.byteOffset, 2).getUint16(0, false);
  }

  u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
  }

  u64(): bigint {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, false);
  }

  u128(): bigint {
    const b = this.take(16);
    let out = 0n;
    for (const byte of b) out = (out << 8n) | BigInt(byte);
    return out;
  }

  i128(): bigint {
    const b = this.take(16);
    let out = 0n;
    for (const byte of b) out = (out << 8n) | BigInt(byte);
    if (out >= 1n << 127n) out -= 1n << 128n;
    return out;
  }

  list<T>(fn: (r: Reader) => T): T[] {
    const n = this.u32();
    const out: T[] = [];
    for (let i = 0; i < n; i += 1) out.push(fn(this));
    return out;
  }

  bytesList(): Uint8Array[] {
    return this.list((r) => r.bytes().slice());
  }

  stringList(): string[] {
    return this.list((r) => r.string());
  }

  ensureConsumed(): void {
    if (this.remaining !== 0) {
      throw new Error(`canonical encoding: ${this.remaining} trailing bytes`);
    }
  }
}

function assertInteger(value: number, min: number, max: number, kind: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`canonical encoding: value ${value} out of range for ${kind}`);
  }
}

function assertBigInteger(value: bigint, min: bigint, max: bigint, kind: string): void {
  if (typeof value !== 'bigint' || value < min || value > max) {
    throw new Error(`canonical encoding: value out of range for ${kind}`);
  }
}

/** Encode a schema-bound object via a callback that writes fields in order. */
export function encode(fn: (w: Writer) => void): Uint8Array {
  const w = new Writer();
  fn(w);
  return w.finish();
}
