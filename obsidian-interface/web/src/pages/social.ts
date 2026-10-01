/**
 * OBS Social.
 *
 * Feed, posts, comments, follows, messages, tipping and business pages — all of
 * them chain state. Two rules matter for the design:
 *   - an account id is an opaque 8–64 character application identifier, never a
 *     wallet address and never derived from an email or a Google subject;
 *   - a tip pays the creator and the creator alone; a business page costs the
 *     protocol's $50-equivalent in OBS and that money goes to the treasury.
 * Direct messages are end-to-end encrypted in the browser; the ciphertext is
 * what a DM transaction would carry, so the interface server can never read one.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { Wallet } from '../lib/wallet.js';
import { operations, randomHex } from '../lib/operations.js';
import { el, obs, obsFromSeals, spinner, toast, kv, short, when } from '../lib/ui.js';

const client = new ObsidianClient();
const feed = el('section', { class: 'card', id: 'feed' }, spinner('reading the feed from the chain…'));
const profilePanel = el('section', { class: 'card', id: 'profile' });
const composer = el('section', { class: 'card', id: 'composer' });

layout({
  current: 'social',
  title: 'OBS Social',
  tagline: 'Posts, follows, tips and business pages that live on the chain — not in an advertising company\'s database.',
  children: [
    el(
      'section',
      { class: 'notice' },
      el('strong', {}, 'What this is not. '),
      'There is no signup form here that mints an account, no algorithm deciding reach, and no server that can delete your posts. A profile is a transaction, a post is a transaction, a follow is a transaction. ' +
        'That also means each of them costs gas — tiny, but real, because every node stores them forever.',
    ),
    profilePanel,
    composer,
    feed,
  ],
});

void boot();

async function boot(): Promise<void> {
  drawProfilePanel();
  drawComposer();
  void loadFeed();
  window.setInterval(() => void loadFeed(), 20_000);
}

function drawProfilePanel(): void {
  const accountId = el('input', { id: 'social-account-id', placeholder: 'Account id (8–64 chars: letters, digits, _ and -)', value: localStorage.getItem('obsidian.social.accountId') ?? '' });
  const handle = el('input', { id: 'social-handle', placeholder: 'Handle', value: localStorage.getItem('obsidian.social.handle') ?? '' });
  const display = el('input', { id: 'social-display', placeholder: 'Display name' });
  const bio = el('input', { id: 'social-bio', placeholder: 'Bio' });
  const save = el('button', { class: 'primary', type: 'button' }, 'Publish profile to the chain');
  save.addEventListener('click', async () => {
    const id = accountId.value.trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return toast('Account ids are 8–64 characters of letters, digits, underscore or hyphen.', 'error');
    const passphrase = window.prompt('Unlock your wallet to sign the profile');
    if (!passphrase) return;
    try {
      const wallet = await Wallet.unlock(passphrase);
      await operations.setProfile(client, wallet, { accountId: id, handle: handle.value.trim(), displayName: display.value.trim(), bio: bio.value.trim() });
      localStorage.setItem('obsidian.social.accountId', id);
      localStorage.setItem('obsidian.social.handle', handle.value.trim());
      toast('Profile transaction signed and submitted.', 'success');
      void loadProfile(id);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });
  const suggest = el('button', { class: 'ghost', type: 'button' }, 'Suggest an id');
  suggest.addEventListener('click', () => {
    accountId.value = randomHex(8);
    toast('Random id generated — a profile id must not be derived from anything personal.', 'info');
  });

  profilePanel.replaceChildren(
    el('h2', {}, 'Your account'),
    kv([
      ['Wallet', el('span', { class: 'mono' }, Wallet.storedAddress() ?? 'no wallet in this browser — create one first')],
      ['Account id', 'opaque, random, and unrelated to your wallet address'],
    ]),
    el('div', { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', { for: 'social-account-id' }, 'Account id'), accountId),
      el('div', { class: 'field' }, el('label', { for: 'social-handle' }, 'Handle'), handle)),
    el('div', { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', { for: 'social-display' }, 'Display name'), display),
      el('div', { class: 'field' }, el('label', { for: 'social-bio' }, 'Bio'), bio)),
    el('div', { class: 'row' }, save, suggest, el('a', { class: 'ghost as-link', href: '/wallet/' }, 'Create wallet')),
    el('p', { class: 'fineprint' }, 'The protocol requires a profile before you can post, tip or open a business page — one transaction, then everything else follows.'),
  );
}

function drawComposer(): void {
  const content = el('textarea', { id: 'post-content', rows: '4', placeholder: 'Say something worth writing to a public ledger…' });
  const publish = el('button', { class: 'primary', type: 'button' }, 'Publish post');
  publish.addEventListener('click', async () => {
    const accountId = localStorage.getItem('obsidian.social.accountId');
    if (!accountId) return toast('Publish a profile first.', 'error');
    if (!content.value.trim()) return toast('Write something first.', 'error');
    const passphrase = window.prompt('Unlock your wallet to sign the post');
    if (!passphrase) return;
    try {
      const wallet = await Wallet.unlock(passphrase);
      await operations.post(client, wallet, { accountId, content: content.value.trim() });
      content.value = '';
      toast('Post signed and submitted.', 'success');
      void loadFeed();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });
  composer.replaceChildren(
    el('h2', {}, 'Compose'),
    content,
    el('div', { class: 'row' }, publish, el('span', { class: 'fineprint' }, 'Posts are permanent: the gas you pay is the price of that permanence.')),
  );
}

async function loadFeed(): Promise<void> {
  try {
    const { posts } = await client.socialFeed(30);
    feed.replaceChildren(
      el('h2', {}, 'Feed'),
      posts.length === 0
        ? el('p', { class: 'muted' }, 'No posts on this chain yet. The first post sets the bar.')
        : el(
            'ul',
            { class: 'feed social-feed' },
            ...posts.map((post) => {
              const accountId = post.authorAccountId;
              const tipAmount = el('input', { class: 'tip-input', placeholder: 'Tip (OBS)', value: '1' });
              const tip = el('button', { class: 'ghost small', type: 'button' }, 'Tip');
              tip.addEventListener('click', () => void tipPost(accountId, String(post.postId ?? ''), tipAmount.value));
              const follow = el('button', { class: 'ghost small', type: 'button' }, 'Follow');
              follow.addEventListener('click', () => void followAccount(accountId));
              return el(
                'li',
                { class: 'post' },
                el(
                  'header',
                  {},
                  el('strong', {}, `@${accountId}`),
                  el('span', { class: 'mono muted' }, short(post.author, 14)),
                  el('span', { class: 'muted' }, when(post.createdAt)),
                ),
                el('p', {}, String(post.content ?? '')),
                el('footer', {}, tipAmount, tip, follow, el('span', { class: 'muted' }, `${post.likes} like${post.likes === 1 ? '' : 's'} · block ${post.createdAtHeight}`)),
              );
            }),
          ),
    );
  } catch (error) {
    feed.replaceChildren(el('h2', {}, 'Feed'), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function loadProfile(accountId: string): Promise<void> {
  try {
    const profile = await client.socialProfile(accountId);
    toast(`Profile for ${accountId} is on chain.`, 'success');
    void profile;
  } catch {
    /* the feed refresh will surface it once mined */
  }
}

