import { call } from '../api.js';
import { html } from '../dom.js';
import { store } from '../store.js';
import { copyText, mono, pageHead, registerActions, toast } from '../ui.js';
import type { Screen } from './common.js';

export const help: Screen = {
  render() {
    const a = store.appInfo;
    const head = pageHead('Help & Support', 'Help & Support');
    if (!a) return html`${head}`;
    return html`${head}
    <div class="g g2" style="margin-top:18px">
      <div class="card"><div class="k">About this app</div>
        <div class="row"><span>Application</span><b>${a.appName}</b></div>
        <div class="row"><span>Version</span><span class="m">${a.appVersion}</span></div>
        <div class="row"><span>Electron / Chromium</span><span class="m">${a.electron} / ${a.chromium}</span></div>
        <div class="row"><span>Node.js runtime</span><span class="m">${a.node}</span></div>
        <div class="row"><span>System</span><span class="m">${a.platform} ${a.arch}</span></div>
        <div class="row"><span>Licence</span><span class="m">${a.license}</span></div></div>
      <div class="card"><div class="k">Obsidian Core (the node inside this app)</div>
        ${a.core ? html`<div class="row"><span>Core version</span><span class="m">${a.core.version}</span></div>
        <div class="row"><span>Protocol version</span><span class="m">${a.core.protocolVersion}</span></div>
        <div class="row"><span>Parameters hash</span>${mono(a.core.paramsHash, { copy: true })}</div>
        <div class="row"><span>Build id</span><span class="m">${a.core.buildId}</span></div>
        <div class="row"><span>Source commit</span>${mono(a.core.sourceCommit, { short: true, copy: true })}</div>` : html`<div class="sub" style="margin-top:8px">The bundled core could not be loaded: ${a.coreError}</div>`}</div>
    </div>
    <div class="card" style="margin-top:14px"><div class="k">Get help</div>
      <div class="sub" style="font-size:13px;margin:8px 0 12px">When you report a problem, attach a diagnostic report. It is redacted: no keys, passphrases or recovery phrases.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn p" data-action="help.report-copy">Copy diagnostic report</button><button class="btn" data-action="help.report-save">Save report…</button><button class="btn" data-action="help.open" data-url="${a.repository}">Project page</button><button class="btn" data-action="help.open" data-url="${a.repository}/issues">Report an issue</button></div></div>
    <div class="card" style="margin-top:14px"><div class="k">How this app works</div>
      ${[
        ['The node', 'Obsidian Node runs the real Obsidian Core node on this computer, with its own database. Starting and stopping it here uses the same startup and shutdown as the command-line node.'],
        ['Node vs validator', 'Running a node does not make you a validator, and stopping it never unbonds funds. A validator is an on-chain registration that locks a bond; it uses the node’s identity key, which is a separate account from your personal wallet.'],
        ['Your wallet', 'Wallets are encrypted on this computer with your passphrase. The recovery phrase is shown once at creation. The app never displays or logs a key; every signature asks for the passphrase again.'],
        ['Confirmed vs submitted', '“Submitted” only means your node accepted the transaction. It is confirmed when a block includes it.'],
        ['Networks', 'Mainnet, Testnet, Staging and Devnet each have their own chain data, wallet and node identity. Switching never mixes them or resets data.'],
        ['When the node stops answering', 'The status turns red and keeps the last known numbers, clearly marked. Use Logs & Diagnostics to see why.'],
      ].map(([t, x]) => html`<div style="margin-top:12px"><b>${t}</b><div class="sub" style="font-size:13px;margin-top:2px">${x}</div></div>`)}</div>
    <div class="sub" style="margin-top:14px">Interface based on the Obsidian Node design template (sha256 ${a.templateSha256.slice(0, 12)}…).</div>`;
  },
};

registerActions({
  'help.report-copy': async () => copyText((await call('diag:report')).text, 'Report copied'),
  'help.report-save': async () => {
    const r = await call('diag:save');
    toast(r.saved ? `Saved to ${r.path}` : 'Not saved.', r.saved ? 'ok' : 'mu');
  },
  'help.open': (el) => call('app:open-external', { url: el.dataset.url ?? '' }),
});
