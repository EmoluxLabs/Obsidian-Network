/**
 * Recipient resolution — turning what a user typed into the one address a PAYMENT pays.
 *
 * A PAYMENT carries an address and nothing else: the node's executor runs
 * `assertAddress(to)` on it, so a `.obs` name written into that field is refused as an
 * invalid address. A name therefore has to become an address BEFORE the transaction is
 * built, and the mapping is chain state — the ONS record the node serves on
 * `GET /names/:name`. Nothing here invents a lookup: it asks that route, and it trusts
 * nothing the route says until it has been checked.
 *
 * The function is pure. It performs no I/O of its own; every surface (the platform, the
 * web app and the extension, the wallet, the desktop app) hands it the three reads it
 * needs, so one implementation serves all of them and a test can feed it any answer.
 *
 * What it refuses, and why each is its own failure:
 *   NAME_INVALID        not a name the ONS rules allow — the node is never asked.
 *   NAME_NOT_FOUND      the node answered "name not registered" (404): nobody holds this name.
 *   LOOKUP_UNAVAILABLE  timeout, transport error, 5xx, unknown route, no chain identity:
 *                       the answer is unknown, so nothing is guessed.
 *   MALFORMED_RECORD    the answer is not a record for the name that was asked about.
 *   NETWORK_MISMATCH    the node is on another chain, or the record holds another
 *                       network's address.
 *   NAME_EXPIRED        the node does not report expiry state, and an expired name can be
 *                       re-registered by anyone, so its old address is no longer trusted.
 *   INVALID_ADDRESS     the record's address is not a valid address for this network.
 *
 * It never decides a recipient from the spelling of a name, and it never falls back.
 */

import { isValidAddress } from '../crypto/keys.js';
import { normalizeName, validateNameFormat } from '../transactions/executors/ons.js';

export type RecipientKind = 'empty' | 'name' | 'address';

export type ResolutionFailureCode =
  | 'NAME_INVALID'
  | 'NAME_NOT_FOUND'
  | 'LOOKUP_UNAVAILABLE'
  | 'MALFORMED_RECORD'
  | 'NETWORK_MISMATCH'
  | 'NAME_EXPIRED'
  | 'INVALID_ADDRESS';

export interface NodeContext {
  chainId: number;
  addressHrp: string;
  /** Timestamp of the node's head block — the clock registration and expiry use. */
  protocolTime: number;
}

export interface ExpectedNetwork {
  chainId: number;
  addressHrp: string;
}

export interface ResolveDeps {
  /** `GET /names/<name>` — rejects with an error carrying `status` and/or `code`. */
  lookup(name: string): Promise<unknown>;
  /** The node's own view: chain id, address prefix and head-block time. */
  context(): Promise<NodeContext>;
  /** What THIS app is: the network it was built and configured for. */
  expected(): Promise<ExpectedNetwork>;
  /** Per-read ceiling. A read that outlives it is "unavailable", never an answer. */
  timeoutMs?: number;
}

export interface Resolved {
  ok: true;
  /** The normalised name, with its suffix: `obsidian.obs`. */
  name: string;
  /** The registered address — the only value a transaction may use. */
  address: string;
  expiresAt: number;
  network: ExpectedNetwork;
}

export interface ResolutionFailure {
  ok: false;
  code: ResolutionFailureCode;
  message: string;
}

export type Resolution = Resolved | ResolutionFailure;

export const DEFAULT_LOOKUP_TIMEOUT_MS = 8000;

const NETWORK_LABEL: Record<string, string> = {
  obs: 'Obsidian Mainnet',
  tobs: 'Obsidian Testnet',
  sobs: 'Obsidian Staging',
  dobs: 'Obsidian Devnet',
};

/** The network's short name for messages: Mainnet, Testnet… */
export function networkShortName(addressHrp: string): string {
  const label = NETWORK_LABEL[addressHrp];
  return label ? label.replace('Obsidian ', '') : addressHrp;
}

export function networkLabel(addressHrp: string): string {
  return NETWORK_LABEL[addressHrp] ?? addressHrp;
}

/** The message a person reads for each failure. Fixed text: nothing the node sent is echoed. */
export function failureMessage(code: ResolutionFailureCode, addressHrp = 'obs'): string {
  switch (code) {
    case 'NAME_NOT_FOUND':
      return `ONS name not found on ${networkShortName(addressHrp)}.`;
    case 'LOOKUP_UNAVAILABLE':
      return 'Could not resolve this ONS name. Please try again.';
    case 'INVALID_ADDRESS':
      return 'ONS name resolved to an invalid OBS address. Transaction blocked.';
    case 'NAME_INVALID':
      return 'That is not a valid ONS name. Use 3–63 letters, numbers or interior hyphens, then .obs.';
    case 'MALFORMED_RECORD':
      return 'The ONS lookup returned an unusable answer. Transaction blocked.';
    case 'NETWORK_MISMATCH':
      return `ONS lookup came from a different network than ${networkLabel(addressHrp)}. Transaction blocked.`;
    case 'NAME_EXPIRED':
      return 'This ONS name has expired, so its address is no longer trusted. Transaction blocked.';
  }
}

const fail = (code: ResolutionFailureCode, addressHrp: string): ResolutionFailure => ({
  ok: false,
  code,
  message: failureMessage(code, addressHrp),
});

/**
 * What did the user type: nothing, a `.obs` name, or something to treat as an address?
 *
 * Only text ending in `.obs` is a name; anything else — including a bare word with no
 * suffix — stays on the address path and meets the address validator unchanged.
 */
export function recipientKind(raw: unknown): RecipientKind {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return 'empty';
  return text.toLowerCase().endsWith('.obs') ? 'name' : 'address';
}

