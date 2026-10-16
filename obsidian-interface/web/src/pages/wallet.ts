/**
 * Wallet.
 *
 * Create, back up, receive, send. The vault is encrypted in the browser with the
 * user's passphrase (PBKDF2-SHA256 → AES-256-GCM) and the private key is only
 * held in memory while the tab is unlocked. Nothing here ever posts key
 * material — the interface server would reject it, and the protocol never needs it.
 *
 * Addresses are network-specific. This page asks the connected node which
 * network it serves and derives for THAT network, rather than assuming
 * mainnet; a vault created elsewhere is detected and can be re-derived in
 * place, because the keys are identical and only the prefix differs.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { MIN_VAULT_PASSPHRASE_LENGTH, Wallet, exportBundle, hrpOfAddress, previewAddress, InsecureContextError, webCryptoAvailable } from '../lib/wallet.js';
import { operations, resolverDeps } from '../lib/operations.js';
import { networkLabel, reconfirmOnsName, recipientKind, resolveOnsName, type Resolved } from '../../core/protocol/recipient.js';
import { parseObs } from '../../core/protocol/amount.js';
import { displaySeals, EXACT_OBS } from '../../core/protocol/display.js';
import { el, amountEl, shortId, kv, spinner, toast, copyButton, download, badge, when } from '../lib/ui.js';
import { identifier } from '../lib/identifier.js';

const client = new ObsidianClient();
const panel = el('section', { class: 'card', id: 'wallet-panel' }, spinner('opening vault…'));

/**
 * Which network the connected node serves. Resolved once, before anything is
 * derived: creating a wallet against the wrong prefix produces an address that
 * network will refuse, which is worse than refusing to create one.
 */
let network: { name: string; chainId: number; addressHrp: string } | undefined;

const NETWORK_LABEL: Record<string, string> = {
  obs: 'mainnet',
  tobs: 'testnet',
  sobs: 'staging',
  dobs: 'devnet',
};

function networkName(hrp: string): string {
  return NETWORK_LABEL[hrp] ?? hrp;
}

layout({
  current: 'wallet',
  title: 'Wallet',
  tagline: 'A key pair generated in this browser. Obsidian never sees it, cannot freeze it and cannot recover it.',
  children: [
    el(
      'section',
      { class: 'notice' },
      el('strong', {}, 'Read this once. '),
      'Your private key and recovery phrase are the wallet. They are never sent to Obsidian, never stored on the interface server, never logged. ' +
        'If you lose both the file and the phrase, the OBS is gone — that is what non-custodial means. Nobody can reverse a transfer, here or anywhere else.',
    ),
    panel,
  ],
});

void boot();

async function boot(): Promise<void> {
  try {
    network = (await client.network()).network;
  } catch (error) {
    panel.replaceChildren(
      el('h2', {}, 'Wallet'),
      el('p', { class: 'error' }, `Cannot reach a node, so this page does not know which network it is on: ${(error as Error).message}`),
      el('p', { class: 'fineprint' }, 'A wallet is not created blind. An address derived for the wrong network is refused by every node on it, and that is not a mistake worth making silently.'),
    );
    return;
  }
  // A page opened over plain HTTP at a LAN address has no WebCrypto, so nothing
  // below could work. Say so before anyone types a passphrase into a form.
  if (!webCryptoAvailable()) {
    panel.replaceChildren(
      el('h2', {}, 'Wallet'),
      el('p', { class: 'error', id: 'insecure-context' }, new InsecureContextError().message),
    );
    return;
  }
  if (!Wallet.exists()) {
    drawCreate();
    return;
  }
  const address = Wallet.storedAddress();
  if (address) drawUnlock(address);
}

/** Banner shown when the vault in this browser belongs to another network. */
function networkMismatchNotice(vaultHrp: string): HTMLElement {
  return el(
    'div',
    { class: 'notice danger' },
    el('strong', {}, `This wallet is a ${networkName(vaultHrp)} wallet, but this interface is on ${networkName(network!.addressHrp)}. `),
    `Its address starts "${vaultHrp}1", and ${networkName(network!.addressHrp)} nodes only accept addresses starting "${network!.addressHrp}1" — they will answer "not a valid address for this network". ` +
      'Your keys are fine: the same 24 words produce the same key pair on every Obsidian network, and only the address prefix differs. Unlock below and re-derive in place.',
  );
}

