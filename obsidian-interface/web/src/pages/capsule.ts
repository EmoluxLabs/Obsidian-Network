/**
 * Time Capsule Wall.
 *
 * Rules that shape this page:
 *   - content is sealed client-side (AES-GCM) and only its commitment goes on
 *     chain, so the chain never holds a readable secret;
 *   - the creator locks at least 0.0001 OBS and cannot take it back: at the
 *     unlock block the commitment transfers to the Mining Pool automatically,
 *     whether or not the creator is online;
 *   - a Time Travel preview costs 1000× the creator's commitment, goes entirely
 *     to the Mining Pool, and is allowed once per capsule per account for 30
 *     seconds of preview.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { Wallet } from '../lib/wallet.js';
import { operations, commitContent, randomHex } from '../lib/operations.js';
import { el, obs, obsFromSeals, sealsFromObs, spinner, toast, kv, badge, table, short, when, relativeTime } from '../lib/ui.js';

const client = new ObsidianClient();
const wall = el('section', { class: 'card' }, spinner('reading the wall…'));
const stats = el('section', { class: 'stat-grid' }, spinner());
const composer = el('section', { class: 'card', id: 'compose' });

layout({
  current: 'capsule',
  title: 'Time Capsule Wall',
  tagline: 'Seal something today. The chain holds the commitment and the lock — and it opens without you.',
  children: [
    el(
      'section',
      { class: 'notice' },
      el('strong', {}, 'Honest engineering note. '),
      'The encrypted payload never touches the chain and the interface never stores it either — keep your export file. At unlock time the protocol transfers the locked commitment to the Mining Pool by state transition (nobody has to come online), ' +
        'and only then will a REVEAL transaction let the chain record the payload key. Content that must stay secret until unlock is the ciphertext in your file; a preview shows only the teaser you published.',
    ),
    composer,
    stats,
    wall,
  ],
});

void boot();

async function boot(): Promise<void> {
  drawComposer();
  void loadStats();
  void loadWall();
  window.setInterval(() => void loadWall(), 30_000);
}

function drawComposer(): void {
  const content = el('textarea', { id: 'capsule-content', rows: '6', placeholder: 'What do you want to say to the future?' });
  const teaser = el('input', { id: 'capsule-teaser', placeholder: 'Public teaser — shown to everyone, forever' });
  const unlock = el('input', { id: 'capsule-unlock', type: 'datetime-local', value: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16) });
  const commitment = el('input', { id: 'capsule-commit', placeholder: 'Locked commitment in OBS (minimum 0.0001)', value: '0.0001' });
  const seal = el('button', { class: 'primary', type: 'button', id: 'capsule-seal' }, 'Encrypt, seal and publish');
  const output = el('div', { id: 'capsule-output' });

  seal.addEventListener('click', async () => {
    if (!content.value.trim()) return toast('Write something first.', 'error');
    const passphrase = window.prompt('Unlock your wallet passphrase to sign the capsule');
    if (!passphrase) return;
    seal.disabled = true;
    seal.textContent = 'Encrypting locally…';
    try {
      const wallet = await Wallet.unlock(passphrase);
      const nonce = randomHex(12);
      const { commitment: digest, bytes } = await commitContent(content.value, nonce);
      seal.textContent = 'Signing…';
      const unlockAt = Math.floor(new Date(unlock.value).getTime() / 1000);
      const result = await operations.createCapsule(client, wallet, {
        contentCommitment: digest,
        contentNonce: nonce,
        unlockAt,
        commitmentObs: commitment.value.trim(),
        contentBytes: bytes,
      });
      const file = capsuleFile({ digest, nonce, content: content.value, teaser: teaser.value, unlockAt, address: wallet.address });
      const blob = new Blob([file], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      output.replaceChildren(
        el('h3', {}, 'Sealed'),
        kv([
          ['Capsule id', el('span', { class: 'mono' }, result.txId.slice(0, 24))],
          ['Content commitment', el('span', { class: 'mono' }, short(digest, 16))],
          ['Unlocks', `${when(unlockAt)} (${relativeTime(unlockAt)})`],
          ['Locked commitment', `${commitment.value} OBS (minimum 0.0001)`],
        ]),
        el('p', {}, 'Download the capsule file now — it is the only copy of the key and the text. The chain holds the commitment, not the content.'),
        el('a', { class: 'primary as-link', href: url, download: `obsidian-capsule-${digest.slice(0, 12)}.txt` }, 'Download capsule file'),
      );
      toast('Capsule transaction signed and submitted.', 'success');
      void loadWall();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      seal.disabled = false;
      seal.textContent = 'Encrypt, seal and publish';
    }
  });

  composer.replaceChildren(
    el('h2', {}, 'Seal a capsule'),
    el('div', { class: 'field' }, el('label', { for: 'capsule-content' }, 'Secret content (never leaves this browser)'), content),
    el('div', { class: 'field' }, el('label', { for: 'capsule-teaser' }, 'Public teaser'), teaser),
    el('div', { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', { for: 'capsule-unlock' }, 'Unlock at (your local time)'), unlock),
      el('div', { class: 'field' }, el('label', { for: 'capsule-commit' }, 'Locked commitment (OBS)'), commitment)),
    el('div', { class: 'row' }, seal),
    el('p', { class: 'fineprint' }, 'The lock is not a balance: it is removed from circulation while the capsule is sealed and handed to the Mining Pool at unlock. Plan to lose it — that is what makes the capsule honest.'),
    output,
  );
}

function capsuleFile(input: { digest: string; nonce: string; content: string; teaser: string; unlockAt: number; address: string }): string {
  return [
    'OBSIDIAN TIME CAPSULE',
    '=====================',
    `Content commitment: ${input.digest}`,
    `Content nonce:      ${input.nonce}`,
    `Unlock at:          ${new Date(input.unlockAt * 1000).toISOString()}`,
    `Creator wallet:     ${input.address}`,
    `Public teaser:      ${input.teaser}`,
    '',
    '--- SEALED CONTENT (base64) ---',
    btoa(unescape(encodeURIComponent(input.content))),
    '',
    'Any Obsidian interface can re-derive the commitment from this file and prove',
    'it matches the chain. Keep the file: the network stores the fingerprint, not',
    'the message.',
  ].join('\n');
}

/**
 * The Time Travel multiplier is a protocol constant (1000). It is read from the
 * node's `/params` so a future parameter change prices correctly instead of
 * hard-coding 1000 into the interface.
 */
