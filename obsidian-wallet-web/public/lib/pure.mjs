/**
 * Pure helpers of the wallet screens: no DOM, no network, no storage.
 *
 * Everything here is a decision the screens must get right and a test can check without a browser: how an address
 * typed or scanned is accepted, how an amount is read and shown, how a history row is classified, what a submitted
 * transaction is called at each point of its life, and whether a file offered as a backup is worth decrypting.
 *
 * Money is never a float. Amounts are strings or BigInt seals (1 OBS = 10^18 seals); the parsing and the formatting
 * come from the web app's own data module, which is the one the rest of the product already uses.
 */

import { parseObs, sealsToObs } from '../js/shared/data.mjs';

// ── text ─────────────────────────────────────────────────────────────────────

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escape anything that is not ours before it goes into markup or an attribute. */
export const esc = (value) => String(value ?? '').replace(/[&<>"'`]/g, (c) => ESCAPES[c]);

// ── networks ─────────────────────────────────────────────────────────────────

export const NETWORK_OF_HRP = Object.freeze({ obs: 'mainnet', tobs: 'testnet', sobs: 'staging', dobs: 'devnet' });

/** Only mainnet carries coins with a market. Every other network is a place to try things. */
export const isTestNetwork = (name) => name !== 'mainnet';

// ── addresses ────────────────────────────────────────────────────────────────

/** The explorer's own masking, which is how every counterparty in the node's history arrives: first 10, last 6. */
export const maskAddress = (address) => {
  const a = String(address ?? '');
  return a.length <= 14 ? a : `${a.slice(0, 10)}…${a.slice(-6)}`;
};

/** A short form for a header or a list. Display only, never a value to send to. */
export const shortAddress = maskAddress;

/**
 * Read a recipient from text a person typed or a code carried.
 *
 * Only a bare address of THIS network is accepted. No scheme (`obsidian:`), no `.obs` name, nothing after a `?` or a
 * `#`, no spaces inside: a value that is "tolerated" is a value somebody can shape. The checksum is checked by the
 * protocol's own `readScanned` (handed in, because it lives in the signing bundle), never by a regular expression here.
 *
 * @param {string} raw
 * @param {{hrp: string, own?: string, readScanned: Function}} options
 * @returns {{ok: true, value: string} | {ok: false, message: string}}
 */
export function parseRecipient(raw, { hrp, own, readScanned }) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, message: 'Enter the address you want to pay.' };
  if (text.length > 120) return { ok: false, message: 'That is too long to be an Obsidian address.' };
  if (/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/u.test(text)) {
    return { ok: false, message: 'An address has no spaces or hidden characters in it. Paste it again.' };
  }
  if (/[:/?#@]/.test(text) || /\.obs$/i.test(text)) {
    return {
      ok: false,
      message: 'Paste a bare address that starts with ' + `${hrp}1. Names, links and payment links are not accepted here.`,
    };
  }
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) {
    return { ok: false, message: 'That address mixes upper and lower case, so it was copied wrongly.' };
  }
  const verdict = readScanned(text, { hrp, own });
  if (!verdict?.ok) return { ok: false, message: verdict?.message ?? 'That is not a valid address.' };
  if (verdict.kind !== 'address') return { ok: false, message: 'Paste a bare address, not a name.' };
  return { ok: true, value: verdict.value };
}

// ── amounts ──────────────────────────────────────────────────────────────────

/** Exact OBS text for seals: every digit the protocol holds, without trailing zeros. Never rounded. */
export function exactObs(seals) {
  const full = sealsToObs(seals, 18);
  if (full === '—') return '—';
  return full.includes('.') ? full.replace(/0+$/, '').replace(/\.$/, '') : full;
}

/**
 * A typed amount as seals.
 *
 * The text is decimal digits and at most one dot: no sign, no exponent, no thousands separators. More than 18
 * decimals is refused, never rounded; zero is refused.
 */
export function parseAmount(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, message: 'Enter an amount.' };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, message: 'Enter an amount like 0.5 or 12, with digits only.' };
  let seals;
  try {
    seals = parseObs(raw);
  } catch (error) {
    return { ok: false, message: error?.message ?? 'That is not an amount.' };
  }
  if (seals <= 0n) return { ok: false, message: 'The amount must be greater than zero.' };
  return { ok: true, seals, text: raw };
}

// ── history ──────────────────────────────────────────────────────────────────

const KIND_LABEL = {
  MINING_CLAIM: 'Mining reward',
  ORACLE: 'Oracle report',
};

const titleCase = (s) => s.toLowerCase().replace(/(^|_)([a-z])/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase());

/**
 * What one row of the node's address history means for `own`.
 *
 * The node masks every counterparty, so the direction is decided by comparing masks, and nothing here claims to know
 * a full address it was not given. A payment has no `kind`; anything with one (a mining claim, a name operation) is
 * not a transfer and is labelled as what the node says it is.
 */
