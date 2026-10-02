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
import { Wallet, exportBundle, hrpOfAddress, previewAddress } from '../lib/wallet.js';
import { operations, formatObs } from '../lib/operations.js';
import { el, obs, kv, spinner, toast, copyButton, download, badge, short, when } from '../lib/ui.js';

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
  const passphrase = el('input', { type: 'password', id: 'passphrase', placeholder: 'Passphrase (min 8 characters)', autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', id: 'passphrase-confirm', placeholder: 'Repeat passphrase', autocomplete: 'new-password' });
  const output = el('div', { id: 'create-output' });

  const create = el('button', { class: 'primary', type: 'button', id: 'create' }, 'Generate wallet');
  create.addEventListener('click', async () => {
    if (passphrase.value.length < 8) return toast('Use at least 8 characters for the passphrase.', 'error');
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

  panel.replaceChildren(
    el('h2', {}, 'Create a wallet'),
    el(
      'p',
      {},
      'The key is produced by the browser\'s cryptographic random generator on this device. It is not derived from your email, your Google account, your username or anything else — it is 256 bits of entropy behind a 24-word phrase.',
    ),
    el('div', { class: 'field' }, el('label', { for: 'passphrase' }, 'Vault passphrase'), passphrase),
    el('div', { class: 'field' }, el('label', { for: 'passphrase-confirm' }, 'Confirm'), confirm),
    el('div', { class: 'row' }, create, restore),
    el('p', { class: 'fineprint' }, 'The passphrase encrypts the vault file inside this browser. It is not a password for any server, and there is no "forgot passphrase" — by design.'),
    output,
  );
}

function reveal(wallet: Wallet, passphrase: string): void {
  const output = document.getElementById('create-output');
  if (!output) return;
  const phraseBox = el('textarea', { class: 'phrase', readonly: 'readonly', rows: '3', id: 'phrase' }, wallet.revealPhrase());
  const keyBox = el('input', { class: 'mono', readonly: 'readonly', id: 'private-key', value: wallet.revealPrivateKey(0) });
  const bundle = exportBundle(wallet);

  output.replaceChildren(
    el('hr'),
    el('h3', {}, 'Back up now'),
    el('p', {}, 'Write the recovery phrase on paper. It restores the wallet on any device, in any Obsidian interface, forever.'),
    phraseBox,
    el('div', { class: 'row' }, copyButton(() => wallet.revealPhrase(), 'Copy phrase')),
    el('h3', {}, 'Private key'),
    keyBox,
    el('div', { class: 'row' }, copyButton(() => wallet.revealPrivateKey(0), 'Copy private key'), downloadButton()),
    kv([
      ['Address', el('span', { class: 'mono' }, wallet.address)],
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
    el('div', { class: 'row' }, anchor('/mine/', 'Mine with this wallet', 'primary'), anchor('/wallet/', 'Go to wallet', 'ghost')),
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
    if (passphrase.value.length < 8) return toast('Use at least 8 characters for the passphrase.', 'error');
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
      ['Address in this browser', el('span', { class: 'mono' }, address)],
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
      ['Address now', el('span', { class: 'mono' }, current)],
      ['Address after', el('span', { class: 'mono' }, addressPreview(wallet))],
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
        el('strong', { class: 'balance' }, `${obs(balance.balanceObs)} OBS`),
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
                  el('span', { class: 'mono' }, short(String(entry.txId ?? ''), 8)),
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
  const quote = el('p', { class: 'fineprint' }, 'Gas: 0.02% of the amount, capped at 0.01 OBS.');
  const send = el('button', { class: 'primary', type: 'button', id: 'send-button' }, 'Sign and send');
  send.addEventListener('click', async () => {
    try {
      const recipient = to.value.trim();
      if (!recipient) throw new Error('enter a recipient address');
      const result = await operations.send(client, wallet, { to: recipient, amountObs: amount.value.trim(), memo: memo.value.trim() || undefined });
      toast(`Signed locally and submitted: ${result.txId.slice(0, 16)}…`, 'success');
      to.value = '';
      amount.value = '';
      memo.value = '';
      await drawDashboard(wallet, '');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });
  amount.addEventListener('input', () => {
    try {
      const value = amount.value.trim();
      if (!value || !/^\d*(\.\d*)?$/.test(value)) throw new Error('');
      quote.textContent = `Gas: ${formatObs(operationsGas(value))} OBS (0.02%, capped at 0.01 OBS)`;
    } catch {
      quote.textContent = 'Gas: 0.02% of the amount, capped at 0.01 OBS.';
    }
  });

  return el(
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
}

function operationsGas(amountObs: string): bigint {
  // Local mirror of the protocol rule for the display only — the node recomputes it.
  const digits = amountObs.includes('.') ? amountObs.split('.') : [amountObs, ''];
  const fraction = (digits[1] ?? '').padEnd(18, '0').slice(0, 18);
  const seals = BigInt(`${digits[0] || '0'}${fraction}`);
  const gas = (seals * 2n) / 10_000n;
  const cap = 10_000_000_000_000_000n;
  return gas > cap ? cap : gas;
}

function exportRow(wallet: Wallet, passphrase: string): HTMLElement[] {
  const revealKey = el('button', { class: 'ghost', type: 'button' }, 'Reveal private key');
  revealKey.addEventListener('click', () => {
    if (!window.confirm('Display the private key in this window? Anyone who can see your screen can take the wallet.')) return;
    toast(`Private key: ${wallet.revealPrivateKey(0).slice(0, 18)}… (copied in full to the clipboard)`, 'info');
    void navigator.clipboard.writeText(wallet.revealPrivateKey(0)).catch(() => undefined);
  });
  const rescramble = el('input', { type: 'password', placeholder: 'New passphrase', id: 'rescramble' });
  const go = el('button', { class: 'ghost', type: 'button' }, 'Change passphrase');
  go.addEventListener('click', async () => {
    if (rescramble.value.length < 8) return toast('Use at least 8 characters.', 'error');
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
