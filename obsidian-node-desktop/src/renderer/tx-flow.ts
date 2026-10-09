/**
 * The one confirmation flow for everything that signs: payment, validator register /
 * unbond / claim. Shows exactly what will be signed, asks for the passphrase when the wallet
 * signs, and reports the real outcome. "Submitted" is never shown as "confirmed".
 */
import { ApiError, call } from './api.js';
import { html } from './dom.js';
import { formatTime } from './format.js';
import { navigate } from './router.js';
import { closeModal, copyText, openModal, toast, warn, mono, badge } from './ui.js';
import { passphraseField, readPassphrase } from './node-actions.js';
import type { ExecuteResult, PreparedPlan } from '../shared/tx-types.js';

export interface ConfirmOptions {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  /** Called after a successful hand-off to the node (state submitted). */
  onSubmitted?: () => void;
}

export function confirmPlan(plan: PreparedPlan, options: ConfirmOptions): void {
  const passId = 'plan-pass';
  openModal({
    title: options.title,
    wide: true,
    onClose: () => {
      // Leaving the dialog without signing discards the plan; nothing was signed.
      void call('tx:cancel', { prepareId: plan.prepareId }).catch(() => undefined);
    },
    body: () => html`<div style="margin-top:8px">${plan.rows.map((r) => html`<div class="row"><span class="k">${r.label}</span>${r.mono ? html`<span class="m ${r.strong ? 'b' : ''}">${r.value}</span>` : r.strong ? html`<b>${r.value}</b>` : html`<span>${r.value}</span>`}</div>`)}</div>
      ${plan.warnings.map((w) => warn(w))}
      ${plan.requiresPassphrase ? html`<div style="margin-top:14px">${passphraseField(passId, 'Wallet passphrase (needed to sign)')}</div>` : html`<div class="sub" style="margin-top:12px">Signed with this node’s identity key. No passphrase is needed.</div>`}
      <div class="sub" style="margin-top:10px">This confirmation expires at ${formatTime(plan.expiresAt)}.</div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: options.confirmLabel,
        kind: options.danger ? 'd' : 'p',
        run: async () => {
          const passphrase = plan.requiresPassphrase ? readPassphrase(passId) : undefined;
          let result: ExecuteResult;
          try {
            result = await call('tx:execute', { prepareId: plan.prepareId, passphrase });
          } catch (error) {
            if (error instanceof ApiError && ['WRONG_PASSPHRASE', 'PASSPHRASE_THROTTLED'].includes(error.code)) throw error; // stay open, plan still valid
            throw error;
          }
          // The plan was consumed by execute(); closing must not try to cancel it again (harmless if it does).
          closeModal();
          showResult(result, options);
          options.onSubmitted?.();
          return false;
        },
      },
    ],
  });
}

function showResult(result: ExecuteResult, options: ConfirmOptions): void {
  const ok = result.state === 'submitted';
  const unknown = result.state === 'unknown';
  const title = ok ? (result.duplicate ? 'Already submitted' : 'Submitted to the node') : unknown ? 'Result unknown' : 'The node refused the transaction';
  openModal({
    title,
    body: () => html`<div class="row"><span class="k">Transaction id</span>${mono(result.txId, { short: true })}</div>
      <div class="row"><span class="k">State</span>${ok ? badge('SUBMITTED · NOT YET CONFIRMED', 'wn') : unknown ? badge('UNKNOWN', 'wn') : badge('REJECTED', 'er')}</div>
      ${ok ? warn(result.duplicate ? 'The node already had this exact transaction. Nothing was sent twice.' : 'The node accepted the transaction into its pool. It is not final until it is included in a block; follow it on the Transactions screen.', 'in') : ''}
      ${unknown ? warn('The node did not answer in time, so it is not known whether it took the transaction. Do NOT send it again. Check the Transactions screen — if it is pending or confirmed, it went through; resubmitting the same bytes is safe and cannot double-spend.') : ''}
      ${!ok && !unknown ? warn(result.error ?? 'The node did not accept the transaction.', 'er') : ''}`,
    buttons: [
      { label: 'Copy id', run: async () => { await copyText(result.txId, 'Transaction id copied'); return false; } },
      { label: 'Open Transactions', kind: 'p', run: () => { navigate('tx'); } },
    ],
  });
  if (ok) toast('Submitted to the node', 'ok', 2000);
}
