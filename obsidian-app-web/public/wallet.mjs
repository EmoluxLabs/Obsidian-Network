/**
 * The bridge between the screens and the signing bundle.
 *
 * The bundle is generated (`npm run build:web`), and it is the only place in this
 * app that holds a key — so it is loaded lazily, on the first operation that needs
 * it, rather than on every page view. A visitor who only wants to read the chain
 * never downloads or executes the derivation code at all.
 *
 * Everything this module does is wiring. Protocol values come from data.mjs, which
 * reads them from the node; signing, encoding and the vault come from the bundle.
 * Nothing here decides an amount, a nonce, a chain id or an eligibility.
 */

import {
  getStatus,
  getNetwork,
  getNextNonce,
  getBalance,
  getMiningStatus,
  getName,
  getAppConfig,
  MIN_PASSPHRASE_LENGTH,
  submitTransaction,
} from './data.mjs';

const BUNDLE_URL = '/js/obsidian.js';

let bundlePromise = null;

/**
 * Load the signing bundle once.
 *
 * A missing bundle is one command away, and saying which command is the difference
 * between a broken app and a misconfigured one.
 */
export function loadBundle() {
  if (!bundlePromise) {
    bundlePromise = import(BUNDLE_URL).catch((error) => {
      bundlePromise = null;
      throw new Error(
        `The signing bundle is missing. Run: (cd obsidian-app-web && npm run build:web) — ${error.message}`,
      );
    });
  }
  return bundlePromise;
}

const api = () => loadBundle();

/** True when a sealed vault exists in this browser. Does not mean it can be opened. */
export async function hasWallet() {
  const { loadVault } = await api();
  return Boolean(loadVault());
}

/**
 * The address the vault holds, without loading the bundle.
 *
 * The Wallet & Mining screens need it on first paint, and forcing a 600 KB
 * crypto bundle onto a visitor who only wants to look at the chain would be a
 * poor trade — so this reads the cache directly. `web/vault.mjs` owns the key;
 * tests/design-contract.test.mjs asserts the two copies of it agree.
 */
const ADDRESS_KEY = 'obsidian.address';

export function cachedAddress() {
  try {
    return localStorage.getItem(ADDRESS_KEY) || null;
  } catch {
    return null;
  }
}

/** The address the vault holds. Loads the bundle, so only call it when signing. */
export async function walletAddress() {
  const { loadWalletAddress } = await api();
  return loadWalletAddress();
}

/** Decrypt the phrase and hand it back for display. Never stored, never sent. */
export async function revealPhrase(passphrase) {
  const { loadVault, openVault, PassphraseError } = await api();
  const vault = loadVault();
  if (!vault) throw new Error('No wallet is set up on this device yet.');
  try {
    return await openVault(vault, passphrase);
  } catch (error) {
    if (error instanceof PassphraseError) throw error;
    throw new Error(error?.message || 'That passphrase is not correct.');
  }
}

export async function walletKdf() {
  const { loadVault, PBKDF2_ITERATIONS } = await api();
  const vault = loadVault();
  return vault ? { iterations: vault.iterations ?? PBKDF2_ITERATIONS, kdf: vault.kdf } : null;
}

/**
 * Seal a recovery phrase into a vault on this device.
 *
 * The phrase is validated by the canonical BIP-39 word list before it is encrypted,
 * so a typo is caught here rather than on the first claim — and the address is
 * cached so the screens can show a balance without another decryption.
 */