async function tipPost(targetAccountId: string, target: string, amountObs: string): Promise<void> {
  const accountId = localStorage.getItem('obsidian.social.accountId');
  if (!accountId) return toast('Publish a profile first.', 'error');
  const passphrase = window.prompt('Unlock your wallet to tip');
  if (!passphrase) return;
  try {
    const wallet = await Wallet.unlock(passphrase);
    await operations.tip(client, wallet, { accountId, targetAccountId, target, amountObs });
    toast('Tip signed and submitted — 100% of it goes to the creator.', 'success');
  } catch (error) {
    toast((error as Error).message, 'error');
  }
}

async function followAccount(targetAccountId: string): Promise<void> {
  const accountId = localStorage.getItem('obsidian.social.accountId');
  if (!accountId) return toast('Publish a profile first.', 'error');
  const passphrase = window.prompt('Unlock your wallet to follow');
  if (!passphrase) return;
  try {
    const wallet = await Wallet.unlock(passphrase);
    await operations.follow(client, wallet, { accountId, targetAccountId });
    toast('Follow recorded on chain.', 'success');
  } catch (error) {
    toast((error as Error).message, 'error');
  }
}

/** Business pages: a flat OBS price, paid to the treasury, split 70/30 on page revenue. */
export async function businessPage(accountId: string): Promise<void> {
  // The price is a consensus parameter in OBS, read from this node's /params.
  // It used to be a dollar amount converted at an oracle median, which meant a
  // chain with no price feed could not sell a business page at all.
  let priceObs: string;
  try {
    priceObs = (await client.params()).social.businessPagePriceObs;
  } catch (error) {
    toast(`Could not read the business page price from a node: ${(error as Error).message}`, 'error');
    return;
  }
  const passphrase = window.prompt(`A business page costs ${priceObs} OBS, paid to the treasury. Unlock to continue.`);
  if (!passphrase) return;
  try {
    const wallet = await Wallet.unlock(passphrase);
    await operations.buyBusinessPage(client, wallet, { accountId, priceObs });
    toast('Business page purchase signed and submitted. Creator split: 70% to you, 30% to the treasury.', 'success');
  } catch (error) {
    toast((error as Error).message, 'error');
  }
}

