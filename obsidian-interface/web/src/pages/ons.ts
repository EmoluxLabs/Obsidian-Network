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
import { el, obsFromSeals, usd, usdMicroFromDollars, oraclePriceMicro, oraclePriceText, spinner, toast, kv, badge, table, short } from '../lib/ui.js';

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
        ['Registered at height', String(record.registeredAtHeight ?? '—')],
        ['Expires at height', String(record.expiresAt ?? '—')],
        ['Transfers', record.transferCount === 0 ? 'never transferred' : String(record.transferCount)],
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
  // The fee is a dollar price in the protocol table (`ons.registrationFeeUsd`)
  // converted at the node's oracle median. Both numbers come from this node;
  // neither is a constant in the page, and the node validates the result.
  let priceObs = '0';
  let feeUsdMicro = 0n;
  let oracleUsable = false;
  let medianText = '—';
  let sourceCount = 0;
  try {
    const [oracle, params] = await Promise.all([client.oracle(), client.params()]);
    const micro = oraclePriceMicro(oracle);
    oracleUsable = micro !== undefined;
    medianText = oraclePriceText(oracle);
    sourceCount = oracle.sourceCount;
    if (micro !== undefined) {
      feeUsdMicro = usdMicroFromDollars(params.ons.registrationFeeUsd);
      priceObs = obsFromSeals((feeUsdMicro * 10n ** 18n) / micro);
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
    oracleUsable
      ? kv([
          ['Protocol price', `${medianText} / OBS (median of ${sourceCount} independent oracle submissions)`],
          ['Registration fee', `${priceObs} OBS (${usd(feeUsdMicro.toString())}, paid in OBS at that price)`],
          ['Term', 'one year from the block that includes the registration, renewable by the owner'],
        ])
      : el('p', { class: 'error' }, 'The protocol price feed is stale or has fewer than two independent sources, so registration is closed right now. The node would reject the transaction rather than charge a guessed amount.'),
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
            ['Name', 'Owner', 'Registered at height', 'Expires at height'],
            names.slice(0, 25).map((record) => [
              el('span', { class: 'mono' }, record.name),
              el('span', { class: 'mono' }, short(String(record.address ?? ''), 12)),
              String(record.registeredAtHeight ?? '—'),
              String(record.expiresAt ?? '—'),
            ]),
          ),
    );
  } catch (error) {
    recentPanel.replaceChildren(el('h2', {}, 'Registered names'), el('p', { class: 'error' }, (error as Error).message));
  }
}
