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
import { el, obs, usd, spinner, toast, kv, badge, table, short } from '../lib/ui.js';

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
      'Each first-level division (a state, a province, a governorate) carries a GLV from $100 to $30,000 per m², set once at deployment. Buying from the protocol releases one plot of at most 1 m² at the current GLV, and the purchase itself raises the GLV by 25 basis points up to the $30,000 ceiling — buyers never get a discount from later buyers\' demand, and never benefit retroactively from their own. ' +
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
    const cards = countries.map((country) => {
      const code = String(country.code ?? '');
      const divisions = (country.divisions as Array<Record<string, unknown>> | undefined) ?? [];
      const list = el('ul', {});
      for (const division of divisions.slice(0, 10)) {
        const item = el('li', {});
        const open = el('button', { class: 'link-button', type: 'button' }, String(division.name ?? division.id ?? '—'));
        open.addEventListener('click', () => void showDivision(code, division));
        item.append(open, el('span', { class: 'muted' }, ` GLV ${usd(String(division.glvUsdMicro ?? '0'))}`));
        list.append(item);
      }
      return el(
        'article',
        { class: 'country-card' },
        el('strong', {}, String(country.name ?? (code || '—'))),
        el('span', { class: 'mono' }, code),
        divisions.length > 0 ? list : el('p', { class: 'muted' }, 'No divisions configured.'),
      );
    });
    navigation.replaceChildren(
      el('h2', {}, 'Atlas'),
      el('p', { class: 'muted' }, `${countries.length} countries with divisions configured on this chain. Pick a division to price a plot of at most one square metre.`),
      el('div', { class: 'country-grid' }, ...cards.slice(0, 60)),
    );
  } catch (error) {
    navigation.replaceChildren(el('h2', {}, 'Atlas'), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function showDivision(countryCode: string, division: Record<string, unknown>): Promise<void> {
  const divisionId = String(division.id ?? '');
  detailPanel.replaceChildren(spinner(`pricing ${divisionId}…`));
  try {
    const quote = await client.landQuote(divisionId);
    detailPanel.replaceChildren(
      el('h2', {}, `${division.name ?? divisionId}`),
      kv([
        ['Division id', el('span', { class: 'mono' }, divisionId)],
        ['Level', String(division.level ?? '1 (first-level division)')],
        ['GLV now', `${usd(String(quote.glvUsdMicro ?? division.glvUsdMicro ?? '0'))} / m²`],
        ['Protocol price for 1 m²', `${obs(String(quote.priceObs ?? '0'))} OBS`],
        ['Protocol price source', String(quote.priceSource ?? 'protocol oracle median (2+ independent sources)')],
        ['Purchases recorded', String(quote.purchases ?? '—')],
      ]),
      el('div', { class: 'row' }, buyButton(countryCode, divisionId)),
      el('p', { class: 'fineprint' }, 'One plot of at most 1 m² per transaction, and the GLV moves between purchases — the next buyer pays the updated price, never a stale one.'),
    );
    void loadParcels(divisionId);
  } catch (error) {
    detailPanel.replaceChildren(el('h2', {}, String(division.name ?? divisionId)), el('p', { class: 'error' }, (error as Error).message));
  }
}

function buyButton(countryCode: string, divisionId: string): HTMLElement {
  const button = el('button', { class: 'primary', type: 'button' }, 'Buy 1 m² from the protocol market');
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
    const { parcels } = await client.landParcels({ divisionId, limit: 25 });
    parcelsPanel.replaceChildren(
      el('h2', {}, 'Parcels in this division'),
      parcels.length === 0
        ? el('p', { class: 'muted' }, 'No parcels sold in this division yet.')
        : table(
            ['Parcel', 'Owner', 'Area', 'GLV at purchase', 'Official value now', 'MSP', 'State'],
            parcels.map((parcel) => [
              el('span', { class: 'mono' }, short(String(parcel.parcelId ?? parcel.id ?? ''), 10)),
              el('span', { class: 'mono' }, short(String(parcel.owner ?? ''), 10)),
              `${parcel.areaCm2 ? `${(Number(parcel.areaCm2) / 10_000).toFixed(2)} m²` : '1.00 m²'}`,
              usd(String(parcel.glvUsdMicroAtPurchase ?? parcel.glvUsdMicro ?? '0')),
              usd(String(parcel.officialValueUsdMicro ?? '0')),
              parcel.mspObs ? `${obs(String(parcel.mspObs))} OBS` : el('span', { class: 'muted' }, 'not listed'),
              parcel.listed ? badge('listed', 'ok') : badge('owned', 'neutral'),
            ]),
          ),
    );
  } catch (error) {
    parcelsPanel.replaceChildren(el('h2', {}, 'Parcels in this division'), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function searchLand(term: string): Promise<void> {
  if (!term) return;
  parcelsPanel.replaceChildren(spinner(`searching “${term}”…`));
  try {
    const result = await client.landSearch(term);
    const parcels = (result.parcels as Array<Record<string, unknown>> | undefined) ?? [];
    const divisions = (result.divisions as Array<Record<string, unknown>> | undefined) ?? [];
    parcelsPanel.replaceChildren(
      el('h2', {}, `Results for “${term}”`),
      divisions.length > 0
        ? table(['Division', 'Level', 'GLV', 'Country'], divisions.map((division) => [String(division.name ?? division.id ?? '—'), String(division.level ?? '—'), usd(String(division.glvUsdMicro ?? '0')), String(division.countryCode ?? '—')]))
        : el('p', { class: 'muted' }, 'No division matched.'),
      parcels.length > 0
        ? table(
            ['Parcel', 'Owner', 'Division', 'Listed at'],
            parcels.map((parcel) => [
              el('span', { class: 'mono' }, short(String(parcel.parcelId ?? ''), 12)),
              el('span', { class: 'mono' }, short(String(parcel.owner ?? ''), 12)),
              String(parcel.divisionId ?? parcel.division ?? '—'),
              parcel.mspObs ? `${obs(String(parcel.mspObs))} OBS` : '—',
            ]),
          )
        : el('p', { class: 'muted' }, 'No parcel matched (try a country, a state, a district, or “lat,lon”).'),
    );
  } catch (error) {
    parcelsPanel.replaceChildren(el('h2', {}, 'Search'), el('p', { class: 'error' }, (error as Error).message));
  }
}

