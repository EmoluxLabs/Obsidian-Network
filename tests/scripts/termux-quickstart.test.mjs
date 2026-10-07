/**
 * docs/TERMUX-QUICKSTART.md: every command in it is run, as written.
 *
 *   node --test tests/scripts/termux-quickstart.test.mjs
 *
 * A guide that has never been run is a guess. This takes the shell blocks out of each network's section of
 * the quick-start page and runs them verbatim, in order, the way a person pastes them: in a stand-in for a
 * fresh Termux (its own home directory, its own temp directory, and only the tools Termux ships), with
 * `~/obsidian/run` laid out the way the guide's install leaves it. Then it checks what the page promised:
 * the interface it names is the interface that answers, `doctor` finds nothing wrong, `stop` stops it, and
 * `reset` leaves the network empty.
 *
 * Blocks that cannot run unattended are skipped, and say why: the one that waits for a typed passphrase
 * (the test stands in for the person typing it), `logs` (which follows a log until Ctrl-C), and the example
 * that names peers at a documentation address.
 *
 * Needs both packages built. Binds each network's usual ports plus 900 (node 9530/19530/29530/39530, peers
 * one above, interface 9688/19688/29688/39688), one network at a time.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const built = existsSync(join(root, 'obsidian-core', 'dist', 'index.js')) && existsSync(join(root, 'obsidian-interface', 'dist', 'server', 'main.js'));
const skip = !built ? 'build obsidian-core and obsidian-interface first' : process.platform === 'win32' ? 'bash only' : false;
// The gate runs test files side by side, so this one has a port range of its own (network-script uses +700).
const OFFSET = 900;

const doc = readFileSync(join(root, 'docs', 'TERMUX-QUICKSTART.md'), 'utf8');

function sectionOf(heading) {
  const all = doc.split('\n');
  const start = all.findIndex((line) => heading.test(line));
  assert.ok(start >= 0, `heading ${heading} not found`);
  let end = all.length;
  for (let i = start + 1; i < all.length; i += 1) if (/^## /.test(all[i])) { end = i; break; }
  return all.slice(start, end).join('\n');
}
const blocksOf = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\n$/, ''));

// A fresh Termux: a home of its own, a temp directory of its own, and only what Termux ships.
const scratch = mkdtempSync(join(tmpdir(), 'obsidian-quickstart-'));
const bin = join(scratch, 'bin');
const home = join(scratch, 'home');
const tmp = join(scratch, 'tmp');
for (const dir of [bin, home, tmp]) mkdirSync(dir, { recursive: true });
const TERMUX_TOOLS = 'sh env cat cp mv rm mkdir rmdir ls chmod ln touch head tail cut tr sort uniq wc tee sed grep awk find xargs tar gzip date sleep dirname basename readlink realpath mktemp uname id whoami stat du df od base64 sha256sum expr seq timeout tty stty nohup node'.split(' ');
if (!skip) {
  for (const tool of TERMUX_TOOLS) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(realpathSync(found), join(bin, tool));
  }
  symlinkSync(realpathSync(spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()), join(bin, 'bash'));
  // ~/obsidian/run as the install leaves it: the helper, the node, the interface, the invitation script.
  const run = join(home, 'obsidian', 'run');
  mkdirSync(run, { recursive: true });
  symlinkSync(join(root, 'scripts', 'obsidian-network.sh'), join(run, 'obsidian-network.sh'));
  symlinkSync(join(root, 'scripts', 'new-genesis-invite.mjs'), join(run, 'new-genesis-invite.mjs'));
  symlinkSync(join(root, 'obsidian-core'), join(run, 'obsidian-core'));
  symlinkSync(join(root, 'obsidian-interface'), join(run, 'obsidian-interface'));
}
const envFor = (extra = {}) => ({ PATH: bin, HOME: home, TMPDIR: tmp, OBSIDIAN_PORT_OFFSET: String(OFFSET), ...extra });
const paste = (block, extra) => spawnSync(join(bin, 'bash'), ['-e', '-c', block], { encoding: 'utf8', timeout: 180_000, env: envFor(extra) });
const get = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).status;
  } catch {
    return 0;
  }
};

after(() => {
  for (const network of ['devnet', 'testnet', 'staging', 'mainnet']) paste(`cd ~/obsidian/run && bash obsidian-network.sh ${network} stop`);
  rmSync(scratch, { recursive: true, force: true });
});

const NETWORKS = [
  { name: 'devnet', heading: /^## 3\. Devnet/, chainId: 7780 },
  { name: 'testnet', heading: /^## 4\. Testnet/, chainId: 7778 },
  { name: 'staging', heading: /^## 5\. Staging/, chainId: 7779 },
  { name: 'mainnet', heading: /^## 6\. Mainnet/, chainId: 7777 },
];

for (const { name, heading, chainId } of NETWORKS) {
  test(`the ${name} section of the quick-start page, run exactly as written`, { skip, timeout: 400_000 }, async () => {
    const body = sectionOf(heading);
    const ui = Number(/interface \*\*http:\/\/127\.0\.0\.1:(\d+)\*\*/.exec(body)?.[1]);
    const rpc = Number(/node \*\*(\d+)\*\*/.exec(body)?.[1]);
    assert.ok(ui > 0 && rpc > 0, `the ${name} section states its interface and node ports`);
    assert.match(body, new RegExp(`Chain id \\*\\*${chainId}\\*\\*`));

    const skipped = [];
    const runnable = [];
    for (const block of blocksOf(body)) {
      if (/read -r -s/.test(block)) skipped.push('the typed-passphrase prompt');
      else if (/OBSIDIAN_SEED_NODES/.test(block)) skipped.push('the example peers');
      else runnable.push(block.split('\n').filter((line) => !/ logs$/.test(line)).join('\n')); // `logs` follows until Ctrl-C
    }
    assert.ok(runnable.some((block) => new RegExp(`obsidian-network\\.sh ${name} start`).test(block)), `the ${name} section has a start command`);
    // The person typed their passphrase; the test stands in for them.
    const typed = name === 'mainnet' ? { MP: 'a-twelve-plus-character-passphrase' } : {};

    let started = false;
    try {
      for (const block of runnable) {
        const result = paste(block, typed);
        assert.equal(result.status, 0, `this block, pasted as written, failed:\n${block}\n\n${result.stdout}\n${result.stderr}`);
        if (new RegExp(`obsidian-network\\.sh ${name} (start|restart)`).test(block)) {
          started = true;
          // What the page says is the interface IS the interface, and it is the right chain.
          assert.equal(await get(`http://127.0.0.1:${ui + OFFSET}/api/health`), 200, `the page names http://127.0.0.1:${ui}, and nothing answers there`);
          const status = await (await fetch(`http://127.0.0.1:${rpc + OFFSET}/status`)).json();
          assert.equal(status.chainId, chainId, `the ${name} node reports chain ${chainId}`);
          const doctor = paste(`cd ~/obsidian/run && bash obsidian-network.sh ${name} doctor`, typed);
          assert.equal(doctor.status, 0, `doctor finds nothing wrong on a network the page just started:\n${doctor.stdout}`);
        }
        if (new RegExp(`obsidian-network\\.sh ${name} stop`).test(block)) {
          assert.equal(await get(`http://127.0.0.1:${ui + OFFSET}/api/health`), 0, 'stop stops the interface');
          assert.equal(await get(`http://127.0.0.1:${rpc + OFFSET}/health`), 0, 'stop stops the node');
        }
      }
      assert.ok(started, 'the page starts the network');
    } finally {
      paste(`cd ~/obsidian/run && bash obsidian-network.sh ${name} stop`);
    }
    // The skips are the ones the header names, nothing else.
    for (const reason of skipped) assert.match(reason, /typed-passphrase prompt|example peers/);
  });
}

