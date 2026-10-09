/** Start / stop / restart / network switch, with the confirmations the template specifies. */
import { ApiError, call } from './api.js';
import { html, inputValue, isChecked, raw } from './dom.js';
import { NETWORK_INFO, store, networkLabel } from './store.js';
import { closeModal, openModal, setModalError, toast, warn, requestRender } from './ui.js';
import type { NetworkName } from '../shared/chain-types.js';

function newChainModal(onConfirm: () => Promise<void>, message: string): void {
  openModal({
    title: 'Create a new local chain?',
    body: () => html`<p class="mu0">${message}</p>${warn('This only creates local data for this network, from the network’s own genesis. It never replaces or resets an existing database.')}`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create and start',
        kind: 'p',
        run: async () => {
          await onConfirm();
        },
      },
    ],
  });
}

export async function startNode(): Promise<void> {
  try {
    store.node = await call('node:start', {});
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NEW_CHAIN_CONFIRMATION_REQUIRED') {
      newChainModal(async () => {
        store.node = await call('node:start', { confirmNewChain: true });
        requestRender();
      }, error.message);
      return;
    }
    toast(error instanceof Error ? error.message : 'The node could not start.', 'er', 7000);
  }
  requestRender();
}

export function stopNodeFlow(): void {
  openModal({
    title: 'Stop node?',
    body: () => html`<p class="mu0">The node will shut down safely and stop syncing. Your node data stays on disk.</p>${warn(raw('Stopping the node does <b>not</b> unregister a validator or release bonded funds.'))}`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Stop Node',
        kind: 'd',
        run: async () => {
          store.node = await call('node:stop');
        },
      },
    ],
  });
}

export function restartNodeFlow(): void {
  openModal({
    title: 'Restart node?',
    body: () => html`<p class="mu0">The node stops through its normal shutdown and starts again on ${networkLabel(store.node?.network)}. It will be unavailable for a few seconds.</p>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Restart Node',
        kind: 'p',
        run: async () => {
          store.node = await call('node:restart', {});
        },
      },
    ],
  });
}

export function switchNetworkFlow(target: NetworkName): void {
  const current = store.settings?.network;
  if (!current || target === current) return;
  const info = NETWORK_INFO[target]!;
  const active = store.node?.phase === 'running' || store.node?.phase === 'starting';
  const production = target === 'mainnet';
  openModal({
    title: `Switch to ${info.label}?`,
    body: () => html`<p class="mu0">${info.blurb}</p>
      ${warn(active ? 'Chain data and wallet context are network-specific. The node will stop and restart on the selected network.' : 'Chain data and wallet context are network-specific. The node is not running and will stay stopped.')}
      ${production ? html`<label class="chk"><input type="checkbox" id="net-prod"> I understand that Mainnet is the production network and transactions there move real funds.</label>` : ''}`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Change Network',
        kind: 'p',
        run: async () => {
          if (production && !isChecked('net-prod')) throw new Error('Tick the box to confirm you are switching to the production network.');
          const result = await call('network:switch', { network: target, restartNode: active });
          store.node = result.state;
          store.settings = await call('settings:get').then((s) => s.settings);
          if (result.startError) {
            const code = result.startError.code;
            const message = result.startError.message;
            closeModal();
            if (code === 'NEW_CHAIN_CONFIRMATION_REQUIRED') {
              newChainModal(async () => {
                store.node = await call('node:start', { confirmNewChain: true });
              }, message);
            } else {
              toast(message, 'er', 7000);
            }
            return false;
          }
        },
      },
    ],
  });
}

/** Shared passphrase field used by every signing or wallet-removal dialog. */
export function passphraseField(id: string, label = 'Wallet passphrase'): ReturnType<typeof html> {
  return html`<label class="fl" for="${id}">${label}</label><input class="in" id="${id}" type="password" autocomplete="off" spellcheck="false" aria-label="${label}">`;
}

export function readPassphrase(id: string): string {
  const value = inputValue(id);
  if (!value) {
    setModalError('Enter your wallet passphrase.');
    throw new Error('Enter your wallet passphrase.');
  }
  return value;
}
