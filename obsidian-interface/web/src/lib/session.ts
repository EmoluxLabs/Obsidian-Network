/**
 * Session handling for the interface.
 *
 * The browser never sees a session secret: the server sets an HttpOnly cookie.
 * This module only asks "who am I" and requests invites; it never stores or
 * transmits anything that could be used as a key.
 */

export interface AccountView {
  accountId: string;
  email: string;
  displayName?: string;
  invitesIssued: number;
  /** The account's proven wallet. Permanent once set: one wallet per account. */
  walletAddress?: string;
  walletLocked?: boolean;
  mfaEnabled: boolean;
  /** Mining opens only once password, recovery codes and MFA are all done. */
  miningEnabled: boolean;
  /** True once a wallet is linked AND MFA is confirmed — what the server requires of a claim. */
  miningReady?: boolean;
  recoveryCodesRemaining: number;
}

export interface AuthConfig {
  inviteOnly: boolean;
  /** Always 'GMAIL_PASSWORD_MFA'. Google OAuth was removed. */
  authMethod: string;
  emailDomains: string[];
  passwordMinLength: number;
  mfaRequiredForMining: boolean;
  recoveryCodeCount: number;
  maxInvitesPerAccount: number;
  accountsExist: boolean;
  /**
   * Whether this deployment has a Genesis Invitation and whether it has been
   * spent. Never contains the invitation or its hash — only these two flags
   * cross the wire.
   */
  genesisInvite?: { configured: boolean; redeemed: boolean };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) {
    const error = new Error(payload.error ?? `request failed (${response.status})`) as Error & { code?: string };
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export const session = {
  config(): Promise<AuthConfig> {
    return api<AuthConfig>('/api/auth/config');
  },
  me(): Promise<{ account: AccountView }> {
    return api<{ account: AccountView }>('/api/auth/me');
  },
  async current(): Promise<AccountView | undefined> {
    try {
      return (await this.me()).account;
    } catch {
      return undefined;
    }
  },
  /**
   * Register. The response is the ONLY time the recovery codes exist — they
   * are not stored in recoverable form and can never be shown again.
   */
  register(input: {
    email: string;
    password: string;
    inviteCode: string;
    displayName?: string;
  }): Promise<{
    account: AccountView;
    bootstrapped: boolean;
    recoveryCodes: string[];
    recoveryCodesWarning: string;
    nextStep: string;
  }> {
    return api('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
  },
  signIn(input: { email: string; password: string; totp?: string }): Promise<{
    account: AccountView;
    bootstrapped: boolean;
  }> {
    return api('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
  },
  startMfa(): Promise<{ secret: string; uri: string; digits: number; periodSeconds: number; note: string }> {
    return api('/api/auth/mfa/setup', { method: 'POST', body: '{}' });
  },
  confirmMfa(totp: string): Promise<{ account: AccountView; miningEnabled: boolean; note: string }> {
    return api('/api/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ totp }) });
  },
  recover(input: { email: string; recoveryCode: string; newPassword: string }): Promise<{
    account: AccountView;
    recovered: boolean;
    recoveryCodesRemaining: number;
  }> {
    return api('/api/auth/recover', { method: 'POST', body: JSON.stringify(input) });
  },
  signOut(): Promise<{ signedOut: boolean }> {
    return api<{ signedOut: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' });
  },
  invites(): Promise<{ invites: Array<{ code: string; createdAt: number; acceptedBy?: string }>; issued: number; limit: number }> {
    return api('/api/auth/invites');
  },
  /**
   * Ask the platform for the mining gate certificate the chain requires on a claim. The platform issues it only
   * for the wallet linked to THIS signed-in, second-factor-confirmed account; it expires in minutes.
   */
  async miningCertificate(
    address: string,
    claimId: string,
  ): Promise<{ issuer: string; issuedAt: number; signature: string }> {
    const { gate } = await api<{ gate: { issuer: string; issuedAt: number; signature: string } }>('/api/mining/certificate', {
      method: 'POST',
      body: JSON.stringify({ address, claimId }),
    });
    return gate;
  },
  createInvite(): Promise<{ invite: { code: string }; issued: number; limit: number }> {
    return api('/api/auth/invites', { method: 'POST', body: '{}' });
  },
  /**
   * Link `address` to the account — once, for good. The server issues a challenge; `sign` signs it
   * on this device (the key never leaves); the server checks the signature and links. Linking the
   * wallet the account already has is a no-op that succeeds.
   */
  async linkWallet(
    address: string,
    sign: (message: string) => { publicKey: string; signature: string },
  ): Promise<{ linked: boolean; address: string; account?: AccountView }> {
    const challenge = await api<{ alreadyLinked?: boolean; message?: string; account?: AccountView }>(
      '/api/wallet/link/challenge',
      { method: 'POST', body: JSON.stringify({ address }) },
    );
    if (challenge.alreadyLinked) return { linked: true, address, account: challenge.account };
    if (!challenge.message) throw new Error('the interface sent no link challenge');
    const proof = sign(challenge.message);
    return api('/api/wallet/link', { method: 'POST', body: JSON.stringify({ address, ...proof }) });
  },
};
