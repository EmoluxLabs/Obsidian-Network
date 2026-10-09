/**
 * Account page: sign in, invites, node health, wallet linking.
 *
 * Authentication is invite-only and entirely first-party: a Gmail address, a
 * password, an invite code, then TOTP multi-factor. There is no Google OAuth,
 * no email verification and — by design — no password reset. The recovery
 * codes issued once at registration are the only way back into an account.
 *
 * Nothing on this page decides anything. Gmail canonicalisation (so that
 * `first.last+tag@gmail.com` and `firstlast@gmail.com` are one identity, and
 * one mining account) happens on the server; the browser cannot be trusted to
 * say an address is unique.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { Wallet } from '../lib/wallet.js';
import { session, type AccountView, type AuthConfig } from '../lib/session.js';
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
  let config: AuthConfig;
  try {
    config = await session.config();
  } catch (error) {
    authPanel.replaceChildren(el('h2', {}, 'Sign in'), el('p', { class: 'error' }, (error as Error).message));
    return;
  }
  const account = await session.current();
  if (account) {
    drawSignedIn(account, config);
    void drawInvites(account);
    return;
  }
  drawAuthForms(config, 'register');
}

type AuthMode = 'register' | 'login' | 'recover';

function drawAuthForms(config: AuthConfig, mode: AuthMode): void {
  const tab = (id: AuthMode, label: string): HTMLElement => {
    const button = el('button', { class: id === mode ? 'tab active' : 'tab', type: 'button' }, label);
    button.addEventListener('click', () => drawAuthForms(config, id));
    return button;
  };

  authPanel.replaceChildren(
    el('h2', {}, 'Account access'),
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
      ['Sign-in', `${config.emailDomains.join(' / ')} address, password, invite, then MFA`],
      ['Invites per account', String(config.maxInvitesPerAccount)],
    ]),
    el('div', { class: 'tabs' }, tab('register', 'Register'), tab('login', 'Sign in'), tab('recover', 'Use a recovery code')),
    mode === 'register' ? registerForm(config) : mode === 'login' ? loginForm() : recoverForm(),
    el('a', { class: 'ghost as-link', href: '/wallet/' }, 'Create a wallet without an account'),
  );
}

function field(id: string, label: string, attrs: Record<string, string>): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { id, ...attrs }) as HTMLInputElement;
  return { row: el('div', { class: 'field' }, el('label', { for: id }, label), input), input };
}

function registerForm(config: AuthConfig): HTMLElement {
  const email = field('reg-email', 'Gmail address', { type: 'email', placeholder: 'you@gmail.com', autocomplete: 'username' });
  const name = field('reg-name', 'Display name (optional)', { placeholder: 'shown to nobody but you' });
  const password = field('reg-password', `Password (${config.passwordMinLength}+ characters, letters and digits)`, {
    type: 'password',
    autocomplete: 'new-password',
  });
  const confirm = field('reg-confirm', 'Repeat password', { type: 'password', autocomplete: 'new-password' });
  const invite = field('reg-invite', config.accountsExist ? 'Invite code' : 'Genesis Invitation', {
    placeholder: config.accountsExist ? 'OBS-INVITE-…' : 'OBS-GENESIS-…',
  });
  const submit = el('button', { class: 'primary', type: 'submit' }, 'Create account');
  const note = el('p', { class: 'fineprint' },
    'No email is sent and no address is verified, so there is nothing to phish. There is also no password reset: ' +
    `the ${config.recoveryCodeCount} recovery codes shown on the next screen are the only way back in. ` +
    'Dots and +tags in a Gmail address are ignored by the server, so one Gmail inbox gets exactly one mining account.');

  const form = el('form', { class: 'stack' }, email.row, name.row, password.row, confirm.row, invite.row, el('div', { class: 'row' }, submit), note) as HTMLFormElement;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (password.input.value !== confirm.input.value) {
      toast('The two passwords do not match.', 'error');
      return;
    }
    submit.setAttribute('disabled', 'true');
    try {
      const result = await session.register({
        email: email.input.value.trim(),
        password: password.input.value,
        inviteCode: invite.input.value.trim(),
        displayName: name.input.value.trim() || undefined,
      });
      showRecoveryCodes(result.recoveryCodes, result.account, result.bootstrapped);
    } catch (error) {
      toast((error as Error).message, 'error');
      submit.removeAttribute('disabled');
    }
  });
  return form;
}

/**
 * The one and only time the recovery codes exist in readable form. The server
 * keeps scrypt hashes, so this screen cannot be replayed — the user must
 * acknowledge having written them down before it will close.
 */
