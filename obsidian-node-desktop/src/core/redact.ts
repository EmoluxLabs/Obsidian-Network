/**
 * Redaction for anything the app shows, stores or exports as a log or diagnostic.
 *
 * The node already redacts its own structured logs (src/security/logger.ts). This is a
 * second line of defence for everything else: stderr from a crashing process, error
 * messages, and the diagnostic bundle. It is deliberately conservative: it removes what
 * could grant control of funds or of the node identity, and the user's home path.
 */
import { homedir } from 'node:os';

const SECRET_KEY = /(private[_-]?key|secret|seed|mnemonic|recovery[_-]?phrase|phrase|passphrase|password|token|authorization|cookie|api[_-]?key|credential)/i;

/** Twelve or more lowercase words in a row looks like a recovery phrase. */
const PHRASE_RUN = /\b(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\b/g;
const KEYED_HEX = /((?:private[_-]?key|secret|seed)["'\s:=]+)[0-9a-fA-F]{64}\b/gi;
const KEYED_VALUE = /((?:passphrase|password|token|authorization)["'\s:=]+)(?:Bearer\s+)?[^\s"',;}]+/gi;

export function redactText(input: string, home: string = safeHome()): string {
  let out = input;
  out = out.replace(PHRASE_RUN, '[redacted recovery phrase]');
  out = out.replace(KEYED_HEX, '$1[redacted]');
  out = out.replace(KEYED_VALUE, '$1[redacted]');
  if (home && home.length > 3) out = out.split(home).join('~');
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function safeHome(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}
