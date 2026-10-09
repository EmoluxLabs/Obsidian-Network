/**
 * Everything the extension adds on top of obsidian-app-web's screens, and nothing the app already does:
 *
 *   - the connect screen, shown instead of the app whenever there is no trustworthy server to ask;
 *   - the NODE screen: what this connection is and how healthy it is, read from the node through the
 *     server — connection, height, finality, peers, staleness, the validator set (read-only) and an
 *     explicit statement of what a browser extension cannot do;
 *   - a small connection summary under the landing screen, so the settings are reachable when signed out;
 *   - the handlers the Menu rows call.
 *
 * Every number on the NODE screen is a value the node returned. "—" means not known, "0" means zero, and
 * a node that stops answering turns the last values into STALE ones with their age, never into current ones.
 */
import { NETWORKS, runDiagnostics, staleAfterSeconds } from './config.mjs';

const STATE_COLOURS = { ok: 'ok', warn: '', fail: '', skipped: 'mu' };

function ago(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '\u2014';
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** Host only: a server address is public, but node addresses behind it are shown without their ports and paths. */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '\u2014';
  }
}

export function installExtScreens({ SCREENS, esc, api, host, getState, repaint, readRoute, getNodes, now = () => Date.now() }) {
  const settings = host.settings;
  const view = {
    loading: false,
    at: null, // when the node last answered, ms
    error: null, // why the latest attempt failed, or null
    status: null,
    nodes: null,
    validators: null,
    diag: null,
    diagRunning: false,
  };

  async function load() {
    if (view.loading) return;
    view.loading = true;
    repaint();
    const ask = async (promise) => {
      try {
        return { ok: true, value: await promise };
      } catch (error) {
        return { ok: false, error };
      }
    };
    const [status, nodes, validators] = await Promise.all([ask(readRoute('/status')), ask(getNodes()), ask(readRoute('/validators'))]);
    view.loading = false;
    if (status.ok && Number.isInteger(status.value?.height)) {
      view.status = status.value;
      view.at = now();
      view.error = null;
    } else {
      view.error = status.ok ? 'The node answered, but not with a status this extension understands.' : String(status.error?.message ?? status.error);
    }
    view.nodes = nodes.ok && Array.isArray(nodes.value?.nodes) ? nodes.value : null;
    view.validators = validators.ok && Array.isArray(validators.value?.registered) ? validators.value : null;
    repaint();
  }

  const row = (label, value, cls = 'm') => `<div class="row"><span>${esc(label)}</span><b class="${cls}">${value}</b></div>`;
  const dash = (value) => (value === null || value === undefined || value === '' ? '\u2014' : esc(value));

  SCREENS.node = (s) => {
    if (view.at === null && !view.loading && !view.error) queueMicrotask(load);
    const st = view.status;
    const age = view.at === null ? null : Math.max(0, Math.round((now() - view.at) / 1000));
    let pill = ['LOADING', ''];
    if (st && !view.error) pill = ['CONNECTED', 'ok'];
    else if (st) pill = ['STALE', 'warn'];
    else if (view.error) pill = ['UNAVAILABLE', 'fail'];

    const blockAge = st && Number.isFinite(st.lastBlockTimestamp) ? Math.round(view.at / 1000 - st.lastBlockTimestamp) : null;
    const chainStale = blockAge !== null && blockAge > staleAfterSeconds(5);

    const banner =
      view.error && st
        ? `<div role="alert" style="background:#FFF4D6;color:#7A5800;font-size:12px;font-weight:700;padding:10px 14px;border-radius:12px;margin-bottom:12px">STALE \u2014 the node has stopped answering. These figures are from ${esc(ago(age))} and are not current. ${esc(view.error)}</div>`
        : view.error
          ? `<div role="alert" style="background:#FDECEA;color:#A12626;font-size:12px;font-weight:700;padding:10px 14px;border-radius:12px;margin-bottom:12px">NOT CONNECTED \u2014 ${esc(view.error)}</div>`
          : '';

    const nodes = view.nodes?.nodes ?? null;
    const validators = view.validators;
    const diag = view.diag;

    return (
      `<div class="hd"><b style="letter-spacing:.18em">NODE</b><span class="pill" style="${pill[1] === 'ok' ? '' : 'background:#FFF4D6;color:#7A5800'}">${pill[0]}</span></div>` +
      banner +
      `<div class="lb">CONNECTION</div><div class="card">` +
      row('SERVER', esc(hostOf(settings.serverUrl)), 'm') +
      row('NETWORK', esc((s.appConfig?.network ?? settings.network ?? '').toUpperCase() || '\u2014') + (s.appConfig ? ` \u00b7 chain ${esc(s.appConfig.chainId)}` : ''), 'm') +
      row('LAST ANSWER', age === null ? '\u2014' : esc(ago(age)), 'm') +
      `</div>` +
      `<div class="lb">CHAIN${st && view.error ? ' (STALE)' : ''}</div><div class="card">` +
      row('BLOCK HEIGHT', dash(st?.height), 'm') +
      row('FINALIZED HEIGHT', dash(st?.finalizedHeight), 'm') +
      row('LAST BLOCK', blockAge === null ? '\u2014' : esc(ago(blockAge)) + (chainStale ? ' \u00b7 STALE' : ''), 'm') +
      row('PEERS', dash(st?.peers), 'm') +
      row('SYNC', st ? (st.syncing ? 'SYNCING' : 'IN SYNC') : '\u2014', st && !st.syncing ? 'ok' : 'mu') +
      row('MEMPOOL', dash(st?.mempool?.transactions), 'm') +
      row('PROTOCOL', dash(st?.protocolVersion), 'm') +
      row('GENESIS', st?.genesisId ? esc(String(st.genesisId).slice(0, 12)) + '\u2026' : '\u2014', 'm') +
      `</div>` +
      `<div class="lb">NODES BEHIND THIS SERVER</div>` +
      (nodes
        ? `<div class="card">${
            nodes.length
              ? nodes
                  .map(
                    (n) =>
                      `<div class="row"><div><b class="m" style="font-size:13px">${esc(hostOf(n.url))}</b><div class="mu" style="font-size:11px">height ${dash(n.height)} \u00b7 ${n.latencyMs === undefined ? '\u2014' : esc(n.latencyMs)} ms</div></div><span class="pill" style="${n.healthy && !n.wrongNetwork ? '' : 'background:#FDECEA;color:#A12626'}">${n.wrongNetwork ? 'WRONG NETWORK' : n.healthy ? 'HEALTHY' : 'DOWN'}</span></div>`,
                  )
                  .join('')
              : '<div class="row mu">The server reports no nodes.</div>'
          }</div>`
        : `<div class="card"><div class="row mu">${view.loading ? 'Loading\u2026' : 'Unavailable \u2014 the server did not return its node list.'}</div></div>`) +
      `<div class="lb">VALIDATORS</div>` +
      (validators
        ? `<div class="card">` +
          row('REGISTERED', esc(validators.registered.length), 'm') +
          row('ACTIVE', dash(validators.count), 'm') +
          validators.registered
            .slice(0, 6)
            .map((v) => `<div class="row"><div><b class="m" style="font-size:12px">${esc(v.address)}</b><div class="mu" style="font-size:11px">bond ${dash(v.bond)} OBS \u00b7 missed ${dash(v.missedSlots)}</div></div><span class="pill">${esc(v.status)}</span></div>`)
            .join('') +
          `</div>`
        : `<div class="card"><div class="row mu">${view.loading ? 'Loading\u2026' : 'Unavailable \u2014 the validator set could not be read.'}</div></div>`) +
      `<div class="card" style="margin-top:12px;padding:14px 16px"><div class="lb" style="margin:0 0 6px">NOT AVAILABLE IN A BROWSER</div>` +
      `<p class="mu" style="font-size:12.5px;margin:0;line-height:1.5">Running a node, registering as a validator and bonding ${validators?.slashing?.bondObs ? esc(String(validators.slashing.bondObs).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')) + ' OBS' : 'the validator bond'} need a node\u2019s own signing key and a process that stays up. A browser extension can do neither safely, so those controls are not here and nothing on this screen pretends otherwise. Run them from Obsidian Node (the desktop app) or obsidian-core; this screen will show the result.</p></div>` +
      `<button class="btn" onclick="ObsidianExtRefreshNode()">${view.loading ? 'CHECKING\u2026' : 'REFRESH'}</button>` +
      `<div class="lb">DIAGNOSTICS</div>` +
      (diag
        ? `<div class="card">${diag
            .map(
              (d) =>
                `<div class="row" style="display:block"><div style="display:flex;justify-content:space-between"><span>${esc(d.label.toUpperCase())}</span><b class="${STATE_COLOURS[d.status] ?? ''}">${esc(d.status.toUpperCase())}</b></div><div class="mu" style="font-size:12px;margin-top:4px;word-break:break-word">${esc(d.detail)}</div></div>`,
            )
            .join('')}</div>`
        : '') +
      `<button class="btn" onclick="ObsidianExtDiagnose()">${view.diagRunning ? 'RUNNING CHECKS\u2026' : 'RUN CHECKS'}</button>` +
      `<button class="btn" onclick="ObsidianExtConnection()">CONNECTION SETTINGS</button>` +
      (s.account
        ? `<button class="btn" onclick="ObsidianGo('menu')">\u2039 BACK</button>`
        : `<button class="btn" onclick="ObsidianGo('landing')">\u2039 BACK</button>`)
    );
  };

  // The landing screen belongs to the app; this only adds where the settings are when nobody is signed in.
  const landing = SCREENS.landing;
  SCREENS.landing = (s) =>
    landing(s) +
    `<div style="max-width:430px;margin:0 auto;padding:0 20px 24px"><div class="card" style="padding:4px 16px"><div class="row"><span>CONNECTED TO</span><b class="m" style="font-size:13px">${esc(hostOf(settings.serverUrl))}</b></div></div>` +
    `<button class="btn" onclick="ObsidianGo('node')">NODE &amp; CONNECTION</button></div>`;

  const openOptions = () => {
    api.runtime.openOptionsPage?.();
  };
  const handlers = {
    ObsidianExtConnection: openOptions,
    ObsidianExtTab: () => {
      api.tabs.create({ url: api.runtime.getURL('popup.html') });
      if (new URLSearchParams(location.search).get('popup') === '1') window.close();
    },
    ObsidianExtRefreshNode: () => load(),
    ObsidianExtDiagnose: async () => {
      if (view.diagRunning) return;
      view.diagRunning = true;
      repaint();
      try {
        view.diag = await runDiagnostics(settings.serverUrl, settings.network);
      } finally {
        view.diagRunning = false;
        repaint();
      }
    },
  };
  Object.assign(globalThis, handlers);
  return { view, load };
}

