/**
 * ONS — Obsidian Name Service, and the ONS Marketplace (protocol 2.0.0).
 *
 * A `.obs` name maps to exactly one wallet, and the mapping is blockchain state: nodes recompute it, reject double
 * registrations, and honour transfers as ordinary signed transactions. The website is a lookup and a form.
 *
 * The Marketplace is the same: a listing, an offer and the OBS locked behind an offer are consensus state. This page
 * only reads them from a node and builds transactions the chain re-validates; it never decides who owns a name, who
 * is paid or what is locked, and it never shows "done" until a node reports the new state.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient, type MarketListing, type MarketNameStatus, type MarketOfferView, type NameRecord } from '../lib/client.js';
import { Wallet } from '../lib/wallet.js';
import { awaitConfirmation, gasFor, operations } from '../lib/operations.js';
import { el, spinner, toast, kv, badge, table, obsUnit, obsExact, shortId, button, when, clear } from '../lib/ui.js';
import { identifier } from '../lib/identifier.js';
import { parseObs } from '../../core/protocol/amount.js';
import { validateNameFormat } from '../../core/transactions/executors/ons.js';
import { addressOf, ownerRoles, ownerSnapshot, targetProblem, type OwnerKind, type OwnerNameRecord } from '../lib/ons-owner.js';

const client = new ObsidianClient();
const lookup = el('input', { id: 'ons-lookup', placeholder: 'name.obs', autocomplete: 'off' });
const lookupPanel = el('section', { class: 'card', id: 'ons-result' }, el('p', { class: 'muted' }, 'Type a name to see whether it is available, for sale, or owned.'));
const feedPanel = el('section', { class: 'card', id: 'market-feed' }, spinner());
const minePanel = el('section', { class: 'card', id: 'market-mine' }, spinner());
const registerPanel = el('section', { class: 'card', id: 'register' }, spinner());
const recentPanel = el('section', { class: 'card' }, spinner());

const go = el('button', { class: 'primary', type: 'button' }, 'Search');
go.addEventListener('click', () => void doLookup(lookup.value));
lookup.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Enter') void doLookup(lookup.value);
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
      'A name points at one wallet address. Registration is priced in OBS by consensus. ' +
        'On the ONS Marketplace an owner can list a name at a fixed OBS price, anyone can buy it, and anyone can make an offer on a name that is not for sale: the offered OBS is locked by the chain until the owner accepts or declines, or you cancel. ' +
        'Payment and transfer happen in one step or not at all, and the Marketplace takes no commission.',
    ),
    el('section', { class: 'search-bar' }, lookup, go),
    lookupPanel,
    feedPanel,
    minePanel,
    registerPanel,
    recentPanel,
  ],
});

async function boot(): Promise<void> {
  void loadRecent();
  void drawFeed();
  void drawMine();
  drawRegister();
}

// ── shared helpers ─────────────────────────────────────────────────────────────────────────────────────────────

const bare = (raw: string): string => raw.trim().toLowerCase().replace(/\.obs$/, '');
const mine = (): string | undefined => Wallet.storedAddress();

/** Sign with the person's own wallet: the passphrase is asked for here and the key never leaves the tab. */
async function withWallet<T>(action: string, run: (wallet: Wallet) => Promise<T>): Promise<T | undefined> {
  const address = mine();
  if (!address) {
    toast('Create or open your wallet first: the Wallet page holds the key that signs this.', 'error');
    return undefined;
  }
  const passphrase = window.prompt(`Unlock your wallet passphrase to sign: ${action}`);
  if (!passphrase) return undefined;
  const wallet = await Wallet.unlock(passphrase);
  if (wallet.address !== address) throw new Error('the unlocked wallet is not the one this browser shows');
  return run(wallet);
}

/**
 * Run one Marketplace action from signing to confirmation. "Submitted" means a node's mempool accepted the signed
 * bytes; the action counts as done only when `confirmed` finds the new state on the chain.
 */
async function perform(
  label: string,
  signAndSubmit: (wallet: Wallet) => Promise<{ txId: string }>,
  confirmed: () => Promise<boolean>,
  after: () => Promise<void>,
): Promise<void> {
  try {
    const result = await withWallet(label, signAndSubmit);
    if (!result) return;
    toast(`${label}: submitted (${shortId(result.txId)}), waiting for the chain to confirm…`, 'info');
    const done = await awaitConfirmation(client, confirmed);
    if (done) toast(`${label}: confirmed on the chain.`, 'success');
    else toast(`${label}: not confirmed yet. It may still be pending, or the chain refused it. Check the state below before trying again.`, 'error');
  } catch (error) {
    toast((error as Error).message, 'error');
  }
  await Promise.all([drawFeed(), drawMine()]);
  if (lookup.value) await doLookup(lookup.value);
}

