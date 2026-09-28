/**
 * ONS — Obsidian Name Service.
 *
 * A `.obs` name maps to exactly one wallet, and the mapping is blockchain
 * state: nodes recompute it, reject double registrations, and honour transfers
 * as ordinary signed transactions. The website is a lookup and a form.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { Wallet } from '../lib/wallet.js';
import { operations } from '../lib/operations.js';
import { el, obs, usd, spinner, toast, kv, badge, table, short, when } from '../lib/ui.js';

const client = new ObsidianClient();
const lookup = el('input', { id: 'ons-lookup', placeholder: 'name.obs', autocomplete: 'off' });
const lookupPanel = el('section', { class: 'card' }, el('p', { class: 'muted' }, 'Type a name to read its on-chain record.'));
const registerPanel = el('section', { class: 'card', id: 'register' }, spinner());
const recentPanel = el('section', { class: 'card' }, spinner());

const go = el('button', { class: 'primary', type: 'button' }, 'Look up');
go.addEventListener('click', () => void doLookup(lookup.value.trim().toLowerCase()));
lookup.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Enter') void doLookup(lookup.value.trim().toLowerCase());
});

layout({
  current: 'ons',
  title: 'ONS',
  tagline: 'Human names for wallet addresses, stored as chain state and owned like any other asset.',
  children: [
    el(
      'section',
      { class: 'notice' },
      el('strong', {}, 'What a name is. '),
      'A name points at one wallet address. Transfers move the record to another wallet — protocol-validated, atomic, and impossible for this website to fake. ' +
        'Registration is priced in OBS from the protocol price of the dollar fee, so the fee follows the market instead of a spreadsheet.',
    ),
    el('section', { class: 'search-bar' }, lookup, go),
    lookupPanel,
    registerPanel,
    recentPanel,
  ],
});

void boot();

async function boot(): Promise<void> {
  void loadRecent();
  drawRegister();
}

async function doLookup(name: string): Promise<void> {
  if (!name) return;
  if (!name.endsWith('.obs')) name = `${name}.obs`;
  lookupPanel.replaceChildren(spinner());
  try {
    const record = await client.name(name);
    lookupPanel.replaceChildren(
      el('h2', {}, `${name}`),
      kv([
        ['Resolves to', el('span', { class: 'mono' }, String(record.address ?? '—'))],
        ['Registered at height', String(record.registeredAt ?? '—')],
        ['Expires at height', String(record.expiresAt ?? '—')],
        ['Transferable', record.transferable === false ? badge('no', 'warn') : badge('yes', 'ok')],
        ['Fee paid', record.fee ? `${obs(String(record.fee))} OBS` : '—'],
      ]),
      el('p', { class: 'fineprint' }, 'The record above was read from a node. Two nodes that disagree about a name are on different chains, and the interface will tell you which one it is reading.'),
    );
  } catch (error) {
    lookupPanel.replaceChildren(
      el('h2', {}, name),
      badge('NOT REGISTERED', 'warn'),
      el('p', {}, 'No wallet currently owns this name in the chain this interface is reading.'),
      el('p', { class: 'fineprint' }, (error as Error).message),
    );
  }
}

async function drawRegister(): Promise<void> {
  let priceObs = '0';
  let medianPrice = '';
  try {
    const oracle = await client.oracle();
    medianPrice = (oracle as { medianPriceUsd?: string }).medianPriceUsd ?? '';
    const params = (await client.params()) as { ons?: { registrationUsdMicro?: string; feeUsdMicro?: string } };
    const feeUsdMicro = params.ons?.registrationUsdMicro ?? params.ons?.feeUsdMicro;
    if (feeUsdMicro && medianPrice) {
      const seals = (BigInt(feeUsdMicro) * 10n ** 18n) / BigInt(medianPrice);
      priceObs = (Number(seals) / 1e18).toString();
    }
  } catch {
    /* handled below */
  }

  const name = el('input', { id: 'ons-name', placeholder: 'yourname', autocomplete: 'off' });
  const create = el('button', { class: 'primary', type: 'button', id: 'ons-register' }, 'Register');
  create.addEventListener('click', async () => {
    const value = name.value.trim().toLowerCase().replace(/\.obs$/, '');
    if (!/^[a-z0-9-]{3,32}$/.test(value)) return toast('Names are 3–32 characters: lowercase letters, digits and hyphens.', 'error');
    const passphrase = window.prompt('Unlock your wallet passphrase to sign the registration');
    if (!passphrase) return;
    try {
      const wallet = await Wallet.unlock(passphrase);
      const result = await operations.registerName(client, wallet, { name: `${value}.obs`, feeObs: priceObs });
      toast(`Registration signed and submitted: ${result.txId.slice(0, 16)}…`, 'success');
      await doLookup(`${value}.obs`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });

  registerPanel.replaceChildren(
    el('h2', {}, 'Register a name'),
    medianPrice
      ? kv([
          ['Protocol price', `${usd(medianPrice)} / OBS (median of independent oracle submissions)`],
          ['Registration fee', `${priceObs} OBS (≈ $5.00, paid in OBS at that price)`],
        ])
      : el('p', { class: 'error' }, 'The protocol price is unavailable or stale, so registration is closed right now. The node refuses the transaction rather than charging a guessed amount.'),
    el('div', { class: 'field' }, el('label', { for: 'ons-name' }, 'Name'), name),
    el('div', { class: 'row' }, create),
    el('p', { class: 'fineprint' }, 'After registration you can transfer the name to any wallet address, or point it at a different address you own, by signing one transaction.'),
  );
}

async function loadRecent(): Promise<void> {
  try {
    const { names } = await client.names();
    recentPanel.replaceChildren(
      el('h2', {}, 'Registered names'),
      names.length === 0
        ? el('p', { class: 'muted' }, 'No names registered yet. The first one sets the tone.')
        : table(
            ['Name', 'Owner', 'Registered', 'State'],
            names.slice(0, 25).map((record) => [
              el('span', { class: 'mono' }, String(record.name ?? '—')),
              el('span', { class: 'mono' }, short(String(record.address ?? ''), 12)),
              when(Number(record.registeredAtTimestamp ?? 0)) || String(record.registeredAt ?? '—'),
              badge('owned', 'ok'),
            ]),
          ),
    );
  } catch (error) {
    recentPanel.replaceChildren(el('h2', {}, 'Registered names'), el('p', { class: 'error' }, (error as Error).message));
  }
}