export async function setupWallet({ phrase, passphrase }) {
  const { isValidPhrase, walletFromPhrase, createVault, saveVault, saveWalletAddress } = await api();
  if (!isValidPhrase(phrase)) throw new Error('That recovery phrase is not valid.');
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters. It encrypts the phrase on this device.`,
    );
  }
  const { addressHrp } = await getContext();
  const wallet = walletFromPhrase(phrase, addressHrp);
  const vault = await createVault(String(phrase).trim(), passphrase, addressHrp);
  saveVault(vault);
  saveWalletAddress(wallet.address);
  return { address: wallet.address };
}

/**
 * A new recovery phrase. The caller holds it in memory only until it is sealed or
 * discarded; this module neither stores nor sends it.
 */
export async function newPhrase() {
  const { generatePhrase } = await api();
  return generatePhrase();
}

/** The wallet's address as an SVG QR code. Only the address is encoded: no amount, no memo. */
export async function qrFor(address) {
  const { qrSvg } = await api();
  return qrSvg(address, `Obsidian address ${address}`);
}

/** Read a QR from camera or photo pixels ({ data, width, height }): the text, or null. */
export async function decodeFrame(image) {
  const { decodeQr } = await api();
  return decodeQr(image);
}

/**
 * What a scanned string means for this wallet on this network — see readScanned.
 * An address from another network, or one that fails its checksum, is refused.
 */
export async function interpretScan(text, { own } = {}) {
  const { readScanned } = await api();
  const { addressHrp } = await getContext();
  return readScanned(text, { hrp: addressHrp, own });
}

/** Derive the address for a phrase without keeping it. Used by "check a phrase". */
export async function addressForPhrase(phrase) {
  const { isValidPhrase, walletFromPhrase } = await api();
  if (!isValidPhrase(phrase)) throw new Error('That recovery phrase is not valid.');
  const { addressHrp } = await getContext();
  return walletFromPhrase(phrase, addressHrp).address;
}

/**
 * The cached address, expressed in the connected network's prefix.
 *
 * The cache is written once, under whatever network was live at the time. Point the
 * app at another network and that string is no longer an address the node accepts.
 * The payload is the same, though, so it is re-encoded in place — no passphrase, no
 * phrase — and the cache is updated so this runs once per network change.
 * Loads the bundle only when the prefix actually differs.
 */
export async function addressOnNetwork(address, hrp) {
  if (!address || !hrp || address.startsWith(`${hrp}1`)) return address || null;
  const { retargetAddress, saveWalletAddress } = await api();
  const converted = retargetAddress(address, hrp);
  saveWalletAddress(converted);
  return converted;
}

export async function removeWallet() {
  const { destroyVault } = await api();
  destroyVault();
}

// ── the dependency bundle every operation is handed ──────────────────────────

/**
 * Assemble the injected dependencies and call one operation by name.
 *
 * Injection is not ceremony: `web/ops.mjs` reaches the network and the key only
 * through these functions, so a test can supply a fake node and a fake vault and
 * prove the sequence without either.
 */
async function run(name, requestPassphrase, args) {
  const bundle = await api();
  const { addressHrp } = await getContext();
  const deps = {
    loadVault: bundle.loadVault,
    loadAddress: () => {
      const cached = bundle.loadWalletAddress();
      return cached && !cached.startsWith(`${addressHrp}1`) ? bundle.retargetAddress(cached, addressHrp) : cached;
    },
    requestPassphrase,
    getContext,
    getNonce,
    getMiningStatus,
    getBalance,
    getName,
    submit: (hex) => submitTransaction(hex),
  };
  return bundle[name](deps, args);
}

/**
 * The chain context a signature needs.
 *
 * Every value is the node's. `protocolTime` is the timestamp of the node's head
 * block, which is the only clock mining eligibility and transaction expiry are
 * measured against — this browser's wall clock is not consulted and would be wrong.
 */
export async function getContext() {
  const [status, network] = await Promise.all([getStatus(), getNetwork()]);
  const chainId = network?.network?.chainId ?? status?.chainId;
  const protocolTime = status?.lastBlockTimestamp ?? status?.timestamp;
  if (!Number.isFinite(Number(chainId))) {
    throw new Error('the node did not report a chain id');
  }
  if (!Number.isFinite(Number(protocolTime))) {
    throw new Error('the node did not report a protocol time');
  }
  const addressHrp = network?.network?.addressHrp;
  if (typeof addressHrp !== 'string' || !addressHrp) {
    // Not defaulted to 'obs': on any other network that would sign for, and display,
    // an address the node rejects as invalid.
    throw new Error('the node did not report its address prefix');
  }
  // The one place every signature and every derived address passes through, so the
  // one place the app's network is held against the node's. A testnet app in front of
  // a mainnet node would otherwise sign mainnet transactions without a word.
  const identity = await getAppConfig().catch(() => null);
  if (!identity) {
    throw new Error('This app could not confirm which network it is, so it will not sign. Nothing was signed.');
  }
  if (Number(chainId) !== identity.chainId || addressHrp !== identity.addressHrp) {
    throw new Error(
      `This is the ${identity.network} app, but the node it reached is on chain ${chainId} (${addressHrp}1…). Nothing was signed.`,
    );
  }
  return {
    chainId: Number(chainId),
    addressHrp,
    protocolTime: Number(protocolTime),
    protocolVersion: status?.protocolVersion ?? network?.protocolVersion ?? undefined,
    network: network?.network?.name ?? status?.network ?? null,
  };
}

/**
 * The nonce the next transaction must carry.
 *
 * Asked of the node, for the address that is about to sign, immediately before
 * signing. The balance route carries it too; it is the fallback for a node that
 * does not serve the dedicated route.
 */
export async function getNonce(address) {
  try {
    // The route answers { address, nextNonce, atHeight }, and is read under that
    // name. An earlier version destructured `nonce`, which this route never sends,
    // so it was silently ignored in favour of the balance route's figure. The two
    // currently agree (both are the committed account nonce); reading the dedicated
    // route keeps working if the balance shape changes. Note the node allows one
    // pending transaction per account and says so in its refusal, which is shown
    // to the user verbatim.
    const { nextNonce } = await getNextNonce(address);
    if (Number.isInteger(nextNonce)) return nextNonce;
  } catch {
    /* fall through to the balance route */
  }
  const balance = await getBalance(address);
  if (!Number.isInteger(balance?.nonce)) {
    throw new Error('the node did not report a nonce for this address');
  }
  return balance.nonce;
}

// ── operations ───────────────────────────────────────────────────────────────

export const claim = (requestPassphrase) => run('submitClaim', requestPassphrase);
export const send = (input, requestPassphrase) => run('submitPayment', requestPassphrase, input);
export const registerName = (input, requestPassphrase) => run('submitNameRegistration', requestPassphrase, input);
export const renewName = (input, requestPassphrase) => run('submitNameRenewal', requestPassphrase, input);
export const updateNameAddress = (input, requestPassphrase) => run('submitNameUpdate', requestPassphrase, input);
export const transferName = (input, requestPassphrase) => run('submitNameTransfer', requestPassphrase, input);

export { BUNDLE_URL, ADDRESS_KEY };