export function classifyHistory(record, own) {
  const mask = maskAddress(own);
  const gas = /^\d+$/.test(String(record?.gas ?? '')) ? BigInt(record.gas) : 0n;
  const amount = /^\d+$/.test(String(record?.amount ?? '')) ? BigInt(record.amount) : null;
  const base = { txId: String(record?.txId ?? ''), height: record?.height ?? null, timestamp: record?.timestamp ?? null };
  const sentByMe = record?.sender === mask;
  const toMe = record?.recipient === mask;

  if (record?.kind) {
    const label = KIND_LABEL[record.kind] ?? (record.kind.startsWith('ONS_') ? `Name ${titleCase(record.kind.slice(4))}` : titleCase(record.kind));
    return { ...base, dir: record.kind === 'MINING_CLAIM' ? 'mining' : 'other', label, amount: null, gas: sentByMe ? gas : 0n, note: record.note ?? '' };
  }
  if (sentByMe && toMe) return { ...base, dir: 'self', label: 'Sent to yourself', amount, gas, counterparty: record.recipient };
  if (sentByMe) return { ...base, dir: 'sent', label: 'Sent', amount, gas, counterparty: record.recipient ?? '' };
  if (toMe) return { ...base, dir: 'received', label: 'Received', amount, gas: 0n, counterparty: record.sender ?? '' };
  return { ...base, dir: 'other', label: 'Transaction', amount, gas: 0n, counterparty: '' };
}

/** Confirmations of a transaction included at `height`, given the node's head. Null when either is unknown. */
export function confirmationsAt(height, head) {
  if (!Number.isInteger(height) || !Number.isInteger(head) || head < height) return null;
  return head - height + 1;
}

// ── the life of a submitted transaction ──────────────────────────────────────

/**
 * Names for what is actually known. A word is used only when the thing it names was observed:
 *
 *   prepared   the review was shown; nothing signed
 *   signed     signed on this device; the node has not been told
 *   submitted  the node answered the submission; it has not yet been seen in the mempool or a block
 *   pending    the node lists it in its mempool
 *   confirmed  a block holds it (with a count of confirmations)
 *   rejected   the node refused it when it was submitted
 *   failed     it could not be sent, and it is not known whether the node has it
 *   expired    its validity ended (by the chain's own clock) and it was never seen in a block
 */
export const TX_STATES = Object.freeze(['prepared', 'signed', 'submitted', 'pending', 'confirmed', 'rejected', 'failed', 'expired']);

/**
 * The next state of a transaction after looking at the node.
 *
 * @param {string} state the state so far
 * @param {{kind: 'confirmed', confirmations: number} | {kind: 'pending'} | {kind: 'missing'} | {kind: 'error'}} seen
 * @param {{validUntil: number, chainTime: number|null}} clock `validUntil` is the transaction's own, `chainTime` the head block's
 */
export function nextTxState(state, seen, { validUntil, chainTime }) {
  if (state === 'rejected') return { state, confirmations: null };
  if (seen.kind === 'confirmed') return { state: 'confirmed', confirmations: seen.confirmations ?? 1 };
  if (state === 'confirmed') return { state, confirmations: null }; // a lookup that failed or lagged does not un-confirm
  if (seen.kind === 'pending') return { state: 'pending', confirmations: 0 };
  if (seen.kind === 'missing') {
    // Not found is not the same as dropped: a node may not have it in its mempool yet, or a block may not be indexed.
    // It is only called expired once the chain's own clock has passed the transaction's validity.
    if (Number.isFinite(validUntil) && Number.isFinite(chainTime) && chainTime > validUntil) return { state: 'expired', confirmations: null };
    return { state: state === 'pending' ? 'pending' : state, confirmations: null, unseen: true };
  }
  return { state, confirmations: null, unreachable: true };
}

/** A transaction that can no longer change is not polled any more. */
export const isFinalState = (state) => state === 'confirmed' || state === 'rejected' || state === 'expired';

// ── what the node told us after a submit that failed ─────────────────────────

/**
 * A submit that did not succeed, in the user's words.
 *
 * A refusal by the node (a 4xx) means nothing was accepted and the same signed bytes will be refused again; any other
 * failure leaves it unknown whether the node has them, and the right move is to look, then re-send the SAME transaction.
 */
export function describeSubmitFailure({ refusedByNode, message }) {
  const said = String(message || 'the node did not say why');
  return refusedByNode
    ? { state: 'rejected', title: 'The node refused this transaction', detail: said }
    : { state: 'failed', title: 'The transaction was signed but may not have reached the node', detail: said };
}

// ── backups ──────────────────────────────────────────────────────────────────

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const BACKUP_LIMITS = Object.freeze({ maxBytes: 16 * 1024, minIterations: 100_000, maxIterations: 5_000_000 });

/**
 * Is this text an encrypted backup envelope worth trying a passphrase on?
 *
 * Checked before any key derivation, so a hostile file cannot make this page spend minutes deriving a key (a huge
 * iteration count) or hold a huge string. Only the envelope's known fields survive; anything else in the file is dropped.
 */