const sellerLink = (address: string): HTMLElement => identifier(address, { kind: 'address', label: 'Wallet address' });
const nameButton = (name: string): HTMLElement => {
  const node = el('button', { class: 'ghost mono', type: 'button' }, name);
  node.addEventListener('click', () => {
    lookup.value = name;
    void doLookup(name);
  });
  return node;
};
/** Opens the name in the search panel at the top, where the owner actions are, and brings that panel into view. */
const manageButton = (name: string): HTMLElement =>
  button('Manage', async () => {
    lookup.value = name;
    await doLookup(name);
    lookupPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, { kind: 'primary' });

// ── search ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function doLookup(raw: string): Promise<void> {
  const name = bare(raw);
  if (!name) return;
  lookup.value = `${name}.obs`;
  lookupPanel.replaceChildren(spinner());
  try {
    const status = await client.marketName(name);
    const record = status.status === 'AVAILABLE' ? undefined : await client.name(`${name}.obs`).catch(() => undefined);
    drawStatus(name, status, record?.registeredAtHeight, record?.transferCount, record?.expiresAt, record);
  } catch (error) {
    lookupPanel.replaceChildren(
      el('h2', {}, `${name}.obs`),
      badge('UNAVAILABLE', 'warn'),
      el('p', {}, 'This page could not read the name from a node, so it will not guess.'),
      el('p', { class: 'fineprint' }, (error as Error).message),
    );
  }
}

function drawStatus(name: string, status: MarketNameStatus, registeredAtHeight?: number, transferCount?: number, expiresAt?: number, record?: NameRecord): void {
  const full = `${name}.obs`;
  const me = mine();
  const isOwner = Boolean(me) && status.owner === me;
  const parts: Array<Node | string> = [el('h2', {}, full)];

  if (status.status === 'AVAILABLE') {
    parts.push(badge('AVAILABLE', 'ok'), el('p', {}, 'Nobody owns this name. You can register it at the protocol fee.'));
    const register = button('Register this name', async () => {
      (document.getElementById('ons-name') as HTMLInputElement | null)?.setAttribute('value', name);
      const input = document.getElementById('ons-name') as HTMLInputElement | null;
      if (input) input.value = name;
      registerPanel.scrollIntoView?.({ behavior: 'smooth' });
    }, { kind: 'primary', id: 'ons-go-register' });
    parts.push(el('div', { class: 'row' }, register));
  } else if (status.status === 'EXPIRED') {
    parts.push(badge('EXPIRED', 'warn'), el('p', {}, 'The term has ended. It cannot be traded; the chain decides when it can be registered again.'));
  } else if (status.status === 'LISTED' && status.listing) {
    parts.push(drawListed(full, status.listing, isOwner));
  } else {
    parts.push(drawOwned(full, name, status, isOwner));
  }

  if (status.status !== 'AVAILABLE') {
    parts.push(
      kv([
        ['Owner', status.owner ? sellerLink(status.owner) : '—'],
        ['Expires', status.listing ? when(status.listing.expiresAt) : expiresAt === undefined ? '—' : when(expiresAt)],
        ['Registered at height', registeredAtHeight === undefined ? '—' : String(registeredAtHeight)],
        ['Transfers', transferCount === undefined ? '—' : transferCount === 0 ? 'never transferred' : String(transferCount)],
        ['Pending offers', String(status.pendingOffers)],
      ]),
    );
  }
  parts.push(el('p', { class: 'fineprint' }, `Read from a node at height ${status.atHeight}. This is information, not authority: the chain re-checks everything when a transaction is included.`));
  lookupPanel.replaceChildren(...parts);
  if (status.status !== 'AVAILABLE') void drawNameOffers(name, isOwner);
  if (status.status !== 'AVAILABLE' && record) void drawOwnerActions(full, name, record);
}

function drawListed(full: string, listing: MarketListing, isOwner: boolean): HTMLElement {
  const box = el('div', { id: 'market-listed' });
  box.append(
    badge('LISTED ON ONS MARKETPLACE', 'ok'),
    kv([
      ['Price', el('strong', {}, obsExact(listing.priceSeals))],
      ['Seller', sellerLink(listing.seller)],
      ['Listed at height', String(listing.listedAtHeight)],
    ]),
    el('p', { class: 'fineprint' }, 'While a name is listed its owner cannot use or edit it, and it does not resolve. A purchase pays the seller the full price and moves the name in one step; the Marketplace takes no commission.'),
  );
  if (isOwner) {
    box.append(el('p', { class: 'muted' }, 'This is your listing. Manage it under "Your names" below.'));
    return box;
  }
  const buy = button('Buy now', async () => reviewBuy(full, listing), { kind: 'primary', id: 'market-buy', disabled: !mine() });
  box.append(el('div', { class: 'row' }, buy), mine() ? '' : el('p', { class: 'fineprint' }, 'Open your wallet to buy.'));
  return box;
}

