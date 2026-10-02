/**
 * Obsidian Circle — the land registry.
 *
 * Navigation is geographic: Earth → country → state/region → city → district →
 * street → parcel. Every parcel has a GLV (Government Land Value, set by the
 * first-level division), an ILV (Individual Land Value, what the protocol pays
 * on a buyback) and an MSP (Market Sale Price, what the owner asks).
 *
 * The pricing rules this page must respect, because the protocol enforces them:
 *   - protocol sales release at most one plot of ≤1 m² per transaction and
 *     update the GLV between purchases, so a buyer never retroactively benefits
 *     from earlier demand;
 *   - the marketplace never changes the GLV — only the protocol market does;
 *   - a buyback pays the current GLV and reduces it;
 *   - gifting a parcel is a standard transfer and pays standard gas.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { Wallet } from '../lib/wallet.js';
import { operations } from '../lib/operations.js';
import { el, obs, spinner, toast, kv, table, short } from '../lib/ui.js';

const client = new ObsidianClient();
const navigation = el('section', { class: 'card' }, spinner('loading the atlas…'));
const parcelsPanel = el('section', { class: 'card' }, spinner());
const detailPanel = el('section', { class: 'card', id: 'parcel-detail' }, el('p', { class: 'muted' }, 'Search a parcel, or pick a division to see what the protocol market can release.'));

const search = el('input', { id: 'circle-search', placeholder: 'Country, state, city, district, street, landmark or GPS (lat,lon)', autocomplete: 'off' });
const go = el('button', { class: 'primary', type: 'button' }, 'Search land');
go.addEventListener('click', () => void searchLand(search.value.trim()));
search.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Enter') void searchLand(search.value.trim());
});

layout({
  current: 'circle',
  title: 'Obsidian Circle',
  tagline: 'From Earth down to a single square metre, with prices the protocol sets and the market cannot bend.',
  children: [
    el(
      'section',
      { class: 'notice' },
      el('strong', {}, 'Pricing, in one paragraph. '),
      'Each first-level division (a state, a province, a governorate) carries a GLV denominated in OBS, inside the protocol band, set once at deployment. Buying from the protocol releases one plot of at most 1 m² at the current GLV, and the purchase itself raises the GLV by 25 basis points up to the ceiling — buyers never get a discount from later buyers\' demand, and never benefit retroactively from their own. ' +
        'Owners may list parcels at any MSP on the marketplace; listing never moves the GLV. A buyback pays the current GLV to the owner and reduces the GLV. Gifts are ordinary transfers and pay ordinary gas.',
    ),
    el('section', { class: 'search-bar' }, search, go),
    navigation,
    parcelsPanel,
    detailPanel,
  ],
});

void boot();

async function boot(): Promise<void> {
  try {
    const { countries } = await client.landCountries();
    const byContinent = new Map<string, typeof countries>();
    for (const country of countries) {
      const key = country.continent || 'Other';
      byContinent.set(key, [...(byContinent.get(key) ?? []), country]);
    }
    const sections = [...byContinent.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([continent, entries]) =>
        el(
          'section',
          { class: 'continent' },
          el('h3', {}, `${continent} (${entries.length})`),
          el(
            'div',
            { class: 'country-grid' },
            ...entries.map((country) => {
              const open = el('button', { class: 'country-card', type: 'button', id: `country-${country.code}` });
              open.append(
                el('strong', {}, country.name),
                el('span', { class: 'mono' }, country.code),
                el('span', { class: 'muted' }, `${country.divisionCount} division${country.divisionCount === 1 ? '' : 's'} · GLV ${obs(country.glvObs)} OBS`),
              );
              open.addEventListener('click', () => void loadDivisions(country.code, country.name));
              return open;
            }),
          ),
        ),
      );
    navigation.replaceChildren(
      el('h2', {}, 'Atlas'),
      el('p', { class: 'muted' }, `${countries.length} countries from the protocol geography table. Pick a country, then a first-level division, to price a plot of at most one square metre.`),
      ...sections,
    );
  } catch (error) {
    navigation.replaceChildren(el('h2', {}, 'Atlas'), el('p', { class: 'error' }, (error as Error).message));
  }
}

/** Earth → country → division. Divisions come from the node's registry route. */
async function loadDivisions(countryCode: string, countryName: string): Promise<void> {
  detailPanel.replaceChildren(spinner(`loading divisions of ${countryName}…`));
  try {
    const { divisions, count } = await client.landDivisions(countryCode);
    detailPanel.replaceChildren(
      el('h2', {}, `${countryName} (${countryCode})`),
      el('p', { class: 'muted' }, `${count} first-level divisions carry a GLV on this chain.`),
      divisions.length === 0
        ? el('p', { class: 'muted' }, 'This country has no divisions configured in the protocol table.')
        : table(
            ['Division', 'GLV now', 'Protocol purchases', 'Buy-backs', 'Price a plot'],
            divisions.map((division) => {
              const price = el('button', { class: 'link-button', type: 'button' }, 'quote 1 m²');
              price.addEventListener('click', () => void showDivision(countryCode, division.divisionId, division.name));
              return [
                el('span', {}, `${division.name} `, el('span', { class: 'mono muted' }, division.divisionId)),
                `${obs(division.glvObs)} OBS`,
                String(division.protocolPurchases),
                String(division.protocolBuybacks),
                price,
              ];
            }),
          ),
    );
  } catch (error) {
    detailPanel.replaceChildren(el('h2', {}, countryName), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function showDivision(countryCode: string, divisionId: string, divisionName: string): Promise<void> {
  detailPanel.replaceChildren(spinner(`pricing ${divisionId}…`));
  try {
    // The band comes from the node's parameter table, in OBS. It used to be
    // described on this page as "$100 to $30,000 per m²", which stopped being
    // true when land was repriced into OBS in 1.2.0.
    const [quote, params] = await Promise.all([client.landQuote(divisionId), client.params().catch(() => undefined)]);
    const band = params ? `${obs(params.circle.minGlvObs)} – ${obs(params.circle.maxGlvObs)} OBS / m²` : 'read from the node';
    detailPanel.replaceChildren(
      el('h2', {}, `${divisionName} · ${divisionId}`),
      kv([
        ['GLV now', `${obs(quote.glvObs)} OBS / m²`],
        ['Protocol price for 1 m²', quote.priceObs ? `${obs(quote.priceObs)} OBS` : '—'],
        ['Gas for that purchase', quote.gasObs ? `${obs(quote.gasObs)} OBS` : '—'],
        ['Protocol band', band],
        ['Priced in', 'OBS — no external price source participates'],
        ['Buy-back value (ILV)', 'current GLV at buy-back time on chain'],
      ]),
      el('p', { class: 'fineprint' }, quote.note),
      el('div', { class: 'row' }, buyButton(countryCode, divisionId)),
      el('p', { class: 'fineprint' }, 'One plot of at most 1 m² per transaction, and the GLV moves between purchases — the next buyer pays the updated price, never a stale one.'),
    );
    void loadParcels(divisionId);
  } catch (error) {
    detailPanel.replaceChildren(el('h2', {}, `${divisionName} · ${divisionId}`), el('p', { class: 'error' }, (error as Error).message));
  }
}

function buyButton(countryCode: string, divisionId: string): HTMLElement {
  const button = el(
    'button',
    { class: 'primary', type: 'button' },
    'Buy 1 m² from the protocol market',
  );
  button.addEventListener('click', async () => {
    const passphrase = window.prompt('Unlock your wallet passphrase to buy this plot');
    if (!passphrase) return;
    try {
      const wallet = await Wallet.unlock(passphrase);
      const result = await operations.buyParcel(client, wallet, { divisionId, countryCode, level: 1, subId: '', plotIndex: 0n });
      toast(`Parcel purchase signed and submitted: ${result.txId.slice(0, 16)}…`, 'success');
      void loadParcels(divisionId);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });
  return button;
}

async function loadParcels(divisionId: string): Promise<void> {
  parcelsPanel.replaceChildren(spinner());
  try {
    const { parcels, total } = await client.landParcels({ divisionId, limit: 25 });
    parcelsPanel.replaceChildren(
      el('h2', {}, `Parcels in this division (${total} on chain)`),
      parcels.length === 0
        ? el('p', { class: 'muted' }, 'No parcel has been released by the protocol market in this division yet.')
        : table(
            ['Parcel', 'Owner', 'Area', 'GLV now', 'ILV', 'MSP', 'Issued at'],
            parcels.map((parcel) => [
              el('span', { class: 'mono' }, short(parcel.parcelId, 12)),
              el('span', { class: 'mono' }, short(parcel.owner, 10)),
              `${parcel.squareMetres} m²`,
              `${obs(parcel.glvObs)} OBS`,
              parcel.ilvObs ? `${obs(parcel.ilvObs)} OBS` : el('span', { class: 'muted' }, '—'),
              parcel.mspObs ? `${obs(parcel.mspObs)} OBS` : el('span', { class: 'muted' }, 'not listed'),
              String(parcel.issuedAtHeight ?? '—'),
            ]),
          ),
      el('p', { class: 'fineprint' }, 'Owner addresses are masked by the node before they leave it. A parcel is chain state: a transfer is a signed transaction, never a row in a company database.'),
    );
  } catch (error) {
    parcelsPanel.replaceChildren(el('h2', {}, 'Parcels in this division'), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function searchLand(term: string): Promise<void> {
  if (!term) return;
  parcelsPanel.replaceChildren(spinner(`searching “${term}”…`));
  try {
    const { results } = await client.landSearch(term);
    parcelsPanel.replaceChildren(
      el('h2', {}, `Results for “${term}”`),
      results.length === 0
        ? el('p', { class: 'muted' }, 'No division matched. Search matches country names, country codes, division names and division ids from the protocol table.')
        : table(
            ['Division', 'Id', 'GLV now', 'Country', 'Price a plot'],
            results.map((hit) => {
              const price = el('button', { class: 'link-button', type: 'button' }, 'quote 1 m²');
              price.addEventListener('click', () => void showDivision(hit.countryCode, hit.divisionId, hit.name));
              const glv = `${obs(hit.glvObs ?? '0')} OBS`;
              return [
                el('span', {}, hit.name),
                el('span', { class: 'mono' }, hit.divisionId),
                glv,
                el('span', { class: 'mono' }, hit.countryCode),
                price,
              ];
            }),
          ),
      el('p', { class: 'fineprint' }, 'Every GLV above is derived by the node from the shipped geography table plus this chain\'s purchase and buy-back history.'),
    );
  } catch (error) {
    parcelsPanel.replaceChildren(el('h2', {}, 'Search'), el('p', { class: 'error' }, (error as Error).message));
  }
}