/**
 * The screen shown INSTEAD of the app when it cannot safely run. Deliberately shows no balance, no height,
 * no wallet, nothing that could be mistaken for chain data.
 */
export function showConnectScreen({ reason, host, kind, message, api }) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const titles = {
    'not-configured': ['CONNECT', 'This extension has no server yet. It does not carry a network inside it: it connects to an Obsidian app server \u2014 one you run with Obsidian Node, or your network\u2019s public app \u2014 and every balance and block it shows comes from there.'],
    permission: ['PERMISSION NEEDED', `The extension is not allowed to contact ${esc(host ?? 'the server')}. Open the connection settings and allow it; the browser will ask you.`],
    unreachable: ['CAN\u2019T REACH THE SERVER', message],
    timeout: ['THE SERVER DID NOT ANSWER', message],
    malformed: ['NOT AN OBSIDIAN SERVER', message],
    unsupported: ['UNSUPPORTED SERVER', message],
    'wrong-network': ['WRONG NETWORK', message],
    unverified: ['SERVER NOT VERIFIED', message],
    server: ['SERVER ERROR', message],
    rejected: ['SERVER REFUSED', message],
  };
  const [title, body] = titles[reason] ?? titles[kind] ?? ['CAN\u2019T CONNECT', message ?? 'The connection failed.'];
  const app = document.getElementById('app');
  app.innerHTML =
    `<div class="hd"><b style="letter-spacing:.18em">OBSIDIAN</b><span class="pill" style="background:#FDECEA;color:#A12626">NOT CONNECTED</span></div>` +
    `<h1 style="margin-top:12px">${esc(title)}</h1>` +
    `<p class="mu" style="line-height:1.5;margin:12px 0 4px" id="connect-detail">${reason === 'not-configured' || reason === 'permission' ? body : esc(body)}</p>` +
    (host ? `<div class="card" style="margin-top:12px"><div class="row"><span>SERVER</span><b class="m" style="font-size:13px">${esc(host)}</b></div></div>` : '') +
    `<button class="btn p" onclick="ObsidianExtConnection()">CONNECTION SETTINGS</button>` +
    (reason === 'not-configured' ? '' : `<button class="btn" onclick="ObsidianExtRetry()">TRY AGAIN</button>`);
  globalThis.ObsidianExtConnection = () => api.runtime.openOptionsPage?.();
  globalThis.ObsidianExtRetry = () => location.reload();
}

export { NETWORKS };
