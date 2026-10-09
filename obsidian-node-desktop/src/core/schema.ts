/**
 * Minimal runtime validation for data that crosses a trust boundary (node RPC responses,
 * renderer IPC payloads, files on disk). A value either has the declared shape or the
 * check throws a SchemaError that names the offending path.
 */

export class SchemaError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'SchemaError';
  }
}

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rec(value: unknown, path: string): Json {
  if (!isRecord(value)) throw new SchemaError(path, 'expected an object');
  return value;
}

export function str(value: unknown, path: string, max = 4096): string {
  if (typeof value !== 'string') throw new SchemaError(path, 'expected a string');
  if (value.length > max) throw new SchemaError(path, `string longer than ${max} characters`);
  return value;
}

export function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SchemaError(path, 'expected a finite number');
  return value;
}

export function int(value: unknown, path: string, min = Number.MIN_SAFE_INTEGER): number {
  const n = num(value, path);
  if (!Number.isInteger(n) || n < min) throw new SchemaError(path, `expected an integer >= ${min}`);
  return n;
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new SchemaError(path, 'expected a boolean');
  return value;
}

export function arr(value: unknown, path: string, maxLength = 5000): unknown[] {
  if (!Array.isArray(value)) throw new SchemaError(path, 'expected an array');
  if (value.length > maxLength) throw new SchemaError(path, `array longer than ${maxLength}`);
  return value;
}

export function optStr(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : str(value, path);
}

export function optInt(value: unknown, path: string): number | undefined {
  return value === undefined || value === null ? undefined : int(value, path);
}

/** A decimal OBS amount as the node prints it ("20000.000000000000000000"). */
export function obsAmount(value: unknown, path: string): string {
  const text = str(value, path, 64);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new SchemaError(path, 'expected a decimal amount');
  return text;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const text = str(value, path, 64);
  if (!(allowed as readonly string[]).includes(text)) throw new SchemaError(path, `expected one of ${allowed.join(', ')}`);
  return text as T;
}