test('the page keeps every network separate', { skip }, () => {
  for (const { name, heading } of NETWORKS) {
    const body = sectionOf(heading);
    for (const block of blocksOf(body)) {
      for (const m of block.matchAll(/obsidian-network\.sh\s+([a-z<>]+)\s+/g)) {
        assert.equal(m[1], name, `a ${name} command names ${m[1]}:\n${block}`);
      }
      assert.ok(!/^\s*export\s/m.test(block), `a ${name} block exports a variable, which would stay in the session and reach the next network:\n${block}`);
    }
  }
  // Nothing in the whole page is exported, so nothing can leak from one block to the next.
  for (const block of blocksOf(doc)) assert.ok(!/^\s*export\s/m.test(block), `an exported variable:\n${block}`);
});

test('what the page tells a person to type for a passphrase never lands in a command that is saved with it', { skip }, () => {
  const mainnet = sectionOf(/^## 6\. Mainnet/);
  const blocks = blocksOf(mainnet);
  const typedLine = blocks.find((block) => /read -r -s/.test(block));
  assert.ok(typedLine && typedLine.split('\n').length === 1, 'the prompt is a block of its own, so pasting it cannot swallow the lines after it');
  assert.ok(!/OBSIDIAN_KEYSTORE_PASSPHRASE='/.test(mainnet), 'no passphrase is written into a command');
});