function drawOwned(full: string, name: string, status: MarketNameStatus, isOwner: boolean): HTMLElement {
  const box = el('div', { id: 'market-owned' }, badge('REGISTERED, NOT FOR SALE', 'neutral'));
  if (isOwner) {
    box.append(el('p', { class: 'muted' }, 'You own this name. List it for sale under "Your names" below.'));
    return box;
  }
  box.append(el('p', {}, 'The owner has not listed this name. You can make an offer: your OBS is locked by the chain until the owner accepts or declines, or until you cancel.'));
  const amount = el('input', { id: 'market-offer-amount', placeholder: 'Offer in OBS, e.g. 25', inputmode: 'decimal', autocomplete: 'off' });
  const review = button('Review offer', async () => reviewOffer(full, name, status, amount.value), { kind: 'primary', id: 'market-offer-review', disabled: !mine() });
  box.append(el('div', { class: 'field' }, el('label', { for: 'market-offer-amount' }, 'Your offer'), amount), el('div', { class: 'row' }, review));
  if (!mine()) box.append(el('p', { class: 'fineprint' }, 'Open your wallet to make an offer.'));
  return box;
}

/** What a purchase costs the buyer and who gets what: shown before anything is signed. */
async function reviewBuy(full: string, listing: MarketListing): Promise<void> {
  const me = mine();
  if (!me) return;
  const balance = await client.balance(me);
  const price = BigInt(listing.priceSeals);
  const gas = gasFor(price);
  const spendable = BigInt(balance.spendableSeals ?? balance.balanceSeals);
  const short = spendable < price + gas;
  const confirm = button('Confirm and sign', async () => {
    await perform(
      `Buy ${full}`,
      (wallet) => operations.buyName(client, wallet, { name: full, reviewedPriceSeals: listing.priceSeals, reviewedSeller: listing.seller }),
      async () => (await client.marketName(bare(full))).owner === me,
      async () => undefined,
    );
  }, { kind: 'primary', id: 'market-buy-confirm', disabled: short });
  const cancel = button('Cancel', async () => doLookup(full), { kind: 'ghost' });
  lookupPanel.replaceChildren(
    el('h2', {}, `Buy ${full}`),
    kv([
      ['Name', full],
      ['Seller (receives the full price)', sellerLink(listing.seller)],
      ['Price', obsExact(listing.priceSeals)],
      ['Network fee (gas, paid by you to the mining pool)', obsExact(gas)],
      ['You pay in total', el('strong', {}, obsExact(price + gas))],
      ['Your spendable balance', obsExact(spendable)],
      ['Marketplace commission', 'none'],
    ]),
    short ? el('p', { class: 'error' }, 'Your spendable balance does not cover the price and the fee, so the chain would refuse this purchase.') : '',
    el('p', { class: 'fineprint' }, 'The chain checks, in order: the listing is active, you are not the seller, the seller still owns the name, the price is still this price, you can afford price plus gas. Then it pays the seller, moves the name and removes the listing in one step. If any check fails nothing moves.'),
    el('div', { class: 'row' }, confirm, cancel),
  );
}

async function reviewOffer(full: string, name: string, status: MarketNameStatus, amountObs: string): Promise<void> {
  const me = mine();
  if (!me || !status.owner) return;
  let amount: bigint;
  try {
    amount = parseObs(amountObs.trim());
  } catch {
    toast('Enter the offer as an OBS amount such as 25 or 0.5.', 'error');
    return;
  }
  if (amount <= 0n) return toast('The offer must be greater than zero.', 'error');
  const balance = await client.balance(me);
  const gas = gasFor(amount);
  const spendable = BigInt(balance.spendableSeals ?? balance.balanceSeals);
  const short = spendable < amount + gas;
  const confirm = button('Lock funds and send offer', async () => {
    await perform(
      `Offer on ${full}`,
      (wallet) => operations.makeOffer(client, wallet, { name: full, amountObs: amountObs.trim() }),
      async () => (await client.marketOffers('outgoing', me, { status: 'PENDING' })).offers.some((offer) => offer.name === full && offer.amountSeals === amount.toString()),
      async () => undefined,
    );
  }, { kind: 'primary', id: 'market-offer-confirm', disabled: short });
  lookupPanel.replaceChildren(
    el('h2', {}, `Offer on ${full}`),
    kv([
      ['Name', full],
      ['Owner (can accept or decline)', sellerLink(status.owner)],
      ['Your offer, locked in escrow now', obsExact(amount)],
      ['Network fee (gas, paid by you, never taken from escrow)', obsExact(gas)],
      ['Leaves your spendable balance', el('strong', {}, obsExact(amount + gas))],
      ['Your spendable balance', obsExact(spendable)],
    ]),
    short ? el('p', { class: 'error' }, 'Your spendable balance does not cover the offer and the fee.') : '',
    el('p', { class: 'fineprint' }, 'Your offer is locked by the chain immediately and returns to you in full if the owner declines, you cancel, the offer lapses after seven days, or the name is listed, transferred or expires. If the owner accepts, the name becomes yours and the owner receives the full amount.'),
    el('div', { class: 'row' }, confirm, button('Cancel', async () => doLookup(name), { kind: 'ghost' })),
  );
}

