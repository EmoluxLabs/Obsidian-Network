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
  walletAddress?: string;
}

export interface AuthConfig {
  inviteOnly: boolean;
  googleClientId: string;
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
  signIn(idToken: string, inviteCode?: string): Promise<{ account: AccountView; bootstrapped: boolean }> {
    // Note there is no `isGoogleUser` flag: the server verifies the token.
    return api<{ account: AccountView; bootstrapped: boolean }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken, inviteCode }),
    });
  },
  signOut(): Promise<{ signedOut: boolean }> {
    return api<{ signedOut: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' });
  },
  invites(): Promise<{ invites: Array<{ code: string; createdAt: number; acceptedBy?: string }>; issued: number; limit: number }> {
    return api('/api/auth/invites');
  },
  createInvite(): Promise<{ invite: { code: string }; issued: number; limit: number }> {
    return api('/api/auth/invites', { method: 'POST', body: '{}' });
  },
  linkWallet(address: string): Promise<{ linked: boolean; address: string }> {
    return api('/api/wallet/link', { method: 'POST', body: JSON.stringify({ address }) });
  },
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(options: { client_id: string; callback: (response: { credential: string }) => void }): void;
          renderButton(element: HTMLElement, options: Record<string, unknown>): void;
          prompt(): void;
        };
      };
    };
  }
}

/** Load Google Identity Services on demand (never at page load). */
export function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('could not load Google sign-in (offline or blocked)'));
    document.head.append(script);
  });
}