// ── Creation ────────────────────────────────────────────────────────────────

function drawCreate(): void {
  const passphrase = el('input', { type: 'password', id: 'passphrase', placeholder: `Passphrase (min ${MIN_VAULT_PASSPHRASE_LENGTH} characters — a few words is best)`, autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', id: 'passphrase-confirm', placeholder: 'Repeat passphrase', autocomplete: 'new-password' });
  const output = el('div', { id: 'create-output' });

  const create = el('button', { class: 'primary', type: 'button', id: 'create' }, 'Generate wallet');
  create.addEventListener('click', async () => {
    if (passphrase.value.length < MIN_VAULT_PASSPHRASE_LENGTH) return toast(`Use at least ${MIN_VAULT_PASSPHRASE_LENGTH} characters for the passphrase.`, 'error');
    if (passphrase.value !== confirm.value) return toast('The two passphrases do not match.', 'error');
    create.disabled = true;
    try {
      const created = await Wallet.create(network!.addressHrp, passphrase.value);
      reveal(created, passphrase.value);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      create.disabled = false;
    }
  });

  const restore = el('button', { class: 'ghost', type: 'button', id: 'restore' }, 'Restore from recovery phrase');
  restore.addEventListener('click', () => drawRestore());
  const restoreKey = el('button', { class: 'ghost', type: 'button', id: 'restore-key' }, 'Restore from private key');
  restoreKey.addEventListener('click', () => drawRestoreKey());

  panel.replaceChildren(
    el('h2', {}, 'Create a wallet'),
    el(
      'p',
      {},
      'The key is produced by the browser\'s cryptographic random generator on this device. It is not derived from your email, your Google account, your username or anything else — it is 256 bits of entropy behind a 24-word phrase.',
    ),
    el('div', { class: 'field' }, el('label', { for: 'passphrase' }, 'Vault passphrase'), passphrase),
    el('div', { class: 'field' }, el('label', { for: 'passphrase-confirm' }, 'Confirm'), confirm),
    el('div', { class: 'row' }, create, restore, restoreKey),
    el('p', { class: 'fineprint' }, 'The passphrase encrypts the vault file inside this browser. It is not a password for any server, and there is no "forgot passphrase" — by design.'),
    output,
  );
}

function reveal(wallet: Wallet, passphrase: string): void {
  // Restoring replaces the whole panel, so the backup view gets a fresh container instead of silently showing nothing.
  if (!document.getElementById('create-output')) panel.replaceChildren(el('h2', {}, 'Your wallet'), el('div', { id: 'create-output' }));
  const output = document.getElementById('create-output');
  if (!output) return;
  const phraseBox = wallet.hasPhrase
    ? el('textarea', { class: 'phrase', readonly: 'readonly', rows: '3', id: 'phrase' }, wallet.revealPhrase())
    : el('p', { class: 'fineprint', id: 'no-phrase' }, 'This wallet was restored from a private key, so it has no recovery phrase. The private key below is the only way to restore it.');
  const keyBox = el('input', { class: 'mono', readonly: 'readonly', id: 'private-key', value: wallet.revealPrivateKey(0) });
  const bundle = exportBundle(wallet);

  // The way on is hidden until the person says, explicitly, that the backup is done.
  const next = el('div', { class: 'row', id: 'next-steps', hidden: 'hidden' }, anchor('/mine/', 'Mine with this wallet', 'primary'), anchor('/wallet/', 'Go to wallet', 'ghost'));
  const saved = el('input', { type: 'checkbox', id: 'backup-saved' }) as HTMLInputElement;
  saved.addEventListener('change', () => {
    if (saved.checked) next.removeAttribute('hidden');
    else next.setAttribute('hidden', 'hidden');
  });
  const savedGate = el(
    'div',
    {},
    el('label', { class: 'check', for: 'backup-saved' }, saved, wallet.hasPhrase ? ' I have written down my recovery phrase and my private key and stored them safely' : ' I have written down my private key and stored it safely'),
    next,
  );

  output.replaceChildren(
    el('hr'),
    el('h3', {}, 'Back up now'),
    el('p', {}, wallet.hasPhrase
      ? 'Write BOTH the recovery phrase and the private key on paper. Each one restores this same wallet on any device, in any Obsidian interface, forever. Keep them offline and apart from your devices.'
      : 'Write the private key on paper and keep it offline, apart from your devices.'),
    phraseBox,
    ...(wallet.hasPhrase ? [el('div', { class: 'row' }, copyButton(() => wallet.revealPhrase(), 'Copy phrase'))] : []),
    el('h3', {}, 'Private key'),
    keyBox,
    el('div', { class: 'row' }, copyButton(() => wallet.revealPrivateKey(0), 'Copy private key'), downloadButton()),
    kv([
      ['Address', identifier(wallet.address, { kind: 'address', detail: true, label: 'Wallet address' })],
      ['Network', `${networkName(wallet.addressHrp)} — addresses start "${wallet.addressHrp}1"`],
      ['Derivation path', el('span', { class: 'mono' }, "m/44'/7777'/0'/0/0")],
      ['Created', when(Math.floor(Date.now() / 1000))],
    ]),
    el(
      'p',
      { class: 'fineprint' },
      'The 24 words are not tied to a network. On another Obsidian network the same words give the same keys with a different address prefix, so keep the words, not the address string.',
    ),
    el(
      'p',
      { class: 'fineprint' },
      'Anyone who reads this screen owns the wallet. Obsidian support will never ask for the phrase or the private key, and this interface has no code path that could transmit them.',
    ),
    savedGate,
  );

  function downloadButton(): HTMLElement {
    const button = el('button', { class: 'ghost', type: 'button' }, 'Download key file');
    button.addEventListener('click', () => download(`obsidian-wallet-${wallet.address.slice(-8)}.txt`, bundle));
    return button;
  }

  void passphrase;
}

function drawRestore(): void {
  const phrase = el('textarea', { class: 'phrase', rows: '3', id: 'restore-phrase', placeholder: '24 words separated by spaces' });
  const passphrase = el('input', { type: 'password', id: 'restore-passphrase', placeholder: 'New vault passphrase' });
  const go = el('button', { class: 'primary', type: 'button' }, 'Restore wallet');
  go.addEventListener('click', async () => {
    if (passphrase.value.length < MIN_VAULT_PASSPHRASE_LENGTH) return toast(`Use at least ${MIN_VAULT_PASSPHRASE_LENGTH} characters for the passphrase.`, 'error');
    go.disabled = true;
    try {
      const restored = await Wallet.fromPhrase(phrase.value.trim(), network!.addressHrp, passphrase.value);
      toast('Wallet restored.', 'success');
      reveal(restored, passphrase.value);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      go.disabled = false;
    }
  });
  panel.replaceChildren(
    el('h2', {}, 'Restore from a recovery phrase'),
    el('p', {}, 'The phrase is checked against the BIP-39 wordlist and the checksum before anything is stored.'),
    phrase,
    el('div', { class: 'field' }, passphrase),
    el('div', { class: 'row' }, go),
    el('p', { class: 'fineprint' }, 'Restoring overwrites the vault in this browser. Export the current one first if you still need it.'),
  );
}

/**
 * Recovery from a private key, in two steps. Step one validates the pasted key on this device and shows the address
 * it controls; nothing is stored and an invalid key creates nothing. Step two (after the person confirms the address)
 * asks for a new vault passphrase and seals the wallet.
 */
function drawRestoreKey(): void {
  const keyInput = el('input', { type: 'password', class: 'mono', id: 'restore-key-input', placeholder: 'Private key — 64 hexadecimal characters', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const check = el('button', { class: 'primary', type: 'button', id: 'check-key' }, 'Check this key');
  check.addEventListener('click', () => {
    const found = Wallet.addressForPrivateKey(keyInput.value, network!.addressHrp);
    if (!found.ok) return toast(found.message, 'error'); // the reason never contains the key; nothing was created
    const typed = keyInput.value;
    keyInput.value = '';
    drawConfirmKey(typed, found.address);
  });
  panel.replaceChildren(
    el('h2', {}, 'Restore from a private key'),
    el('p', {}, 'The key is checked on this device only — it is never sent anywhere and never shown again. A recovery phrase is not accepted here, and a public key cannot restore a wallet.'),
    el('div', { class: 'field' }, el('label', { for: 'restore-key-input' }, 'Private key'), keyInput),
    el('div', { class: 'row' }, check),
    el('p', { class: 'fineprint' }, 'The address this key controls is shown next, for you to confirm before anything is saved. Restoring overwrites the vault in this browser.'),
  );
}

function drawConfirmKey(typed: string, address: string): void {
  const passphrase = el('input', { type: 'password', id: 'restore-key-passphrase', placeholder: 'New vault passphrase', autocomplete: 'new-password' }) as HTMLInputElement;
  const confirmed = el('input', { type: 'checkbox', id: 'address-confirmed' }) as HTMLInputElement;
  const go = el('button', { class: 'primary', type: 'button', id: 'seal-key' }, 'Restore wallet');
  go.addEventListener('click', async () => {
    if (!confirmed.checked) return toast('Confirm that this is your address first.', 'error');
    if (passphrase.value.length < MIN_VAULT_PASSPHRASE_LENGTH) return toast(`Use at least ${MIN_VAULT_PASSPHRASE_LENGTH} characters for the passphrase.`, 'error');
    go.disabled = true;
    try {
      const restored = await Wallet.fromPrivateKey(typed, network!.addressHrp, passphrase.value);
      if (restored.address !== address) throw new Error('The restored address does not match the one you confirmed.');
      toast('Wallet restored.', 'success');
      reveal(restored, passphrase.value);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      go.disabled = false;
    }
  });
  const startOver = el('button', { class: 'ghost', type: 'button' }, 'Start over');
  startOver.addEventListener('click', () => drawRestoreKey());
  panel.replaceChildren(
    el('h2', {}, 'Is this your address?'),
    kv([['This key controls', identifier(address, { kind: 'address', detail: true, label: 'Wallet address' })]]),
    el('label', { class: 'check', for: 'address-confirmed' }, confirmed, ' This is my address'),
    el('div', { class: 'field' }, passphrase),
    el('div', { class: 'row' }, go, startOver),
    el('p', { class: 'fineprint' }, 'If it is not your address, stop: this is not the key for your wallet, and nothing has been saved.'),
  );
}

// ── Unlocked wallet ─────────────────────────────────────────────────────────

function drawUnlock(address: string): void {
  const passphrase = el('input', { type: 'password', id: 'unlock-passphrase', placeholder: 'Vault passphrase' });
  const go = el('button', { class: 'primary', type: 'button', id: 'unlock' }, 'Unlock');
  const wipe = el('button', { class: 'danger', type: 'button', id: 'wipe' }, 'Delete vault from this browser');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const wallet = await Wallet.unlock(passphrase.value);
      await drawDashboard(wallet, passphrase.value);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      go.disabled = false;
    }
  });
  wipe.addEventListener('click', () => {
    if (!window.confirm('Delete the encrypted vault from this browser? Without the recovery phrase the wallet becomes unrecoverable.')) return;
    Wallet.erase();
    toast('Vault deleted from this browser.', 'info');
    drawCreate();
  });

  const vaultHrp = hrpOfAddress(address);
  const mismatch = vaultHrp !== network!.addressHrp;

  panel.replaceChildren(
    el('h2', {}, 'Unlock'),
    ...(mismatch ? [networkMismatchNotice(vaultHrp)] : []),
    kv([
      ['Address in this browser', identifier(address, { kind: 'address', label: 'Wallet address in this browser' })],
      ['Wallet network', networkName(vaultHrp)],
      ['This interface', `${networkName(network!.addressHrp)} (chain ${network!.chainId})`],
    ]),
    el('div', { class: 'field' }, passphrase),
    el('div', { class: 'row' }, go, anchor('/mine/', 'Mine instead', 'ghost')),
    el('p', { class: 'fineprint' }, mismatch
      ? 'Unlock to re-derive this wallet for the network you are on. Nothing is regenerated and no funds move: the keys are unchanged and only the address prefix differs.'
      : 'Decryption happens in this tab with the WebCrypto API. Three wrong attempts cost you nothing — there is no server to lock you out.'),
    el('div', { class: 'row' }, wipe),
  );
}

/**
 * Offer to re-derive a vault from another network, in place.
 *
 * This is the recovery path for wallets created before 1.2.2, when the page
 * always derived mainnet-prefixed addresses whatever network it was talking
 * to. It is a relabelling, not a new wallet.
 */
async function drawNetworkFix(wallet: Wallet, passphrase: string): Promise<void> {
  const current = wallet.address;
  const future = wallet.accounts.map((account) => account.address);
  const apply = el('button', { class: 'primary', type: 'button' }, `Re-derive for ${networkName(network!.addressHrp)}`);
  const skip = el('button', { class: 'ghost', type: 'button' }, 'Leave it alone');

  apply.addEventListener('click', async () => {
    apply.setAttribute('disabled', 'true');
    try {
      await wallet.switchNetwork(network!.addressHrp, passphrase);
      toast(`Wallet re-derived for ${networkName(network!.addressHrp)}.`, 'success');
      await drawDashboard(wallet, passphrase);
    } catch (error) {
      toast((error as Error).message, 'error');
      apply.removeAttribute('disabled');
    }
  });
  skip.addEventListener('click', () => void drawDashboard(wallet, passphrase));

  panel.replaceChildren(
    el('h2', {}, 'This wallet belongs to another network'),
    networkMismatchNotice(wallet.addressHrp),
    kv([
      ['Address now', identifier(current, { kind: 'address', label: 'Current wallet address' })],
      ['Address after', identifier(addressPreview(wallet), { kind: 'address', label: 'New wallet address' })],
      ['Recovery phrase', 'unchanged — same 24 words, same keys'],
      ['Balance', 'unaffected; this address has never existed on this network, so there is nothing to move'],
    ]),
    el('div', { class: 'row' }, apply, skip),
    el('p', { class: 'fineprint' },
      'If you actually wanted a mainnet wallet, do not re-derive: point this interface at a mainnet node instead. ' +
      'Re-deriving is reversible — the same words give the mainnet address back.'),
  );
  void future;
}

/** What the first address becomes once re-derived, computed without saving. */
function addressPreview(wallet: Wallet): string {
  const publicKey = wallet.accounts[0]!.publicKey;
  // Derived through the vault so this page never re-implements address rules.
  return previewAddress(publicKey, network!.addressHrp);
}

async function drawDashboard(wallet: Wallet, passphrase: string): Promise<void> {
  // A vault from another network cannot talk to this one: every read would
  // come back "not a valid address for this network". Offer the fix first.
  if (!wallet.matchesNetwork(network!.addressHrp)) {
    await drawNetworkFix(wallet, passphrase);
    return;
  }
  const balanceBox = el('div', { class: 'balance-box' }, spinner('reading balance from the chain…'));
  const historyBox = el('div', { id: 'history' }, spinner());

  panel.replaceChildren(el('h2', {}, 'Wallet'), balanceBox, drawReceive(wallet), drawSend(wallet), historyBox, el('div', { class: 'row' }, ...exportRow(wallet, passphrase)));

  await refreshBalance();
  await refreshHistory();

  async function refreshBalance(): Promise<void> {
    try {
      const balance = await client.balance(wallet.address);
      balanceBox.replaceChildren(
        el('span', { class: 'balance-label' }, 'Balance (from the chain)'),
        el('strong', { class: 'balance' }, amountEl(balance.balanceObs)),
        el('span', { class: 'muted' }, `seals ${balance.balanceSeals} · next nonce ${balance.nonce}`),
      );
      const sendButton = document.getElementById('send-button') as HTMLButtonElement | null;
      if (sendButton) sendButton.disabled = BigInt(balance.balanceSeals) <= 0n;
    } catch (error) {
      balanceBox.replaceChildren(el('p', { class: 'error' }, (error as Error).message));
    }
  }

  async function refreshHistory(): Promise<void> {
    try {
      const history = await client.addressHistory(wallet.address, 20);
      const list = history.transactions;
      historyBox.replaceChildren(
        el('h3', {}, 'Recent activity'),
        list.length === 0
          ? el('p', {}, 'No transactions for this address yet.')
          : el(
              'ul',
              { class: 'feed' },
              ...list.map((entry) =>
                el(
                  'li',
                  {},
                  identifier(entry.txId === undefined || entry.txId === null ? undefined : String(entry.txId), { kind: 'hash', label: 'Transaction id' }),
                  el('span', {}, String(entry.kind ?? entry.type ?? 'transaction')),
                  el('span', { class: 'muted' }, when(Number(entry.timestamp ?? 0))),
                ),
              ),
            ),
      );
    } catch (error) {
      historyBox.replaceChildren(el('p', { class: 'error' }, (error as Error).message));
    }
  }
}

function drawReceive(wallet: Wallet): HTMLElement {
  return el(
    'div',
    { class: 'subcard' },
    el('h3', {}, 'Receive'),
    el('p', { class: 'fineprint' }, 'Share the address — never the private key. Payment senders pay the 0.02% gas, capped at 0.01 OBS, which returns to the Mining Pool.'),
    el('div', { class: 'mono address' }, wallet.address),
    el('div', { class: 'row' }, copyButton(() => wallet.address, 'Copy address')),
  );
}

function drawSend(wallet: Wallet): HTMLElement {
  const to = el('input', { id: 'send-to', placeholder: `Recipient address (${network?.addressHrp ?? 'obs'}1…) or .obs name` });
  const amount = el('input', { id: 'send-amount', placeholder: 'Amount in OBS' });
  const memo = el('input', { id: 'send-memo', placeholder: 'Memo (optional)' });
  const quote = el('p', { class: 'fineprint' }, 'Gas: 0.02% of the amount, at least 0.000001 OBS, capped at 0.01 OBS.');
  const send = el('button', { class: 'primary', type: 'button', id: 'send-button' }, 'Sign and send');
  // The form and, when a `.obs` name has been resolved, the confirmation that replaces it. Nothing is signed from the form
  // when the recipient is a name: the person sees the address first and confirms THAT.
  const box = el('div', {});
  const finish = async (result: { txId: string }) => {
    toast(`Signed locally and submitted: ${shortId(result.txId)}`, 'success');
    to.value = '';
    amount.value = '';
    memo.value = '';
    await drawDashboard(wallet, '');
  };
  send.addEventListener('click', async () => {
    try {
      const recipient = to.value.trim();
      if (!recipient) throw new Error('enter a recipient address or a .obs name');
      if (recipientKind(recipient) === 'name') {
        const amountObs = amount.value.trim();
        if (parseObs(amountObs) <= 0n) throw new Error('amount must be greater than zero');
        send.disabled = true;
        const resolved = await resolveOnsName(recipient, resolverDeps(client, wallet.addressHrp));
        if (!resolved.ok) throw new Error(resolved.message);
        box.replaceChildren(drawRecipientReview(wallet, resolved, { amountObs, memo: memo.value.trim() || undefined }, () => box.replaceChildren(form), finish));
        return;
      }
      const result = await operations.send(client, wallet, { to: recipient, amountObs: amount.value.trim(), memo: memo.value.trim() || undefined });
      await finish(result);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      send.disabled = false;
    }
  });
  amount.addEventListener('input', () => {
    try {
      const value = amount.value.trim();
      if (!value || !/^\d*(\.\d*)?$/.test(value)) throw new Error('');
      quote.textContent = `Gas: ${displaySeals(operationsGas(value), EXACT_OBS)} OBS (0.02%, at least 0.000001 OBS, capped at 0.01 OBS)`;
    } catch {
      quote.textContent = 'Gas: 0.02% of the amount, at least 0.000001 OBS, capped at 0.01 OBS.';
    }
  });

  const form = el(
    'div',
    { class: 'subcard' },
    el('h3', {}, 'Send'),
    el('div', { class: 'field' }, el('label', { for: 'send-to' }, 'To'), to),
    el('div', { class: 'field' }, el('label', { for: 'send-amount' }, 'Amount (OBS)'), amount),
    el('div', { class: 'field' }, el('label', { for: 'send-memo' }, 'Memo'), memo),
    quote,
    el('div', { class: 'row' }, send),
    el('p', { class: 'fineprint' }, 'The transaction is signed here, validated by a node, and confirmed by miners. The interface cannot alter it on the way.'),
  );
  box.replaceChildren(form);
  return box;
}

/**
 * A resolved `.obs` recipient, waiting to be confirmed.
 *
 * Shows the name, the whole address it resolves to (never shortened: it is what the person is checking), the network and the
 * status. Confirming resolves the name ONCE MORE and pays only if the answer is unchanged; what is signed is the address, never
 * the name.
 */
function drawRecipientReview(
  wallet: Wallet,
  resolved: Resolved,
  input: { amountObs: string; memo?: string },
  cancel: () => void,
  done: (result: { txId: string }) => Promise<void>,
): HTMLElement {
  const amountShown = displaySeals(parseObs(input.amountObs), EXACT_OBS);
  const confirm = el('button', { class: 'primary', type: 'button', id: 'send-confirm' }, 'Confirm and send');
  const back = el('button', { class: 'ghost', type: 'button', id: 'send-cancel' }, 'Cancel');
  back.addEventListener('click', cancel);
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    back.disabled = true;
    try {
      const again = await reconfirmOnsName(resolved, resolverDeps(client, wallet.addressHrp));
      if (!again.ok) throw new Error(again.message);
      await done(await operations.send(client, wallet, { to: resolved.address, amountObs: input.amountObs, memo: input.memo }));
    } catch (error) {
      toast((error as Error).message, 'error');
      cancel();
    }
  });
  return el(
    'div',
    { class: 'subcard', id: 'send-review' },
    el('h3', {}, 'Confirm recipient'),
    kv([
      ['ONS name', el('span', { class: 'mono', id: 'send-review-name' }, resolved.name)],
      ['Resolves to', el('div', { class: 'mono address', id: 'send-review-address' }, resolved.address)],
      ['Network', networkLabel(resolved.network.addressHrp)],
      ['Status', 'Registered on-chain'],
      ['Amount', `${amountShown} OBS`],
    ]),
    el('p', { class: 'fineprint' }, 'The name is looked up again just before signing. If it no longer points to this address, nothing is sent.'),
    el('div', { class: 'row' }, confirm, back),
  );
}