/** Offers on the name the person is looking at: the owner decides them, the maker may cancel their own. */
async function drawNameOffers(name: string, isOwner: boolean): Promise<void> {
  const me = mine();
  if (!isOwner && !me) return;
  try {
    const { offers } = await client.marketOffers('name', name, { status: 'PENDING' });
    const visible = offers.filter((offer) => isOwner || offer.maker === me);
    if (visible.length === 0) return;
    lookupPanel.append(el('h3', {}, isOwner ? 'Offers made to you' : 'Your offer'), offerTable(visible, isOwner ? 'incoming' : 'outgoing'));
  } catch {
    /* the offers panel is optional; the search result above stands on its own */
  }
}


// ── ownership: change address, offer, accept, recovery (protocol 1.9.0) ────────────────────────────────────────────

let networkInfo: { name: string; addressHrp: string } | undefined;
async function networkNow(): Promise<{ name: string; addressHrp: string }> {
  if (!networkInfo) {
    const { network } = await client.network();
    networkInfo = { name: network.name, addressHrp: network.addressHrp };
  }
  return networkInfo;
}

const OWNER_TITLES: Record<OwnerKind, string> = {
  update: 'Change of address',
  transfer: 'Transfer offer',
  withdraw: 'Withdrawal of the transfer offer',
  accept: 'Acceptance of the transfer',
  recoverySet: 'Recovery address',
  recoveryClear: 'Removal of the recovery address',
  recoveryStart: 'Recovery',
  recoveryCancel: 'Cancellation of the recovery',
  recoveryFinalize: 'Completion of the recovery',
};

const OWNER_EFFECT: Record<OwnerKind, string> = {
  update: 'Anyone who pays this name will pay the new address from the moment the chain confirms it. Ownership does not change. This is free: it carries no amount, so it pays no gas.',
  transfer: 'This is an offer, not a transfer. Nothing changes hands until that wallet accepts it, within seven days. You keep the name and can withdraw the offer until then. Once it is accepted you cannot take the name back, so check the address. Free of gas.',
  withdraw: 'The open offer is cancelled and that wallet can no longer accept it. You keep the name. Free of gas.',
  accept: 'The name, where it resolves and its remaining term move to this wallet. The previous owner’s recovery address and any recovery in flight are removed. Free of gas.',
  recoverySet: 'That wallet will be able to start a recovery of this name. You can cancel a recovery during its delay of seven days, as long as you still hold your wallet. Choose a wallet you control and keep apart from this one. Free of gas.',
  recoveryClear: 'The name will have no recovery address. Free of gas.',
  recoveryStart: 'The current owner is given seven days to cancel. After that, the recovery can be completed and the name moves to the new owner. Free of gas.',
  recoveryCancel: 'The recovery in flight is stopped. You keep the name. Free of gas.',
  recoveryFinalize: 'The name moves to the new owner now. Free of gas.',
};

/** The transaction for one owner action, and how the chain shows it happened. */
function ownerAction(kind: OwnerKind, bare: string, target: string, me: string, snapshot: OwnerNameRecord) {
  const full = `${bare}.obs`;
  switch (kind) {
    case 'update':
      return { sign: (w: Wallet) => operations.updateNameAddress(client, w, { name: bare, address: target }), done: (r: NameRecord) => r.address === target };
    case 'transfer':
      return { sign: (w: Wallet) => operations.offerNameTransfer(client, w, { name: bare, to: target }), done: (r: NameRecord) => r.pendingTransfer?.to === target };
    case 'withdraw':
      return { sign: (w: Wallet) => operations.cancelNameTransfer(client, w, { name: bare }), done: (r: NameRecord) => !r.pendingTransfer };
    case 'accept':
      return { sign: (w: Wallet) => operations.acceptNameTransfer(client, w, { name: bare }), done: (r: NameRecord) => r.owner === me };
    case 'recoverySet':
      return { sign: (w: Wallet) => operations.setNameRecovery(client, w, { name: bare, address: target }), done: (r: NameRecord) => r.recoveryAddress === target };
    case 'recoveryClear':
      return { sign: (w: Wallet) => operations.setNameRecovery(client, w, { name: bare, address: '' }), done: (r: NameRecord) => !r.recoveryAddress };
    case 'recoveryStart':
      return { sign: (w: Wallet) => operations.startNameRecovery(client, w, { name: bare, newOwner: target }), done: (r: NameRecord) => r.pendingRecovery?.newAddress === target };
    case 'recoveryCancel':
      return { sign: (w: Wallet) => operations.cancelNameRecovery(client, w, { name: bare }), done: (r: NameRecord) => !r.pendingRecovery };
    case 'recoveryFinalize':
      return { sign: (w: Wallet) => operations.finalizeNameRecovery(client, w, { name: bare }), done: (r: NameRecord) => r.owner === snapshot.pendingRecovery?.newAddress };
    default:
      throw new Error(`unknown action ${String(kind)} on ${full}`);
  }
}