export function readBackup(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, message: 'Choose a backup file, or paste its contents.' };
  if (raw.length > BACKUP_LIMITS.maxBytes) return { ok: false, message: 'That is too large to be a wallet backup.' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'That is not a wallet backup file.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, message: 'That is not a wallet backup file.' };
  if (parsed.version !== 1) return { ok: false, message: 'This backup is from a version this wallet cannot open.' };
  if (parsed.kdf !== 'PBKDF2-SHA256') return { ok: false, message: 'This backup uses a key scheme this wallet cannot open.' };
  const { iterations } = parsed;
  if (!Number.isInteger(iterations) || iterations < BACKUP_LIMITS.minIterations || iterations > BACKUP_LIMITS.maxIterations) {
    return { ok: false, message: 'This backup has an unsafe key setting, so it was not opened.' };
  }
  for (const field of ['salt', 'iv', 'ciphertext']) {
    if (typeof parsed[field] !== 'string' || !parsed[field] || !B64.test(parsed[field])) {
      return { ok: false, message: 'This backup file is damaged.' };
    }
  }
  if (parsed.salt.length > 64 || parsed.iv.length > 32) return { ok: false, message: 'This backup file is damaged.' };
  return {
    ok: true,
    envelope: {
      version: 1,
      kdf: parsed.kdf,
      iterations,
      salt: parsed.salt,
      iv: parsed.iv,
      ciphertext: parsed.ciphertext,
      address: typeof parsed.address === 'string' ? parsed.address.slice(0, 120) : undefined,
      addressHrp: typeof parsed.addressHrp === 'string' ? parsed.addressHrp.slice(0, 8) : undefined,
      createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : undefined,
    },
  };
}

// ── passwords ────────────────────────────────────────────────────────────────

/**
 * A new password for the vault. The length rule is the vault's own (the bundle enforces it too; this is the earlier,
 * friendlier message). Nothing here judges "strength": a length is the only honest rule a form can enforce.
 */
export function checkNewPassword(password, confirm, minLength) {
  if (typeof password !== 'string' || password.length < minLength) {
    return { ok: false, message: `Use a password of at least ${minLength} characters. It encrypts your wallet on this device.` };
  }
  if (password !== confirm) return { ok: false, message: 'The two passwords do not match.' };
  return { ok: true };
}

/** A phrase as typed: case and spacing normalised, nothing else changed. */
export const normalisePhrase = (text) => String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');

// ── auto-lock ────────────────────────────────────────────────────────────────

/**
 * A lock that fires after `ms` without activity. Timers are injected so a test needs no waiting.
 */
export function createIdleLock({ ms, onLock, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let handle = null;
  const stop = () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
  };
  return {
    touch() {
      stop();
      handle = setTimer(() => {
        handle = null;
        onLock();
      }, ms);
    },
    stop,
    get armed() {
      return handle !== null;
    },
  };
}

/** After repeated wrong passwords the unlock waits, so a held-down Enter key is not a guessing machine. */
export const unlockDelaySeconds = (failures) => (failures < 3 ? 0 : Math.min(60, 2 ** (failures - 2)));

// ── the local record of what this device submitted ───────────────────────────

export const SUBMITTED_KEY = 'obsidian.wallet.submitted.v1';
const MAX_RECORDS = 30;

/** A record keeps only what the screens need: no key, no signature, no password, no signed bytes. */
export function sanitiseRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (!/^[0-9a-f]{64}$/.test(String(record.txId))) return null;
  const digits = (v) => (/^\d{1,40}$/.test(String(v)) ? String(v) : null);
  const amount = digits(record.amount);
  const gas = digits(record.gas);
  if (amount === null || gas === null) return null;
  if (typeof record.to !== 'string' || record.to.length > 120 || typeof record.from !== 'string' || record.from.length > 120) return null;
  if (!Number.isFinite(record.validUntil) || !Number.isFinite(record.submittedAt)) return null;
  return {
    txId: record.txId,
    from: record.from,
    to: record.to,
    amount,
    gas,
    validUntil: Number(record.validUntil),
    submittedAt: Number(record.submittedAt),
    state: TX_STATES.includes(record.state) ? record.state : 'submitted',
  };
}

export function readRecords(storage, own) {
  try {
    const list = JSON.parse(storage.getItem(SUBMITTED_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list.map(sanitiseRecord).filter((r) => r && r.from === own).slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function writeRecords(storage, own, mine) {
  let others = [];
  try {
    const list = JSON.parse(storage.getItem(SUBMITTED_KEY) || '[]');
    if (Array.isArray(list)) others = list.map(sanitiseRecord).filter((r) => r && r.from !== own);
  } catch {
    others = [];
  }
  const kept = [...mine.map(sanitiseRecord).filter(Boolean), ...others].slice(0, MAX_RECORDS);
  storage.setItem(SUBMITTED_KEY, JSON.stringify(kept));
}