let timeTravelMultiplier = 1000n;
void client
  .params()
  .then((params) => {
    const value = params.capsules?.timeTravelMultiplier;
    if (value && /^\d+$/.test(value)) timeTravelMultiplier = BigInt(value);
  })
  .catch(() => {
    /* the protocol default stands; the node validates the payment anyway */
  });

async function loadStats(): Promise<void> {
  // The node aggregates these from chain state; summing strings in the browser
  // produced a second, unverifiable answer that disagreed with every node.
  // A failing node is reported where the numbers would have been — an unhandled
  // promise rejection is not a user interface.
  let wall;
  try {
    ({ stats: wall } = await client.capsules({ limit: 100 }));
  } catch (error) {
    stats.replaceChildren(el('p', { class: 'error' }, `Capsule statistics unavailable: ${(error as Error).message}`));
    return;
  }
  stats.replaceChildren(
    stat('Capsules on the wall', wall.total.toLocaleString()),
    stat('Still sealed', wall.locked.toLocaleString()),
    stat('Unlocked', wall.unlocked.toLocaleString()),
    stat('OBS locked in capsules', `${obs(wall.totalLockedObs)} OBS`, 'transfers to the Mining Pool at unlock, even if the creator never returns'),
    stat('Returned to the pool', `${obs(wall.totalReturnedToPoolObs)} OBS`),
    stat('Time Travel revenue', `${obs(wall.totalTimeTravelRevenueObs)} OBS`),
    stat('Largest commitment', `${obs(wall.largestCommitmentObs)} OBS`),
    stat('Next unlock', wall.nearestUnlock ? when(wall.nearestUnlock) : 'nothing sealed'),
  );
}

async function loadWall(): Promise<void> {
  try {
    const { capsules } = await client.capsules({ limit: 50 });
    wall.replaceChildren(
      el('h2', {}, 'The wall'),
      capsules.length === 0
        ? el('p', { class: 'muted' }, 'No capsules have been sealed on this chain yet.')
        : table(
            ['Capsule', 'Creator', 'Locked', 'Unlocks', 'State', ''],
            capsules.map((capsule) => {
              const id = capsule.capsuleId;
              const unlockAt = Number(capsule.unlockAt ?? 0);
              // State comes from the chain (LOCKED / UNLOCKED): the browser clock
              // is never the authority on whether a capsule is still sealed.
              const sealed = String(capsule.status).toUpperCase() === 'LOCKED';
              const preview = el('button', { class: 'ghost small', type: 'button' }, 'Time travel preview 1000×');
              preview.addEventListener('click', () => void previewCapsule(id, capsule.commitmentObs, timeTravelMultiplier));
              return [
                el('span', { class: 'mono' }, short(id, 12)),
                el('span', { class: 'mono' }, short(String(capsule.owner ?? ''), 10)),
                `${obs(capsule.commitmentObs)} OBS`,
                `${when(unlockAt)}`,
                sealed ? badge('sealed', 'warn') : badge('unlocked', 'ok'),
                sealed ? preview : el('span', { class: 'muted' }, 'revealed'),
              ];
            }),
          ),
      el('p', { class: 'fineprint' }, 'A Time Travel preview costs 1000× the creator\'s locked commitment, is paid wholly to the Mining Pool, and is granted once per capsule per account for 30 seconds.'),
    );
  } catch (error) {
    wall.replaceChildren(el('h2', {}, 'The wall'), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function previewCapsule(capsuleId: string, commitmentObs: string, multiplier: bigint): Promise<void> {
  const passphrase = window.prompt('Time Travel costs 1000× the locked commitment, paid to the Mining Pool. Unlock your wallet to continue.');
  if (!passphrase) return;
  try {
    const wallet = await Wallet.unlock(passphrase);
    // Exact integer maths: the node recomputes this price and rejects a guess.
    const paymentObs = obsFromSeals(sealsFromObs(commitmentObs) * multiplier);
    const result = await operations.previewCapsule(client, wallet, { capsuleId, paymentObs, previewChunk: '' });
    toast(`Preview access recorded on chain: ${result.txId.slice(0, 16)}…`, 'success');
    await loadWall();
  } catch (error) {
    toast((error as Error).message, 'error');
  }
}

function stat(label: string, value: string, sub?: string): HTMLElement {
  return el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, label), el('strong', {}, value), sub ? el('span', { class: 'stat-sub' }, sub) : null);
}