/** Show what is about to be signed, then sign only if the name is still exactly as it was reviewed. */
async function reviewOwner(kind: OwnerKind, bare: string, record: NameRecord, typed: string): Promise<void> {
  const me = mine();
  if (!me) return void toast('Create or open your wallet first: the Wallet page holds the key that signs this.', 'error');
  const full = `${bare}.obs`;
  const net = await networkNow();
  const status = await client.status();
  const now = status.lastBlockTimestamp;
  const needsAddress = kind === 'update' || kind === 'transfer' || kind === 'recoverySet' || kind === 'recoveryStart';
  if (needsAddress) {
    const problem = targetProblem(kind, typed, net.addressHrp, record, now);
    if (problem) return void toast(problem, 'error');
  }
  const target = needsAddress ? addressOf(typed) : '';
  const snapshot = ownerSnapshot(record);
  const rows: Array<[string, HTMLElement | string]> = [
    ['Name', full],
    ['Network', net.name],
  ];
  if (kind === 'update') rows.push(['Currently resolves to', record.address ? sellerLink(record.address) : '—'], ['Will resolve to', sellerLink(target)]);
  if (kind === 'transfer') rows.push(['Current owner (you)', sellerLink(record.owner)], ['Offered to', sellerLink(target)], ['Open for', 'seven days']);
  if (kind === 'withdraw') rows.push(['Offer to', record.pendingTransfer ? sellerLink(record.pendingTransfer.to) : '—']);
  if (kind === 'accept') rows.push(['Current owner', sellerLink(record.owner)], ['New owner (you)', sellerLink(me)]);
  if (kind === 'recoverySet') rows.push(['Owner (you)', sellerLink(record.owner)], ['Recovery address', sellerLink(target)]);
  if (kind === 'recoveryClear') rows.push(['Removing', record.recoveryAddress ? sellerLink(record.recoveryAddress) : '—']);
  if (kind === 'recoveryStart') rows.push(['Current owner', sellerLink(record.owner)], ['New owner', sellerLink(target)], ['Delay', 'seven days, and the owner can cancel']);
  if (kind === 'recoveryCancel') rows.push(['Recovery to', record.pendingRecovery ? sellerLink(record.pendingRecovery.newAddress) : '—']);
  if (kind === 'recoveryFinalize') rows.push(['Current owner', sellerLink(record.owner)], ['New owner', record.pendingRecovery ? sellerLink(record.pendingRecovery.newAddress) : '—']);
  const act = ownerAction(kind, bare, target, me, record);
  const confirm = button('Confirm and sign', async () => {
    await perform(
      `${OWNER_TITLES[kind]} on ${full}`,
      async (wallet) => {
        const now = await client.name(full).catch(() => undefined);
        if (!now || ownerSnapshot(now) !== snapshot) throw new Error(`${full} changed while you were reviewing it. Nothing was signed: look at it again.`);
        return act.sign(wallet);
      },
      async () => act.done(await client.name(full)),
      async () => undefined,
    );
  }, { kind: 'primary', id: 'owner-confirm' });
  lookupPanel.replaceChildren(
    el('h2', {}, `Review: ${OWNER_TITLES[kind].toLowerCase()}`),
    kv(rows),
    el('p', { class: 'fineprint' }, OWNER_EFFECT[kind]),
    el('p', { class: 'fineprint' }, 'Nothing is shown as done until the chain confirms it.'),
    el('div', { class: 'row' }, confirm, button('Cancel', async () => doLookup(full), { kind: 'ghost' })),
  );
}

