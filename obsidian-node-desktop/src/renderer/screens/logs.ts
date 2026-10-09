import { html } from '../dom.js';
import { formatTime } from '../format.js';
import { call as api } from '../api.js';
import { store } from '../store.js';
import { badge, copyText, emptyCard, loadingCard, pageHead, registerActions, requestRender, toast, warn, openModal, closeModal } from '../ui.js';
import type { Screen } from './common.js';
import type { DiagnosticCheck } from '../../shared/view-types.js';
import type { LogEntry, LogSeverity } from '../../shared/log-types.js';
import type { Tone } from '../store.js';

let tab: 'logs' | 'diagnostics' = 'logs';
let minSeverity: LogSeverity = 'INFO';
let source: 'all' | 'node' | 'app' = 'all';
let filter = '';
let paused = false;
let frozen: LogEntry[] | null = null;
let checks: DiagnosticCheck[] | null = null;
let running = false;
let diagError: string | null = null;

const RANK: Record<LogSeverity, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const TONE: Record<LogSeverity, Tone> = { DEBUG: 'mu', INFO: 'ok', WARN: 'wn', ERROR: 'er' };
const CHECK_TONE: Record<DiagnosticCheck['status'], Tone> = { pass: 'ok', warn: 'wn', fail: 'er', info: 'in' };

function visible(): LogEntry[] {
  const base = paused && frozen ? frozen : store.logs;
  const q = filter.toLowerCase();
  return base
    .filter((e) => RANK[e.severity] >= RANK[minSeverity])
    .filter((e) => (source === 'all' ? true : source === 'node' ? e.source !== 'app' : e.source === 'app'))
    .filter((e) => !q || e.message.toLowerCase().includes(q) || e.component.toLowerCase().includes(q));
}

export const logs: Screen = {
  render() {
    const head = pageHead('Logs & Diagnostics', 'Logs & Diagnostics');
    const tabs = html`<div class="tabs" role="tablist"><button role="tab" class="${tab === 'logs' ? 'on' : ''}" data-action="logs.tab" data-tab="logs" aria-selected="${tab === 'logs'}">Logs</button><button role="tab" class="${tab === 'diagnostics' ? 'on' : ''}" data-action="logs.tab" data-tab="diagnostics" aria-selected="${tab === 'diagnostics'}">Diagnostics</button></div>`;
    return html`${head}${tabs}${tab === 'logs' ? logView() : diagView()}`;
  },
};

function logView(): unknown {
  const rows = visible();
  const shown = rows.slice(-300);
  return html`<div class="card" style="margin-top:14px"><div class="toolbar">
      <select class="in sm" id="lg-sev" aria-label="Minimum severity">${(['DEBUG', 'INFO', 'WARN', 'ERROR'] as LogSeverity[]).map((s) => html`<option value="${s}" ${s === minSeverity ? 'selected' : ''}>${s === 'DEBUG' ? 'All (debug)' : s === 'INFO' ? 'Info and above' : s === 'WARN' ? 'Warnings and errors' : 'Errors only'}</option>`)}</select>
      <select class="in sm" id="lg-src" aria-label="Source">${[['all', 'All sources'], ['node', 'Node'], ['app', 'Application']].map(([v, l]) => html`<option value="${v}" ${v === source ? 'selected' : ''}>${l}</option>`)}</select>
      <input class="in sm" id="lg-q" value="${filter}" placeholder="Filter text" autocomplete="off" style="flex:1;min-width:140px" aria-label="Filter log text">
      <button class="btn" data-action="logs.pause">${paused ? 'Resume live' : 'Pause'}</button>
      <button class="btn" data-action="logs.copy">Copy visible</button>
      <button class="btn d" data-action="logs.clear">Clear</button></div>
    <div class="sub" style="margin:8px 0">${rows.length} line${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? ` (showing the latest ${shown.length})` : ''}${paused ? ' · paused: new lines are held back' : ''}. Keys, passphrases and recovery phrases are removed before anything reaches this view.</div>
    ${shown.length === 0 ? emptyCard('No log lines match', store.logs.length === 0 ? 'The node has not written anything yet. Start it to see its output.' : 'Change the filters to see more.') : html`<div class="logbox" role="log" aria-live="off">${shown.map((e) => html`<div class="ll"><span class="lt">${formatTime(e.ts)}</span>${badge(e.severity, TONE[e.severity])}<span class="lc">${e.source === 'app' ? 'app' : e.component}</span><span class="lm">${e.message}</span></div>`)}</div>`}</div>`;
}

function diagView(): unknown {
  return html`<div class="card" style="margin-top:14px"><div class="toolbar"><button class="btn p" data-action="diag.run" ${running ? 'disabled' : ''}>${running ? 'Running checks…' : 'Run diagnostics'}</button><button class="btn" data-action="diag.copy">Copy report</button><button class="btn" data-action="diag.save">Save report…</button></div>
    <div class="sub" style="margin:8px 0">Each check queries the real node and machine. The report is redacted and safe to share: it contains no keys, passphrases or recovery phrases.</div>
    ${diagError ? warn(diagError, 'er') : ''}
    ${checks === null ? (running ? loadingCard('Running checks…') : html`<div class="sub">No checks run yet.</div>`) : html`${checks.map((c) => html`<div class="row"><span>${c.label}<div class="sub">${c.detail}</div></span>${badge(c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARNING' : c.status === 'fail' ? 'FAILED' : 'INFO', CHECK_TONE[c.status])}</div>`)}`}</div>`;
}

async function runChecks(): Promise<void> {
  running = true;
  diagError = null;
  requestRender();
  try {
    checks = await api('diag:run');
  } catch (error) {
    diagError = (error as Error).message;
  } finally {
    running = false;
    requestRender();
  }
}

registerActions({
  'logs.tab': (el) => {
    tab = el.dataset.tab === 'diagnostics' ? 'diagnostics' : 'logs';
    if (tab === 'diagnostics' && checks === null) void runChecks();
    requestRender();
  },
  'logs.pause': () => {
    paused = !paused;
    frozen = paused ? [...store.logs] : null;
    requestRender();
  },
  'logs.copy': async () => copyText(visible().map((e) => `${new Date(e.ts).toISOString()} ${e.severity} [${e.component}] ${e.message}`).join('\n'), 'Visible log lines copied'),
  'logs.clear': () => {
    openModal({
      title: 'Clear the log view?',
      body: () => html`<p class="mu0">This clears the lines held in memory for this session. Log files on disk are not deleted.</p>`,
      buttons: [{ label: 'Cancel' }, { label: 'Clear', kind: 'd', run: async () => { await api('node:logs-clear'); store.logs = []; frozen = null; closeModal(); } }],
    });
  },
  'diag.run': () => runChecks(),
  'diag.copy': async () => {
    const r = await api('diag:report');
    await copyText(r.text, 'Report copied');
  },
  'diag.save': async () => {
    const r = await api('diag:save');
    toast(r.saved ? `Saved to ${r.path}` : 'Not saved.', r.saved ? 'ok' : 'mu');
  },
});

export function logFilterChanged(id: string, value: string): boolean {
  if (id === 'lg-sev') minSeverity = value as LogSeverity;
  else if (id === 'lg-src') source = value as typeof source;
  else if (id === 'lg-q') filter = value;
  else return false;
  requestRender();
  return true;
}
