/**
 * Link this browser's wallet to the signed-in account.
 *
 * One wallet per account, permanent, and proven: the vault passphrase unlocks the key on this
 * device, the key signs a server challenge, and only the public key and signature are sent. The
 * wallet is never derived from anything about the account.
 */
import { session, type AccountView } from './session.js';
import { Wallet } from './wallet.js';

/**
 * Domain tag of the link proof, fixed here in the client: the server's copy is only compared
 * against it. A server must not be able to choose the domain a user signs under, so a link proof
 * can never be passed off as a transaction signature.
 */
export const WALLET_LINK_DOMAIN = 'OBSIDIAN:WALLET_LINK:v1';

export async function linkStoredWallet(address: string): Promise<AccountView | undefined> {
  const passphrase = window.prompt(
    'Link this wallet to your account for good: one wallet per account, and it cannot be changed. Enter your wallet passphrase to sign the link (it stays in this tab).',
  );
  if (!passphrase) throw new Error('linking was cancelled; nothing was changed');
  const wallet = await Wallet.unlock(passphrase);
  const result = await session.linkWallet(address, (message) => {
    // Only a link challenge for exactly this address is ever signed.
    const lines = message.split('\n');
    if (lines[0] !== 'OBSIDIAN WALLET LINK v1' || !lines.includes(`address: ${address}`)) {
      throw new Error('the interface sent something that is not a link challenge for this wallet, so nothing was signed');
    }
    return wallet.signMessageFor(address, WALLET_LINK_DOMAIN, message);
  });
  return result.account;
}
