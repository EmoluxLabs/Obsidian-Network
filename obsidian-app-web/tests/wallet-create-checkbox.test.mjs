/**
 * The "I have saved both the recovery phrase and the private key" box must survive pressing SEAL WALLET.
 *
 * The behaviour itself is proven in a real browser (tests/e2e-browser-wallet-create.mjs): the fake DOM the unit tests use keeps
 * one element per id, so a repaint never unticks anything there. This guard holds the two rules that fix it in place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/real.mjs', import.meta.url), 'utf8');

test('the box is read BEFORE the busy state repaints the page', () => {
  const start = source.indexOf('g.ObsidianSetupWallet = ');
  assert.ok(start > 0, 'ObsidianSetupWallet exists');
  const body = source.slice(start, source.indexOf('g.ObsidianRevealPhrase', start));
  const read = body.indexOf("getElementById('cksaved')");
  const busy = body.indexOf('withBusy(');
  assert.ok(read > 0 && busy > 0, 'both are present');
  assert.ok(read < busy, 'the checkbox is read before withBusy repaints (a repaint builds a new, unticked box)');
  assert.equal(body.slice(busy).includes("getElementById('cksaved')"), false, 'and never read again inside the busy callback');
});

test('every box that was ticked is ticked again after a repaint caused by an action', () => {
  const start = source.indexOf('async function withBusy(');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /input\[type=checkbox\]/, 'ticked boxes are remembered');
  assert.match(body, /retick\(\)/, 'and put back');
  assert.ok(body.indexOf('render();\n  retick();') > 0, 'right after the busy repaint, before the action reads the page');
  assert.ok(/state\.error && state\.screen === screen[\s\S]*retick\(\)/.test(body), 'and after a refusal, so the person does not tick it again');
});