/** The actions this wallet can take on a name it owns, was offered, or holds the recovery of. */
async function drawOwnerActions(full: string, bare: string, record: NameRecord): Promise<void> {
  const me = mine();
  if (!me) return;
  try {
    const net = await networkNow();
    const status = await client.status();
    const roles = ownerRoles(record, me, status.lastBlockTimestamp);
    if (!roles.involved) return;
    const box = el('section', { id: 'owner-actions' });
    const locked = roles.locked;
    const lockNote = locked ? el('p', { class: 'fineprint' }, 'This name is listed on the ONS Marketplace, so the chain refuses these actions (NAME_LISTED). Remove the listing first (under "Your names" below).') : '';
    const addressForm = (id: string, label: string, kind: OwnerKind, action: string, disabled = locked): HTMLElement[] => {
      const input = el('input', { id, placeholder: `${net.addressHrp}1…`, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
      return [
        el('div', { class: 'field' }, el('label', { for: id }, label), input),
        el('div', { class: 'row' }, button(action, async () => reviewOwner(kind, bare, record, input.value), { kind: 'primary', id: `${id}-review`, disabled })),
      ];
    };
    if (roles.isOwner) {
      box.append(el('h3', {}, 'Manage this name'), lockNote);
      box.append(el('h4', {}, 'Change the address it points to'), ...addressForm('own-update', 'New address', 'update', 'Review change of address'));
      box.append(el('h4', {}, 'Offer it to another wallet'));
      if (roles.offerOpen && record.pendingTransfer) {
        box.append(
          el('p', {}, ...['An offer is open to ', sellerLink(record.pendingTransfer.to), record.pendingTransfer.offerExpiresAt ? ` until ${when(record.pendingTransfer.offerExpiresAt)}.` : '.']),
          el('div', { class: 'row' }, button('Withdraw the offer', async () => reviewOwner('withdraw', bare, record, ''), { kind: 'ghost', id: 'own-withdraw' })),
        );
      } else {
        box.append(...addressForm('own-transfer', 'Recipient address', 'transfer', 'Review transfer offer'));
      }
      box.append(el('h4', {}, 'Recovery address'));
      if (record.recoveryAddress) box.append(el('p', {}, ...['Recovery address: ', sellerLink(record.recoveryAddress)]));
      else box.append(el('p', { class: 'muted' }, 'No recovery address is set. If you lose this wallet without one, nobody can recover the name.'));
      if (roles.recoveryInFlight && record.pendingRecovery) {
        box.append(
          el('p', { class: 'error' }, ...['A recovery is in flight to ', sellerLink(record.pendingRecovery.newAddress), record.pendingRecovery.effectiveAt ? `; it can be completed from ${when(record.pendingRecovery.effectiveAt)}. If you did not expect this, cancel it now.` : '.']),
          el('div', { class: 'row' }, button('Cancel the recovery', async () => reviewOwner('recoveryCancel', bare, record, ''), { kind: 'primary', id: 'own-recovery-cancel' })),
        );
      } else {
        box.append(...addressForm('own-recovery', 'Recovery address', 'recoverySet', record.recoveryAddress ? 'Review new recovery address' : 'Review recovery address', locked));
        if (record.recoveryAddress) box.append(el('div', { class: 'row' }, button('Remove the recovery address', async () => reviewOwner('recoveryClear', bare, record, ''), { kind: 'ghost', id: 'own-recovery-clear', disabled: locked })));
      }
    }
    if (roles.offeredToMe) {
      box.append(
        el('h3', {}, 'Offered to your wallet'),
        el('p', {}, ...['The owner offered this name to this wallet', record.pendingTransfer?.offerExpiresAt ? `; the offer is open until ${when(record.pendingTransfer.offerExpiresAt)}.` : '.']),
        lockNote,
        el('div', { class: 'row' }, button('Review and accept', async () => reviewOwner('accept', bare, record, ''), { kind: 'primary', id: 'own-accept', disabled: locked })),
      );
    } else if (roles.offerLapsedForMe) {
      box.append(el('h3', {}, 'Offered to your wallet'), el('p', { class: 'muted' }, 'This offer has lapsed (offers last seven days). Ask the owner to offer it again.'));
    }
    if (roles.canStartRecovery) {
      box.append(
        el('h3', {}, 'This wallet is the recovery address'),
        el('p', { class: 'muted' }, 'You can start a recovery to a new owner. The current owner has seven days to cancel it.'),
        lockNote,
        ...addressForm('own-newowner', 'New owner address', 'recoveryStart', 'Review and start recovery', locked),
      );
    }
    if (roles.inRecovery && record.pendingRecovery && !roles.isOwner) {
      const ready = roles.recoveryWaitSeconds === 0;
      box.append(
        el('h3', {}, 'A recovery is in flight'),
        el('p', {}, ...['The name will move to ', sellerLink(record.pendingRecovery.newAddress), ready ? ' when you complete it.' : ` once the delay has passed (ready at ${when(record.pendingRecovery.effectiveAt ?? 0)}).`]),
        el('div', { class: 'row' }, button('Review and complete recovery', async () => reviewOwner('recoveryFinalize', bare, record, ''), { kind: 'primary', id: 'own-finalize', disabled: !ready || locked })),
      );
    }
    if (box.childNodes.length > 0) lookupPanel.append(box);
  } catch {
    /* the owner panel is optional; the search result above stands on its own */
  }
}

// ── offers ─────────────────────────────────────────────────────────────────────────────────────────────────────

function statusBadge(offer: MarketOfferView): HTMLElement {
  const kind = offer.status === 'PENDING' ? 'warn' : offer.status === 'ACCEPTED' ? 'ok' : 'neutral';
  return badge(offer.status === 'INVALIDATED' ? 'REFUNDED (name changed or listed)' : offer.status, kind);
}

function offerTable(offers: MarketOfferView[], scope: 'incoming' | 'outgoing'): HTMLElement {
  return table(
    [scope === 'incoming' ? 'From' : 'To owner', 'Name', 'Amount', 'Status', 'Made', 'Action'],
    offers.map((offer) => {
      const pending = offer.status === 'PENDING';
      const actions: HTMLElement[] = [];
      if (pending && scope === 'incoming') {
        actions.push(
          button('Accept', () => perform(`Accept offer for ${offer.name}`, (w) => operations.acceptOffer(client, w, { offer }), async () => (await client.marketOffer(offer.id)).offer.status !== 'PENDING', async () => undefined), { kind: 'primary' }),
          button('Decline', () => perform(`Decline offer for ${offer.name}`, (w) => operations.declineOffer(client, w, { offer }), async () => (await client.marketOffer(offer.id)).offer.status !== 'PENDING', async () => undefined), { kind: 'ghost' }),
        );
      }
      if (pending && scope === 'outgoing') {
        actions.push(button('Cancel offer', () => perform(`Cancel offer for ${offer.name}`, (w) => operations.cancelOffer(client, w, { offer }), async () => (await client.marketOffer(offer.id)).offer.status !== 'PENDING', async () => undefined), { kind: 'ghost' }));
      }
      return [
        sellerLink(scope === 'incoming' ? offer.maker : offer.owner),
        nameButton(offer.name),
        obsUnit(offer.amountSeals),
        statusBadge(offer),
        when(offer.createdAt),
        el('div', { class: 'row' }, ...actions),
      ];
    }),
  );
}

// ── the feed ───────────────────────────────────────────────────────────────────────────────────────────────────

let feedSort: 'newest' | 'price_asc' | 'price_desc' | 'name' = 'newest';
let feedOffset = 0;
const FEED_PAGE = 20;

async function drawFeed(): Promise<void> {
  try {
    const page = await client.marketListings({ sort: feedSort, limit: FEED_PAGE, offset: feedOffset });
    const sort = el('select', { id: 'market-sort' }, ...([['newest', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['name', 'Name']] as const).map(([value, label]) => el('option', { value, selected: value === feedSort ? 'selected' : undefined }, label)));
    sort.addEventListener('change', () => {
      feedSort = (sort as HTMLSelectElement).value as typeof feedSort;
      feedOffset = 0;
      void drawFeed();
    });
    feedPanel.replaceChildren(
      el('h2', {}, 'ONS Marketplace'),
      el('p', { class: 'muted' }, `${page.total} name${page.total === 1 ? '' : 's'} listed for a fixed price. Every listing is chain state.`),
      el('div', { class: 'row' }, el('label', { for: 'market-sort' }, 'Sort '), sort),
      page.listings.length === 0
        ? el('p', { class: 'muted' }, 'Nothing is listed yet.')
        : table(
            ['Name', 'Price', 'Seller', 'Offers', ''],
            page.listings.map((listing) => [
              nameButton(listing.name),
              obsUnit(listing.priceSeals),
              sellerLink(listing.seller),
              String(listing.pendingOffers),
              button('View', async () => doLookup(listing.name), { kind: 'ghost' }),
            ]),
          ),
      el(
        'div',
        { class: 'row' },
        button('Previous', async () => { feedOffset = Math.max(0, feedOffset - FEED_PAGE); await drawFeed(); }, { kind: 'ghost', disabled: feedOffset === 0 }),
        button('Next', async () => { feedOffset += FEED_PAGE; await drawFeed(); }, { kind: 'ghost', disabled: !page.hasMore }),
      ),
    );
  } catch (error) {
    feedPanel.replaceChildren(el('h2', {}, 'ONS Marketplace'), el('p', { class: 'error' }, `Listings could not be read from a node: ${(error as Error).message}`));
  }
}

// ── your names, your offers, your escrow ──────────────────────────────────────────────────────────────────────

async function drawMine(): Promise<void> {
  const me = mine();
  if (!me) {
    minePanel.replaceChildren(el('h2', {}, 'Your names and offers'), el('p', { class: 'muted' }, 'Open your wallet to list names, make offers and see locked funds.'));
    return;
  }
  try {
    const [balance, incoming, outgoing, events] = await Promise.all([
      client.balance(me),
      client.marketOffers('incoming', me),
      client.marketOffers('outgoing', me),
      client.marketEvents({ address: me, limit: 20 }).catch(() => ({ events: [] })),
    ]);
    const statuses = await Promise.all(balance.names.map((full) => client.marketName(bare(full)).then((status) => ({ full, status }))));
    const rows = statuses.map(({ full, status }) => {
      const input = el('input', { placeholder: 'Price in OBS', inputmode: 'decimal', autocomplete: 'off', value: '' });
      const actions: HTMLElement[] = [];
      if (status.status === 'LISTED' || status.status === 'OWNED') actions.push(manageButton(full));
      if (status.status === 'LISTED') {
        actions.push(
          button('Update price', () => perform(`Update price of ${full}`, (w) => operations.updateListingPrice(client, w, { name: full, priceObs: (input as HTMLInputElement).value }), async () => (await client.marketName(bare(full))).listing?.priceSeals !== status.listing?.priceSeals, async () => undefined), { kind: 'ghost' }),
          button('Remove listing', () => perform(`Remove listing of ${full}`, (w) => operations.removeListing(client, w, { name: full }), async () => !(await client.marketName(bare(full))).locked, async () => undefined), { kind: 'danger' }),
        );
      } else if (status.status === 'OWNED') {
        actions.push(button('List for sale', () => perform(`List ${full}`, (w) => operations.listName(client, w, { name: full, priceObs: (input as HTMLInputElement).value }), async () => (await client.marketName(bare(full))).status === 'LISTED', async () => undefined), { kind: 'primary' }));
      }
      return [
        nameButton(full),
        status.status === 'LISTED' && status.listing ? [badge('LISTED', 'ok'), ' ', obsUnit(status.listing.priceSeals)] : badge(status.status === 'OWNED' ? 'ACTIVE' : status.status, 'neutral'),
        status.status === 'EXPIRED' ? '' : input,
        el('div', { class: 'row' }, ...actions),
      ] as Array<Node | string>;
    });
    const pendingIn = incoming.offers.filter((offer) => offer.status === 'PENDING');
    minePanel.replaceChildren(
      el('h2', {}, 'Your names and offers'),
      kv([
        ['Spendable', obsExact(balance.spendableSeals ?? balance.balanceSeals)],
        ['Locked in offers (escrow)', obsExact(balance.lockedSeals)],
        ['Total', obsExact(balance.totalSeals ?? balance.balanceSeals)],
      ]),
      el('p', { class: 'fineprint' }, 'Locked funds belong to you and return in full when an offer is declined, cancelled, lapses or becomes invalid. They cannot be spent while locked. Gas for an offer is charged separately and never comes from escrow.'),
      el('h3', {}, 'Your names'),
      rows.length === 0 ? '' : el('p', { class: 'fineprint' }, 'Press Manage on a name to change the address it points to, offer it to another wallet, or set a recovery address.'),
      rows.length === 0 ? el('p', { class: 'muted' }, 'This wallet owns no names.') : table(['Name', 'Status', 'Price', 'Actions'], rows),
      el('p', { class: 'fineprint' }, 'A listed name is locked: you cannot edit, transfer, renew or recover it until you remove the listing or it sells. Listing a name refunds any offers already made on it.'),
      el('h3', {}, `Offers made to you (${pendingIn.length} pending)`),
      incoming.offers.length === 0 ? el('p', { class: 'muted' }, 'No offers.') : offerTable(incoming.offers, 'incoming'),
      el('h3', {}, 'Offers you made'),
      outgoing.offers.length === 0 ? el('p', { class: 'muted' }, 'No offers.') : offerTable(outgoing.offers, 'outgoing'),
      el('h3', {}, 'Marketplace history'),
      events.events.length === 0
        ? el('p', { class: 'muted' }, 'No Marketplace activity for this wallet in the node index.')
        : table(
            ['Event', 'Name', 'Height', 'Transaction'],
            events.events.map((event) => [event.type.replace(/^ONS_/, '').replace(/_/g, ' '), String(event.data.name ?? '—'), String(event.height), event.txId ? shortId(event.txId) : '—']),
          ),
      el('p', { class: 'fineprint' }, 'History is a convenience read from the node index, which is rebuilt from the chain and is never authoritative.'),
    );
  } catch (error) {
    clear(minePanel);
    minePanel.append(el('h2', {}, 'Your names and offers'), el('p', { class: 'error' }, `Could not read your Marketplace state from a node: ${(error as Error).message}`));
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
    // The protocol's own rule (length, characters, hyphens, reserved names), not a copy of it.
    try {
      validateNameFormat(value);
    } catch (error) {
      return toast((error as Error).message, 'error');
    }
    const passphrase = window.prompt('Unlock your wallet passphrase to sign the registration');
    if (!passphrase) return;
    try {
      const wallet = await Wallet.unlock(passphrase);
      if (priceObs === undefined) return toast('This page could not read the registration fee from a node, so it will not guess one.', 'error');
      const result = await operations.registerName(client, wallet, { name: `${value}.obs`, feeObs: priceObs });
      toast(`Registration signed and submitted: ${shortId(result.txId)}`, 'success');
      await doLookup(`${value}.obs`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });

  registerPanel.replaceChildren(
    el('h2', {}, 'Register a name'),
    priceObs !== undefined
      ? kv([
          ['Registration fee', obsUnit(priceObs)],
          ['Renewal fee', `${obsUnit(renewalObs)} per term`],
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
              identifier(record.address === undefined || record.address === null ? undefined : String(record.address), { kind: 'address', label: 'Wallet address' }),
              String(record.registeredAtHeight ?? '—'),
              String(record.expiresAt ?? '—'),
            ]),
          ),
    );
  } catch (error) {
    recentPanel.replaceChildren(el('h2', {}, 'Registered names'), el('p', { class: 'error' }, (error as Error).message));
  }
}

// Last on purpose: the module-level state above (`feedSort`, helpers) must exist before the first read runs.
void boot();
