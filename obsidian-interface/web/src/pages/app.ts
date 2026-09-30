/**
 * Account page: sign in, invites, node health, wallet linking.
 *
 * Authentication is invite-only. Sign-in with Google is validated server-side
 * against Google's JWKS — the browser sends the ID token and nothing else, and
 * the interface never trusts a client claim such as `isGoogleUser: true`.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { Wallet } from '../lib/wallet.js';
import { session, loadGoogleIdentity, type AccountView } from '../lib/session.js';
import { el, spinner, toast, kv, badge, table, short, when, copyButton } from '../lib/ui.js';

const client = new ObsidianClient();
const authPanel = el('section', { class: 'card', id: 'auth' }, spinner('reading configuration…'));
const invitePanel = el('section', { class: 'card', id: 'invites' });
const walletPanel = el('section', { class: 'card', id: 'wallet-link' });
const nodesPanel = el('section', { class: 'card', id: 'nodes' }, spinner());

layout({
  current: 'app',
  title: 'Account',
  tagline: 'Invites, node health and the wallet you choose to publish. Your keys stay in the browser.',
  children: [
    el(
      'section',
      { class: 'notice' },
      el('strong', {}, 'Invite-only, on purpose. '),
      'Registration here is capped: the first account on a fresh deployment must present the single-use Genesis Invitation the operator holds offline, and every account after that needs an unused invite from someone already inside. ' +
        'Each account may issue at most five invites, enforced by the server, not by this page. Creating a wallet needs no account at all.',
    ),
    authPanel,
    invitePanel,
    walletPanel,
    nodesPanel,
  ],
});

void boot();

async function boot(): Promise<void> {
  await drawAuth();
  void drawNodes();
}

async function drawAuth(): Promise<void> {
  let config;
  try {
    config = await session.config();
  } catch (error) {
    authPanel.replaceChildren(el('h2', {}, 'Sign in'), el('p', { class: 'error' }, (error as Error).message));
    return;
  }
  const account = await session.current();
  if (account) {
    drawSignedIn(account);
    void drawInvites(account);
    return;
  }

  // The first account needs the Genesis Invitation; later accounts need a
  // member invite. Either way the field is required — it is never disabled,
  // because there is no longer any registration path without a credential.
  const inviteInput = el('input', {
    id: 'invite-code',
    placeholder: config.accountsExist ? 'Invite code (required)' : 'Genesis Invitation (required)',
  });
  const statusLine = el('p', { class: 'fineprint' }, config.googleClientId ? 'Sign-in uses Google Identity Services; the ID token is verified by this server against Google\'s public keys.' : 'Google sign-in is not configured on this deployment, so accounts cannot be created here.');

  authPanel.replaceChildren(
    el('h2', {}, 'Sign in'),
    kv([
      ['Invite-only', config.inviteOnly ? badge('yes', 'ok') : badge('no', 'warn')],
      [
        'Accounts exist',
        config.accountsExist
          ? 'yes — an invite code from a member is required'
          : 'no — the first account needs the Genesis Invitation',
      ],
      [
        'Genesis Invitation',
        config.genesisInvite?.redeemed
          ? badge('redeemed', 'ok')
          : config.genesisInvite?.configured
            ? badge('unspent', 'warn')
            : badge('not configured', 'warn'),
      ],
      ['Invites per account', String(config.maxInvitesPerAccount)],
    ]),
    el('div', { class: 'field' }, el('label', { for: 'invite-code' }, 'Invite code'), inviteInput),
    el('div', { class: 'row' }, el('div', { id: 'google-button' }, el('span', { class: 'muted' }, 'loading Google sign-in…')), el('a', { class: 'ghost as-link', href: '/wallet/' }, 'Create a wallet instead')),
    statusLine,
  );

  if (!config.googleClientId) return;
  try {
    await loadGoogleIdentity();
  } catch (error) {
    statusLine.textContent = (error as Error).message;
    return;
  }
  const host = document.getElementById('google-button');
  if (!host || !window.google) return;
  host.replaceChildren();
  window.google.accounts.id.initialize({
    client_id: config.googleClientId,
    callback: (response) => void signIn(response.credential, inviteInput.value.trim()),
  });
  window.google.accounts.id.renderButton(host, { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill' });
}

async function signIn(idToken: string, inviteCode: string): Promise<void> {
  try {
    const result = await session.signIn(idToken, inviteCode || undefined);
    toast(result.bootstrapped ? 'First account created — you bootstrap this interface.' : 'Signed in.', 'success');
    await drawAuth();
  } catch (error) {
    toast((error as Error).message, 'error');
  }
}

function drawSignedIn(account: AccountView): void {
  const out = el('button', { class: 'ghost', type: 'button' }, 'Sign out');
  out.addEventListener('click', async () => {
    await session.signOut();
    toast('Signed out.', 'info');
    await drawAuth();
  });
  authPanel.replaceChildren(
    el('h2', {}, 'Signed in'),
    kv([
      ['Email', account.email],
      ['Display name', account.displayName ?? '—'],
      ['Account id', el('span', { class: 'mono' }, account.accountId)],
      ['Invites issued', `${account.invitesIssued} of 5`],
      ['Linked wallet', account.walletAddress ? el('span', { class: 'mono' }, account.walletAddress) : 'none (optional)'],
    ]),
    el('div', { class: 'row' }, out),
    el('p', { class: 'fineprint' }, 'This account exists to gate invites. It holds no OBS, has no private key on the server, and cannot sign anything for you.'),
  );
  void drawWalletLink(account);
}

async function drawInvites(account: AccountView): Promise<void> {
  const list = el('div', {}, spinner('loading invites…'));
  invitePanel.replaceChildren(el('h2', {}, 'Invites'), list);
  try {
    const data = await session.invites();
    const create = el('button', { class: 'primary', type: 'button', disabled: data.issued >= data.limit ? 'disabled' : undefined }, data.issued >= data.limit ? 'All 5 invites issued' : 'Issue an invite');
    create.addEventListener('click', async () => {
      try {
        const created = await session.createInvite();
        toast(`Invite created: ${created.invite.code}`, 'success');
        await drawInvites(account);
      } catch (error) {
        toast((error as Error).message, 'error');
      }
    });
    list.replaceChildren(
      el('div', { class: 'row' }, create, el('span', { class: 'muted' }, `${data.issued} of ${data.limit} issued — a hard cap, enforced server-side`)),
      data.invites.length === 0
        ? el('p', { class: 'muted' }, 'No invites issued yet.')
        : table(
            ['Code', 'Created', 'Accepted by', ''],
            data.invites.map((invite) => [
              el('span', { class: 'mono' }, invite.code),
              when(Math.floor(invite.createdAt / 1000)),
              invite.acceptedBy ?? el('span', { class: 'muted' }, 'unused'),
              copyButton(() => invite.code, 'Copy'),
            ]),
          ),
      el('p', { class: 'fineprint' }, 'Invite codes are single-use and are checked when an account is created. Deleting this browser\'s storage does not give you more invites — the count lives on the server.'),
    );
  } catch (error) {
    list.replaceChildren(el('p', { class: 'error' }, (error as Error).message));
  }
}

function drawWalletLink(account: AccountView): void {
  const address = Wallet.storedAddress();
  walletPanel.replaceChildren(
    el('h2', {}, 'Linked wallet'),
    el('p', {}, 'Linking is optional and cosmetic: it lets this interface show which wallet you mine with. It grants no spending power, because the server never holds a key.'),
    address
      ? el('div', { class: 'row' },
          el('span', { class: 'mono' }, address),
          linkButton(address))
      : el('p', { class: 'muted' }, 'No wallet in this browser. Create one to link it.'),
    ...(account.walletAddress ? [el('p', { class: 'fineprint' }, `Currently linked: ${account.walletAddress}`)] : []),
  );
}

function linkButton(address: string): HTMLElement {
  const button = el('button', { class: 'primary', type: 'button' }, 'Publish this address to my account');
  button.addEventListener('click', async () => {
    try {
      await session.linkWallet(address);
      toast('Wallet address linked to your account.', 'success');
      await drawAuth();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });
  return button;
}

async function drawNodes(): Promise<void> {
  try {
    const data = await client.nodes();
    nodesPanel.replaceChildren(
      el('h2', {}, 'Nodes this interface can read'),
      el('p', { class: 'muted' }, `Consensus height ${data.consensusHeight?.toLocaleString() ?? '—'}${data.genesisMismatch ? ' — GENESIS MISMATCH DETECTED' : ''}`),
      table(
        ['Node', 'Health', 'Height', 'Latency', 'Chain', 'Genesis'],
        data.nodes.map((node) => [
          el('span', { class: 'mono' }, node.url),
          node.healthy ? badge('healthy', 'ok') : badge('unreachable', 'bad'),
          node.height.toLocaleString(),
          `${node.latencyMs} ms`,
          `${node.networkId} (${node.chainId})`,
          el('span', { class: 'mono' }, short(node.genesisId, 10)),
        ]),
      ),
      el('div', { class: 'row' }, refreshButton()),
      el('p', { class: 'fineprint' }, 'Reads fail over between healthy nodes automatically. If a node\'s genesis id differs, the interface marks it instead of silently mixing two chains — and it refuses to read balances from an explorer surface at all.'),
    );
  } catch (error) {
    nodesPanel.replaceChildren(el('h2', {}, 'Nodes'), el('p', { class: 'error' }, (error as Error).message));
  }
}

function refreshButton(): HTMLElement {
  const button = el('button', { class: 'ghost', type: 'button' }, 'Re-check nodes now');
  button.addEventListener('click', async () => {
    try {
      await fetch('/api/nodes/refresh', { method: 'POST' });
      toast('Node health re-checked.', 'success');
      await drawNodes();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });
  return button;
}
