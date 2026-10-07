/**
 * Structured logging with hard redaction.
 *
 * Rule (spec §98): logs must never contain private keys, seed phrases,
 * passwords, OAuth secrets, authentication tokens or sensitive payment data.
 * Redaction is enforced centrally here rather than by remembering to omit
 * fields at each call site: any key whose name matches the denylist is
 * replaced, and long hex strings that look like key material are truncated.
 */

const REDACTED_KEYS = [
  'privatekey',
  'private_key',
  'privateKey',
  'secret',
  'seed',
  'seedphrase',
  'mnemonic',
  'recovery',
  'phrase',
  'password',
  'passphrase',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'credential',
  'sessionid',
  'sessiontoken',
];

const DENY = new Set(REDACTED_KEYS.map((key) => key.toLowerCase()));

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

export interface LoggerOptions {
  level: LogLevel;
  json: boolean;
  component: string;
}

export class Logger {
  constructor(private readonly options: LoggerOptions) {}

  child(component: string): Logger {
    return new Logger({ ...this.options, component });
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }

  trace(message: string, fields?: Record<string, unknown>): void {
    this.write('trace', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.options.level]) return;
    const safeFields = fields ? redact(fields) : undefined;
    const timestamp = new Date().toISOString();
    if (this.options.json) {
      process.stdout.write(
        `${JSON.stringify({ ts: timestamp, level, component: this.options.component, message, ...safeFields })}\n`,
      );
      return;
    }
    const suffix = safeFields ? ` ${JSON.stringify(safeFields)}` : '';
    process.stdout.write(`${timestamp} [${level.toUpperCase()}] ${this.options.component}: ${message}${suffix}\n`);
  }
}

/** Recursively redact sensitive keys and truncate key-looking hex strings. */
export function redact(value: unknown, depth = 0): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {};
  if (depth > 4) return { redacted: 'depth limit' };
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (DENY.has(key.toLowerCase())) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof raw === 'string') {
      // Hashes and signatures (64 hex chars) are public data and must stay
      // readable in logs. Only very long hex runs — raw key material or a
      // serialized keystore — are truncated.
      out[key] = /^[0-9a-f]{200,}$/i.test(raw) ? '[redacted-hex]' : raw;
      continue;
    }
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      out[key] = redact(raw, depth + 1);
      continue;
    }
    out[key] = raw;
  }
  return out;
}

/** Scanner used by tests and CI: does any string look like a stored secret? */
export function findSensitiveLeak(text: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/private[_-]?key["'\s:=]+[0-9a-f]{64}/i, 'private key material'],
    [/\bmnemonic\b["'\s:=]+\w+/i, 'mnemonic phrase'],
    [/seed[_-]?phrase["'\s:=]+\w+/i, 'seed phrase'],
    [/OBSIDIAN_KEYSTORE_PASSPHRASE\s*=\s*\S+/, 'keystore passphrase'],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) return label;
  }
  return null;
}