function showRecoveryCodes(codes: string[], account: AccountView, bootstrapped: boolean): void {
  const acknowledge = el('input', { type: 'checkbox', id: 'ack-codes' }) as HTMLInputElement;
  const proceed = el('button', { class: 'primary', type: 'button', disabled: 'true' }, 'I have saved them — continue to MFA');
  acknowledge.addEventListener('change', () => {
    if (acknowledge.checked) proceed.removeAttribute('disabled');
    else proceed.setAttribute('disabled', 'true');
  });
  proceed.addEventListener('click', () => void drawMfaSetup(account));

  const text = codes.join('\n');
  const download = el('button', { class: 'ghost', type: 'button' }, 'Download as a text file');
  download.addEventListener('click', () => {
    const blob = new Blob([`Obsidian Network recovery codes for ${account.email}\nEach code works once. Keep them offline.\n\n${text}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: 'obsidian-recovery-codes.txt' }) as HTMLAnchorElement;
    link.click();
    URL.revokeObjectURL(url);
  });

  authPanel.replaceChildren(
    el('h2', {}, bootstrapped ? 'Account created — you bootstrap this interface' : 'Account created'),
    el('div', { class: 'notice danger' },
      el('strong', {}, 'Write these down now. '),
      'They are shown exactly once. The server stores only hashes, so no operator, and no support request, can ever recover them for you. ' +
      'Each code works a single time and is the only way to regain an account whose password is lost.'),
    el('div', { class: 'codegrid' }, ...codes.map((code) => el('code', { class: 'mono recovery-code' }, code))),
    el('div', { class: 'row' }, copyButton(text, 'Copy all'), download),
    el('label', { class: 'checkline', for: 'ack-codes' }, acknowledge, el('span', {}, 'I have written these codes down offline.')),
    el('div', { class: 'row' }, proceed),
  );
}

/** Step two: MFA. Mining stays closed until a TOTP code has been confirmed. */
async function drawMfaSetup(account: AccountView): Promise<void> {
  authPanel.replaceChildren(el('h2', {}, 'Set up multi-factor authentication'), spinner('generating a secret…'));
  let setup;
  try {
    setup = await session.startMfa();
  } catch (error) {
    authPanel.replaceChildren(el('h2', {}, 'Set up multi-factor authentication'), el('p', { class: 'error' }, (error as Error).message));
    return;
  }
  const code = field('mfa-code', `Code from your authenticator (${setup.digits} digits)`, {
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    placeholder: '000000',
  });
  const submit = el('button', { class: 'primary', type: 'submit' }, 'Confirm and open mining');
  const form = el('form', { class: 'stack' }, code.row, el('div', { class: 'row' }, submit)) as HTMLFormElement;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.setAttribute('disabled', 'true');
    try {
      const result = await session.confirmMfa(code.input.value.trim());
      toast('MFA confirmed — mining is open on this account.', 'success');
      drawSignedIn(result.account, await session.config());
      void drawInvites(result.account);
    } catch (error) {
      toast((error as Error).message, 'error');
      submit.removeAttribute('disabled');
    }
  });

  authPanel.replaceChildren(
    el('h2', {}, 'Set up multi-factor authentication'),
    el('p', { class: 'muted' }, `Add this secret to any TOTP app (${setup.digits} digits, ${setup.periodSeconds}-second steps). It is standard RFC 6238 — no proprietary app, and nothing phones home.`),
    el('div', { class: 'row' }, el('code', { class: 'mono breakable' }, setup.secret), copyButton(setup.secret, 'Copy secret')),
    el('p', { class: 'fineprint' }, el('span', { class: 'mono breakable' }, setup.uri)),
    form,
    el('p', { class: 'fineprint' }, `Signed in as ${account.email}. Mining stays closed until a code is confirmed.`),
  );
}

function loginForm(): HTMLElement {
  const email = field('log-email', 'Gmail address', { type: 'email', autocomplete: 'username' });
  const password = field('log-password', 'Password', { type: 'password', autocomplete: 'current-password' });
  const totp = field('log-totp', 'MFA code (if enabled)', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '000000' });
  const submit = el('button', { class: 'primary', type: 'submit' }, 'Sign in');
  const form = el('form', { class: 'stack' }, email.row, password.row, totp.row, el('div', { class: 'row' }, submit)) as HTMLFormElement;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.setAttribute('disabled', 'true');
    try {
      const result = await session.signIn({
        email: email.input.value.trim(),
        password: password.input.value,
        totp: totp.input.value.trim() || undefined,
      });
      toast('Signed in.', 'success');
      if (!result.account.mfaEnabled) {
        await drawMfaSetup(result.account);
        return;
      }
      await drawAuth();
    } catch (error) {
      toast((error as Error).message, 'error');
      submit.removeAttribute('disabled');
    }
  });
  return form;
}

function recoverForm(): HTMLElement {
  const email = field('rec-email', 'Gmail address', { type: 'email', autocomplete: 'username' });
  const code = field('rec-code', 'Recovery code', { placeholder: 'OBS-RECOVERY-XXXX-XXXX-XXXX' });
  const password = field('rec-password', 'New password', { type: 'password', autocomplete: 'new-password' });
  const submit = el('button', { class: 'primary', type: 'submit' }, 'Recover account');
  const form = el('form', { class: 'stack' }, email.row, code.row, password.row, el('div', { class: 'row' }, submit),
    el('p', { class: 'fineprint' }, 'A recovery code is spent the moment it works, and it also clears any sign-in lockout. If you run out of codes the account is gone — there is no operator override.')) as HTMLFormElement;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.setAttribute('disabled', 'true');
    try {
      const result = await session.recover({
        email: email.input.value.trim(),
        recoveryCode: code.input.value.trim(),
        newPassword: password.input.value,
      });
      toast(`Recovered. ${result.recoveryCodesRemaining} recovery codes left.`, 'success');
      await drawAuth();
    } catch (error) {
      toast((error as Error).message, 'error');
      submit.removeAttribute('disabled');
    }
  });
  return form;
}

function drawSignedIn(account: AccountView, config?: AuthConfig): void {
  const out = el('button', { class: 'ghost', type: 'button' }, 'Sign out');
  out.addEventListener('click', async () => {
    await session.signOut();
    toast('Signed out.', 'info');
    await drawAuth();
  });
  const rows: Array<[string, string | Node]> = [
    ['Email', account.email],
    ['Display name', account.displayName ?? '—'],
    ['Account id', el('span', { class: 'mono' }, account.accountId)],
    ['MFA', account.mfaEnabled ? badge('enabled', 'ok') : badge('not set up', 'warn')],
    ['Mining', account.miningEnabled && account.walletAddress ? badge('open', 'ok') : badge(account.walletAddress ? 'closed until MFA' : account.miningEnabled ? 'closed until a wallet is linked' : 'closed until a wallet is linked and MFA is confirmed', 'warn')],
    ['Recovery codes left', `${account.recoveryCodesRemaining}`],
    ['Invites issued', `${account.invitesIssued} of ${config?.maxInvitesPerAccount ?? 5}`],
    ['Linked wallet', account.walletAddress ? el('span', { class: 'mono' }, account.walletAddress) : 'none — required before you can mine'],
  ];
  const actions = [out];
  if (!account.mfaEnabled) {
    const finish = el('button', { class: 'primary', type: 'button' }, 'Finish MFA setup');
    finish.addEventListener('click', () => void drawMfaSetup(account));
    actions.unshift(finish);
  }
  authPanel.replaceChildren(
    el('h2', {}, 'Signed in'),
    kv(rows),
    el('div', { class: 'row' }, ...actions),
    el('p', { class: 'fineprint' }, 'This account exists to gate invites and mining on this deployment. It holds no OBS, has no private key on the server, and cannot sign anything for you.'),
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
    el('p', {}, 'Mining needs a linked wallet: this interface accepts a claim only from the wallet linked to your account. Linking publishes the address only; it grants no spending power, because the server never holds a key.'),
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