/** The normalised name (`label.obs`) if `raw` meets the ONS rules, else null. */
export function parseOnsName(raw: unknown): string | null {
  if (recipientKind(raw) !== 'name') return null;
  const label = normalizeName(String(raw));
  try {
    validateNameFormat(label);
  } catch {
    return null;
  }
  return `${label}.obs`;
}

function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    let started: Promise<T>;
    try {
      started = work();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    started.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Only the node's own "nobody holds this name" answer is "not found".
 *
 * The node answers 404 ERR_NOT_FOUND for an unregistered name ("name not registered") and
 * also for a route it does not serve ("not found"). The second is a node that cannot answer
 * the question, and reading it as "unregistered" would tell a person a name is free when the
 * lookup never ran — so the message is part of the test, and the doubt resolves to
 * "unavailable".
 */
function isNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.status === 404 &&
    error.code === 'ERR_NOT_FOUND' &&
    typeof error.message === 'string' &&
    error.message.toLowerCase().includes('name not registered')
  );
}

/** The network a bech32-style address claims, by prefix; null if it claims none we know. */
function claimedPrefix(address: string): string | null {
  const match = /^(obs|tobs|sobs|dobs)1/.exec(address);
  return match ? match[1]! : null;
}

/**
 * Resolve a `.obs` name to the native address registered for it on this network.
 *
 * Reads the name record and the node's context together; checks, in this order, the
 * identity of the chain, the shape of the record, the expiry and the address. The first
 * check to fail is the one reported.
 */
export async function resolveOnsName(raw: string, deps: ResolveDeps): Promise<Resolution> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;

  let expected: ExpectedNetwork;
  try {
    expected = await withTimeout(() => deps.expected(), timeoutMs);
  } catch {
    // This app cannot say which network it is, so no answer can be held against it.
    return fail('LOOKUP_UNAVAILABLE', 'obs');
  }
  const hrp = typeof expected?.addressHrp === 'string' ? expected.addressHrp : 'obs';
  if (!isRecord(expected) || !Number.isSafeInteger(expected.chainId) || !expected.addressHrp) {
    return fail('LOOKUP_UNAVAILABLE', hrp);
  }

  const name = parseOnsName(raw);
  if (!name) return fail('NAME_INVALID', hrp);

  const [recordRead, contextRead] = await Promise.allSettled([
    withTimeout(() => deps.lookup(name), timeoutMs),
    withTimeout(() => deps.context(), timeoutMs),
  ]);

  // 1. Which chain answered? Without this, a node on another network would be believed.
  if (contextRead.status === 'rejected') return fail('LOOKUP_UNAVAILABLE', hrp);
  const context = contextRead.value;
  if (
    !isRecord(context) ||
    !Number.isSafeInteger(context.chainId) ||
    typeof context.addressHrp !== 'string' ||
    !Number.isSafeInteger(context.protocolTime)
  ) {
    return fail('LOOKUP_UNAVAILABLE', hrp);
  }
  if (context.chainId !== expected.chainId || context.addressHrp !== expected.addressHrp) {
    return fail('NETWORK_MISMATCH', hrp);
  }

  // 2. Did the lookup answer? 404 is the node saying "nobody holds this name"; anything
  //    else that went wrong is "unknown" and is never reported as "not registered".
  if (recordRead.status === 'rejected') {
    return isNotFound(recordRead.reason) ? fail('NAME_NOT_FOUND', hrp) : fail('LOOKUP_UNAVAILABLE', hrp);
  }
  const record = recordRead.value;

  // 3. Is it a record for the name that was asked about?
  if (
    !isRecord(record) ||
    typeof record.name !== 'string' ||
    record.name.toLowerCase() !== name ||
    record.resolved === false ||
    typeof record.address !== 'string' ||
    !Number.isSafeInteger(record.expiresAt)
  ) {
    return fail('MALFORMED_RECORD', hrp);
  }
  const address = record.address;
  const expiresAt = record.expiresAt as number;

  // 4. An address for another network is a network failure, not a typo.
  const prefix = claimedPrefix(address);
  if (prefix !== null && prefix !== expected.addressHrp) return fail('NETWORK_MISMATCH', hrp);

  // 5. Expired names: consensus lets anyone re-register `expiresAt <= protocolTime`.
  if (expiresAt <= context.protocolTime) return fail('NAME_EXPIRED', hrp);

  // 6. The same validator every native address goes through, with this network's prefix,
  //    and nothing that is not already in canonical lowercase.
  if (address !== address.toLowerCase() || !isValidAddress(address, expected.addressHrp)) {
    return fail('INVALID_ADDRESS', hrp);
  }

  return {
    ok: true,
    name,
    address,
    expiresAt,
    network: { chainId: expected.chainId, addressHrp: expected.addressHrp },
  };
}

/**
 * Ask again, immediately before signing, and require the same answer.
 *
 * The record can change between the screen the user confirmed and the click that signs —
 * its owner can point the name at a new address, or let it lapse. A confirmed name is
 * therefore resolved afresh and compared with what was shown; any difference is a
 * failure and nothing is signed. (A PAYMENT cannot carry the name, so this narrows the
 * window to one round trip; it cannot close it.)
 */
export async function reconfirmOnsName(confirmed: Resolved, deps: ResolveDeps): Promise<Resolution> {
  const again = await resolveOnsName(confirmed.name, deps);
  if (!again.ok) return again;
  if (again.address !== confirmed.address) {
    return {
      ok: false,
      code: 'MALFORMED_RECORD',
      message: 'This ONS name now resolves to a different address than the one you confirmed. Nothing was sent. Review it again.',
    };
  }
  return again;
}