function operationsGas(amountObs: string): bigint {
  // Local mirror of the protocol rule for the display only — the node recomputes it.
  const digits = amountObs.includes('.') ? amountObs.split('.') : [amountObs, ''];
  const fraction = (digits[1] ?? '').padEnd(18, '0').slice(0, 18);
  const seals = BigInt(`${digits[0] || '0'}${fraction}`);
  if (seals <= 0n) return 0n;
  const gas = (seals * 2n) / 10_000n;
  const cap = 10_000_000_000_000_000n;
  const floor = 1_000_000_000_000n; // minGas: 0.000001 OBS
  const capped = gas > cap ? cap : gas;
  return capped < floor ? floor : capped;
}

function exportRow(wallet: Wallet, passphrase: string): HTMLElement[] {
  const revealKey = el('button', { class: 'ghost', type: 'button' }, 'Reveal private key');
  revealKey.addEventListener('click', () => {
    if (!window.confirm('Display the private key in this window? Anyone who can see your screen can take the wallet.')) return;
    // No fragment of the key is put on screen: a toast is read over shoulders and captured in screenshots.
    toast('Private key copied in full to the clipboard', 'info');
    void navigator.clipboard.writeText(wallet.revealPrivateKey(0)).catch(() => undefined);
  });
  const rescramble = el('input', { type: 'password', placeholder: 'New passphrase', id: 'rescramble' });
  const go = el('button', { class: 'ghost', type: 'button' }, 'Change passphrase');
  go.addEventListener('click', async () => {
    if (rescramble.value.length < MIN_VAULT_PASSPHRASE_LENGTH) return toast(`Use at least ${MIN_VAULT_PASSPHRASE_LENGTH} characters.`, 'error');
    await wallet.save(rescramble.value);
    rescramble.value = '';
    toast('Vault re-encrypted with the new passphrase.', 'success');
  });
  void passphrase;
  return [revealKey, rescramble, go, badge('keys never leave this browser', 'ok')];
}

function anchor(href: string, label: string, kind: 'primary' | 'ghost'): HTMLElement {
  return el('a', { class: `${kind} as-link`, href }, label);
}
