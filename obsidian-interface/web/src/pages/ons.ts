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
import { el, spinner, toast, kv, badge, table, short } from '../lib/ui.js';

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
        'Registration is priced in OBS by consensus, so the fee is the same on every node and does not depend on any exchange rate or price feed.',
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
  // The fee is a flat OBS amount in the protocol table, read from this node's
  // /params. No dollar price, no oracle, no conversion: registration works on
  // a chain that has never seen a price feed, which is the whole point of
  // denominating protocol fees in the protocol's own unit.
  let priceObs: string | undefined;
  let renewalObs: string | undefined;
  let termYears = 1;
  let loadError = '';
  try {
    const params = await client.params();
    priceObs = params.ons.registrationFeeObs;
    renewalObs = params.ons.renewalFeeObs;
    termYears = Math.max(1, Math.round(params.ons.termSeconds / (365 * 24 * 60 * 60)));
  } catch (error) {
    loadError = (error as Error).message;
  }

  const name = el('input', { id: 'ons-name', placeholder: 'yourname', autocomplete: 'off' });
  const create = el('button', { class: 'primary', type: 'button', id: 'ons-register' }, 'Register');
  if (priceObs === undefined) create.disabled = true;
  create.addEventListener('click', async () => {
    const value = name.value.trim().toLowerCase().replace(/\.obs$/, '');
    if (!/^[a-z0-9-]{3,32}$/.test(value)) return toast('Names are 3–32 characters: lowercase letters, digits and hyphens.', 'error');
    const passphrase = window.prompt('Unlock your wallet passphrase to sign the registration');
    if (!passphrase) return;
    try {
      const wallet = await Wallet.unlock(passphrase);
      if (priceObs === undefined) return toast('This page could not read the registration fee from a node, so it will not guess one.', 'error');
      const result = await operations.registerName(client, wallet, { name: `${value}.obs`, feeObs: priceObs });
      toast(`Registration signed and submitted: ${result.txId.slice(0, 16)}…`, 'success');
      await doLookup(`${value}.obs`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });

  registerPanel.replaceChildren(
    el('h2', {}, 'Register a name'),
    priceObs !== undefined
      ? kv([
          ['Registration fee', `${priceObs} OBS`],
          ['Renewal fee', `${renewalObs} OBS per term`],
          ['Term', `${termYears === 1 ? 'one year' : `${termYears} years`} from the block that includes the registration, renewable by the owner`],
          ['Price source', 'the protocol itself — this fee is a consensus parameter, not a conversion from any currency'],
        ])
      : el('p', { class: 'error' }, `This page could not reach a node to read the registration fee${loadError ? `: ${loadError}` : ''}. Registration stays closed rather than guessing an amount the node would reject.`),
    el('div', { class: 'field' }, el('label', { for: 'ons-name' }, 'Name'), name),
    el('div', { class: 'row' }, create),
    el('p', { class: 'fineprint' }, 'After registration you can transfer the name to any wallet address, or point it at a different address you own, by signing one transaction.'),
  );
}

async function loadRecent(): Promise<void> {
  try {
    const { names } = await client.names('', { limit: 25 });
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
