/**
 * The repository agrees with itself.
 *
 * Every defect this test exists to catch was found the same way: a guide, an example or a
 * unit file said one thing and the code did another. An operator following the guide is the
 * one who finds out, at the worst moment. So the things that must agree are checked here,
 * mechanically, against the code that actually runs:
 *
 *   - versions: package files, lock files, the VERSION file, the version the node reports
 *   - identity: genesis ids, hashes and the params hash in the docs against `genesis init`
 *   - ports, chain ids and address prefixes in the guides against the networks the code defines
 *   - the four networks never mixed: each network's section of a guide names only its own
 *   - environment variables: every one an example or a unit sets is one the code reads
 *   - archive names, test counts, links and file paths in the docs
 *   - the helper script's commands, the systemd units, the nginx files and the npm scripts
 *
 * Needs obsidian-core built (`npm --prefix obsidian-core run build`) for the parts that ask
 * the real node; those tests say so and skip when it is not.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const CORE = join(ROOT, 'obsidian-core');
const IFACE = join(ROOT, 'obsidian-interface');
const NETWORKS = ['mainnet', 'testnet', 'staging', 'devnet'];
const HELPER_COMMANDS = ['start', 'stop', 'restart', 'status', 'logs', 'wallet', 'invite', 'reset', 'doctor', 'help'];

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const exists = (path) => existsSync(join(ROOT, path));
const json = (path) => JSON.parse(read(path));
const builtCore = existsSync(join(CORE, 'dist', 'index.js')) && existsSync(join(CORE, 'dist', 'protocol', 'networks.js'));
const skipUnbuilt = builtCore ? false : 'obsidian-core is not built (npm --prefix obsidian-core run build)';

function walk(dir, accept, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'releases', '.data', 'data'].includes(name)) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

const docFiles = () => [
  'README.md',
  ...readdirSync(join(ROOT, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
  'obsidian-core/README.md',
  'obsidian-core/config/README.md',
  'obsidian-core/deployment/monitoring/README.md',
  'obsidian-interface/README.md',
  'cloudflare/README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
].filter(exists);
/**
 * Every document here describes the release this tree ships. The fresh start
 * removed the two dated reports of the previous release and everything else
 * that came before 1.6.0; the test "the tree carries nothing older than the
 * release it ships" keeps it that way, so there is no "historical document"
 * category left to exclude from the checks below.
 */
const currentDocs = () => docFiles();

test('the current docs claim the shipped protocol version, not an older one', () => {
  const coreVersion = json('obsidian-core/package.json').version;
  const protocolVersion = read('obsidian-core/src/version.ts').match(/PROTOCOL_VERSION\s*=\s*'([^']+)'/)[1];
  assert.equal(protocolVersion, coreVersion, 'protocol and software version ship together in this release');
  // The shapes a reader takes as "the version of the software I am about to
  // run". Package versions (@noble/hashes@1.5.0), IP addresses, `1.5.x` upgrade
  // notes and lines explicitly marked historical are not claims about this
  // release and are not matched.
  const shapes = [
    /protocolVersion["']?\s*[:=]\s*["'`]?(\d+\.\d+\.\d+)/,
    /\bprotocol\s+(\d+\.\d+\.\d+)/,
    /\bcore\s+and\s+protocol\s+`?(\d+\.\d+\.\d+)/i,
    /\b(?:Protocol|protocol)\/?c?o?r?e?\s+version\s+(?:is\s+)?`?(\d+\.\d+\.\d+)/,
    /\|\s*Protocol version\s*\|\s*`?(\d+\.\d+\.\d+)/,
    /coreVersion`?\s*\/\s*`?protocolVersion`?\s*\|\s*`?(\d+\.\d+\.\d+)/,
  ];
  const stale = [];
  for (const file of currentDocs()) {
    lines(read(file)).forEach((line, index) => {
      const lower = line.toLowerCase();
      if (lower.includes('historical note') || lower.includes('historical record')) return;
      for (const shape of shapes) {
        for (const match of line.matchAll(new RegExp(shape.source, 'g'))) {
          if (match[1] !== coreVersion) stale.push(`${file}:${index + 1}: ${match[1]} (shipping ${coreVersion})`);
        }
      }
    });
  }
  assert.deepEqual(stale, [], `current docs claiming another protocol version:\n${stale.join('\n')}`);
});

test('the interface image ships exactly the sites the build produces', () => {
  // A COPY for a site that no longer exists fails the image build, and a site
  // that exists but is never copied silently disappears from a container that
  // otherwise reports healthy. Both happened; the list is checked here.
  const script = read('obsidian-interface/scripts/build-sites.mjs');
  const ids = [...script.matchAll(/^ {4}id: '([a-z]+)',$/gm)].map((match) => match[1]);
  assert.ok(ids.length >= 9, `expected the site list, found ${ids.length} entries`);
  const dockerfile = read('obsidian-interface/deployment/docker/Dockerfile');
  const pairs = [...dockerfile.matchAll(/^COPY --from=builder --chown=root:root \/build\/([a-z]+) +\/app\/sites\/([a-z]+)$/gm)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(pairs.map(([from]) => from).sort(), [...ids].sort(),
    'the Dockerfile COPY list must match the built sites exactly');
  for (const [from, to] of pairs) assert.equal(from, to, 'a site must be copied to the directory of the same name');
});

test('the site count a current doc quotes is the one the build writes', () => {
  // The build prints the count and the guides repeat it, so a retired count is a
  // claim about output the reader is about to see. Four current files quoted a
  // count one size larger than the build writes when this test was added.
  const ids = [...read('obsidian-interface/scripts/build-sites.mjs').matchAll(/^ {4}id: '([a-z]+)',$/gm)].map((match) => match[1]);
  const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
    twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
  // "port-80 site" is a listen address and "one site" means "any single site": the
  // negative lookbehind drops the first, and "one" is not in the alternation.
  const shape = /(?<![-\w])(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:site shells?|sites?|site directories?|site folders?|front-?ends?|apps?|pages?)\b/g;
  const stale = [];
  for (const file of [...currentDocs(), 'releases/README.md']) {
    if (!exists(file)) continue;
    lines(read(file)).forEach((line, index) => {
      for (const match of line.matchAll(shape)) {
        const value = words[match[1]] ?? Number(match[1]);
        if (value !== ids.length) stale.push(`${file}:${index + 1}: ${match[0]} (the build writes ${ids.length})`);
      }
    });
  }
  assert.deepEqual(stale, [], `a doc quotes a site count the build does not write:\n${stale.join('\n')}`);
});

test('the tree carries nothing older than the release it ships', () => {
  // This repository is a fresh start: one release, one chain, one history. The
  // dated reports of the previous release, its archives and its notes were
  // removed on purpose, so a reader cannot mistake an old artefact for this
  // release — and this test is what keeps one from being copied back in.
  const version = json('obsidian-core/package.json').version;
  for (const gone of ['docs/IMPLEMENTATION-REPORT.md', 'docs/MAINNET-SECURITY-AUDIT.md']) {
    assert.ok(!exists(gone), `${gone} records an older release and must stay deleted`);
  }
  const stale = [];
  for (const name of readdirSync(join(ROOT, 'releases'))) {
    const match = /(?:RELEASE-NOTES-|obsidian-[a-z-]+-)(\d+\.\d+\.\d+)/.exec(name);
    if (match && match[1] !== version) stale.push(`releases/${name}`);
  }
  assert.deepEqual(stale, [], `release artefacts from a version that no longer ships:\n${stale.join('\n')}`);
  const headings = [...read('CHANGELOG.md').matchAll(/^##\s+\[?(\d+\.\d+\.\d+)\]?/gm)].map((match) => match[1]);
  assert.ok(headings.length >= 1, 'the CHANGELOG records this release');
  assert.deepEqual([...new Set(headings)], [version],
    `the CHANGELOG keeps entries for ${[...new Set(headings)].join(', ')}; this repository records only ${version}`);
});

const lines = (text) => text.split('\n');
function grepLines(text, regex) {
  const hits = [];
  lines(text).forEach((line, index) => {
    if (regex.test(line)) hits.push({ line: index + 1, text: line.trim() });
  });
  return hits;
}

/** The fenced code blocks of a markdown file, in order, without their fences. */
function fencedBlocks(text) {
  const out = [];
  let current = null;
  for (const line of lines(text)) {
    if (/^```/.test(line)) {
      if (current) {
        out.push(current.join('\n'));
        current = null;
      } else current = [];
    } else if (current) current.push(line);
  }
  return out;
}

/** Section `heading` of a markdown file, up to the next heading of the same or higher level. */
function section(text, headingRegex) {
  const all = lines(text);
  // `# comment` lines inside a fenced code block are shell comments, not headings.
  let fenced = false;
  const isHeading = all.map((line) => {
    if (/^```/.test(line)) fenced = !fenced;
    return !fenced && /^#+ /.test(line);
  });
  const start = all.findIndex((line, i) => isHeading[i] && headingRegex.test(line));
  assert.ok(start >= 0, `heading ${headingRegex} not found`);
  const level = all[start].match(/^#+/)[0].length;
  let end = all.length;
  for (let i = start + 1; i < all.length; i += 1) {
    if (isHeading[i] && all[i].match(/^#+/)[0].length <= level) {
      end = i;
      break;
    }
  }
  return all.slice(start, end).join('\n');
}

// ── versions ─────────────────────────────────────────────────────────────────

test('one version everywhere: packages, lock files, VERSION, the node, the browser copy', () => {
  const version = json('obsidian-core/package.json').version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(json('obsidian-interface/package.json').version, version, 'interface package version');
  for (const pkg of ['obsidian-core', 'obsidian-interface']) {
    const lock = json(`${pkg}/package-lock.json`);
    assert.equal(lock.version, version, `${pkg} lock file version`);
    assert.equal(lock.packages[''].version, version, `${pkg} lock file root package version`);
  }
  assert.equal(read('obsidian-core/VERSION').trim(), version, 'obsidian-core/VERSION');
  const source = read('obsidian-core/src/version.ts');
  assert.equal(source.match(/CORE_VERSION\s*=\s*'([^']+)'/)[1], version, 'CORE_VERSION in src/version.ts');
  const browser = read('obsidian-interface/web/core/version.js');
  assert.equal(browser.match(/CORE_VERSION\s*=\s*'([^']+)'/)[1], version, 'CORE_VERSION in the interface\'s browser copy');

  const changelog = read('CHANGELOG.md');
  const newest = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)[1];
  assert.equal(newest, version, 'the newest CHANGELOG entry is the version being shipped');

  // Image tags that pin a version must pin this one.
  for (const file of ['obsidian-core/deployment/docker/docker-compose.yml', 'obsidian-interface/deployment/docker/docker-compose.yml']) {
    for (const hit of grepLines(read(file), /image:\s*\S*obsidian\S*:\d/i)) {
      assert.ok(hit.text.includes(`:${version}`), `${file}:${hit.line} pins a different version: ${hit.text}`);
    }
  }
});

test('archive names in the guides name the version being shipped', () => {
  const version = json('obsidian-core/package.json').version;
  const archive = /obsidian-(?:core|interface|interface-selfhost|node-operator|cloudflare|network-source)-(\d+\.\d+\.\d+)/g;
  const stale = [];
  for (const file of [...currentDocs(), 'scripts/verify-release.sh', 'scripts/package-releases.sh', 'scripts/sign-release.sh']) {
    if (!exists(file)) continue;
    lines(read(file)).forEach((line, index) => {
      for (const m of line.matchAll(archive)) if (m[1] !== version) stale.push(`${file}:${index + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(stale, [], `archive names with another version than ${version}:\n${stale.join('\n')}`);
});

test('install commands do not check out an old release', () => {
  const version = json('obsidian-core/package.json').version;
  const old = [];
  for (const file of currentDocs()) {
    lines(read(file)).forEach((line, index) => {
      const m = line.match(/(?:--branch|checkout|git clone[^\n]*-b)\s+v(\d+\.\d+\.\d+)/);
      if (m && m[1] !== version) old.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(old, [], `commands that install a release other than ${version}:\n${old.join('\n')}`);
});

test('the release version a current doc tags or reads its notes from is the shipping one', () => {
  // Tag examples and release-notes filenames are instructions, not decoration: a
  // reader who runs `git show --stat` on a tag this repository does not carry
  // gets "bad object". Only the shipping version may be named — Node's own
  // v20.x.y runtimes are a runtime requirement, not a claim about a release.
  const version = json('obsidian-core/package.json').version;
  const stale = [];
  for (const file of [...currentDocs(), 'releases/README.md']) {
    if (!exists(file)) continue;
    lines(read(file)).forEach((line, index) => {
      if (/\bv2\d\.\d+\.\d+/.test(line)) return;   // Node's runtime, e.g. v20.10.0
      for (const match of line.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)) {
        if (match[1] !== version) stale.push(`${file}:${index + 1}: v${match[1]} (shipping v${version})`);
      }
      for (const match of line.matchAll(/RELEASE-NOTES-(\d+\.\d+\.\d+)\.md/g)) {
        if (match[1] !== version) stale.push(`${file}:${index + 1}: RELEASE-NOTES-${match[1]}.md (shipping ${version})`);
      }
    });
  }
  assert.deepEqual(stale, [], `current docs point at another release:\n${stale.join('\n')}`);
});

test('Step 4 of the phone guides is paste-safe, retries each file, fetches what Step 6 unpacks, and survives a bad connection', () => {
  const version = json('obsidian-core/package.json').version;
  const githubUrl = 'https://github.com/EmoluxLabs/Obsidian-Network.git';
  const shared = { setup: new Set(), clone: new Set(), files: new Set() };
  for (const file of ['docs/LAUNCH-GUIDE.md', 'docs/DEVNET-TERMUX-RUNBOOK.md', 'docs/TERMUX-QUICKSTART.md']) {
    const text = read(file);
    const blocks = fencedBlocks(text);

    // A command split over two lines loses its line break when it is pasted into Termux, and the
    // error that follows says nothing about why. No code block of a phone guide may do it.
    const split = [];
    let fenced = false;
    lines(text).forEach((line, index) => {
      if (/^```/.test(line)) fenced = !fenced;
      else if (fenced && /(?<!\\)\\$/.test(line)) split.push(`${index + 1}: ${line.trim()}`);
    });
    assert.deepEqual(split, [], `${file}: a command in a code block ends in a backslash, which breaks when pasted on a phone:\n${split.join('\n')}`);

    const download = blocks.find((b) => /^G="git /m.test(b) && /^for i in 1 2 3 4 5 6 7 8; do /m.test(b));
    assert.ok(download, `${file}: the retrying release download is missing`);
    const setup = lines(download).find((l) => l.startsWith('G="git '));
    const clone = lines(download).find((l) => l.startsWith('for i in 1 2 3 4 5 6 7 8; do rm -rf src; $G clone '));
    const files = lines(download).find((l) => l.startsWith('cd src && for f in '));
    assert.ok(clone && files, `${file}: the download must be a retrying clone followed by a retrying fetch of each file`);
    shared.setup.add(setup);
    shared.clone.add(clone);
    shared.files.add(files);

    // Stalls are cut off and retried; the clone carries no file contents; every file has its own loop.
    assert.match(setup, /http\.lowSpeedLimit=\d+ .*http\.lowSpeedTime=\d+/, `${file}: a stalled connection must be cut off and retried`);
    assert.ok(clone.includes('--filter=blob:none') && clone.includes('--no-checkout') && clone.includes(githubUrl), `${file}: the clone must be the small, blob-less one`);
    assert.match(files, /^cd src && for f in [^;]+; do for i in 1 2 3 4 5 6 7 8; do \$G checkout HEAD -- releases\/\$f && break;/, `${file}: every file needs its own retry loop`);

    // It fetches the checksum file and exactly the archives that the unpack step extracts.
    const fetched = files.match(/for f in ([^;]+); do/)[1].trim().split(/\s+/);
    const unpacked = [...text.matchAll(/^tar xzf (\S+)/gm)].map((m) => m[1]);
    assert.ok(unpacked.length >= 2, `${file}: expected the unpack step to extract the node and the interface`);
    assert.deepEqual([...fetched].sort(), ['SHA256SUMS', ...unpacked].sort(), `${file}: Step 4 must fetch the checksum file and exactly the archives Step 6 unpacks`);
    for (const name of fetched) assert.ok(name === 'SHA256SUMS' || name.includes(`-${version}.`), `${file}: ${name} is not for ${version}`);
    const sums = exists('releases/SHA256SUMS') ? read('releases/SHA256SUMS') : '';
    if (sums.includes(`-${version}.`)) {
      for (const name of fetched.filter((n) => n !== 'SHA256SUMS')) assert.ok(sums.includes(name), `${file}: ${name} is not listed in releases/SHA256SUMS`);
    }

    // The browser route (a browser resumes a download that was cut) names only files that exist, on
    // the delivered branch, and the guide that carries it shows how to move them into place.
    const branch = clone.match(/--branch (\S+)/)[1];
    for (const m of text.matchAll(/github\.com\/EmoluxLabs\/Obsidian-Network\/raw\/(\S+?)\/releases\/([^\s>)]+)/g)) {
      assert.equal(m[1], branch, `${file}: a browser link names ${m[1]}, not the delivered branch ${branch}`);
      assert.ok(fetched.includes(m[2]), `${file}: a browser link names ${m[2]}, which Step 4 does not fetch`);
    }
    if (file === 'docs/LAUNCH-GUIDE.md') {
      for (const name of unpacked) assert.ok(text.includes(`/raw/${branch}/releases/${name}`), `${file}: the browser route must link ${name}`);
      assert.match(text, /^termux-setup-storage$/m, `${file}: the browser route must show how to reach the Downloads folder`);
      assert.match(text, /^cp ~\/storage\/downloads\/\S+ ~\/storage\/downloads\/\S+ ~\/obsidian\/src\/releases\/$/m, `${file}: the browser route must copy the archives into ~/obsidian/src/releases`);
    }

    // Only some of the archives are on the device, so the check must skip the others rather than
    // report every one of them as a failure.
    assert.ok(blocks.some((b) => /^sha256sum -c --ignore-missing SHA256SUMS$/m.test(b)), `${file}: Step 5 must use --ignore-missing`);
    assert.ok(!blocks.some((b) => /^sha256sum -c SHA256SUMS$/m.test(b)), `${file}: a plain "sha256sum -c SHA256SUMS" would fail on the archives Step 4 does not fetch`);

    // Run what the guide says against a local stand-in for GitHub, in an empty home directory, with a
    // `git` that behaves like the connection that failed for a real user: "Connection reset by peer"
    // on the first two clones and on the first two fetches of the big archive.
    const script = blocks
      .filter((b) => /^G="git /m.test(b) || /^sha256sum -c --ignore-missing SHA256SUMS$/m.test(b))
      .join('\n');
    const work = mkdtempSync(join(tmpdir(), 'obsidian-step4-'));
    try {
      const origin = join(work, 'origin');
      const home = join(work, 'home');
      const bin = join(work, 'bin');
      const state = join(work, 'state');
      for (const dir of [join(origin, 'releases'), home, bin, state]) mkdirSync(dir, { recursive: true });
      const sumLines = [];
      for (const name of ['obsidian-node-operator', 'obsidian-interface-selfhost', 'obsidian-core', 'obsidian-cloudflare', 'obsidian-network-source']) {
        const archive = `${name}-${version}.tar.gz`;
        const body = Buffer.from(`stand-in for ${archive}\n`.repeat(2000));
        writeFileSync(join(origin, 'releases', archive), body);
        sumLines.push(`${createHash('sha256').update(body).digest('hex')}  ${archive}`);
      }
      writeFileSync(join(origin, 'releases', 'SHA256SUMS'), `${sumLines.join('\n')}\n`);
      writeFileSync(join(origin, 'README.md'), 'the rest of the project\n');
      const env = { PATH: process.env.PATH, HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
      const git = (...args) => {
        const r = spawnSync('git', args, { cwd: origin, encoding: 'utf8', env });
        assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      };
      git('init', '-q');
      git('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
      git('config', 'uploadpack.allowFilter', 'true');
      git('config', 'uploadpack.allowAnySHA1InWant', 'true');
      git('add', '-A');
      git('commit', '-q', '-m', 'stand-in release');

      const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(bin, 'git'), [
        '#!/bin/sh',
        '# A connection that keeps being reset: the first two clones, and the first two fetches of the',
        '# interface archive, fail the way the real thing fails. Everything else goes through.',
        'sub=; target=',
        'for a in "$@"; do',
        '  case "$a" in',
        '    clone) sub=clone ;;',
        '    checkout) sub=checkout ;;',
        '    releases/*) target=$a ;;',
        '  esac',
        'done',
        'key=',
        'case "$sub:$target" in',
        '  clone:*) key=clone ;;',
        '  checkout:*interface-selfhost*) key=interface ;;',
        '  checkout:*) key=other ;;',
        'esac',
        'if [ -n "$key" ]; then',
        '  n=$(cat "$SHIM_STATE/$key" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$SHIM_STATE/$key"',
        '  if [ "$key" != other ] && [ "$n" -le 2 ]; then',
        '    echo "error: RPC failed; curl 56 Recv failure: Connection reset by peer" >&2',
        '    echo "fatal: early EOF" >&2',
        '    exit 128',
        '  fi',
        'fi',
        'exec "$REAL_GIT" "$@"',
        '',
      ].join('\n'), { mode: 0o755 });
      writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const runEnv = { ...env, PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit, SHIM_STATE: state };
      const run = spawnSync('bash', ['-c', script.replaceAll(githubUrl, `file://${origin}`)], { env: runEnv, encoding: 'utf8', timeout: 90_000 });
      const said = `${run.stdout}\n${run.stderr}`;
      assert.equal(run.status, 0, `${file}: Step 4 and Step 5 as written failed:\n${said}`);
      const count = (key) => Number(readFileSync(join(state, key), 'utf8'));
      assert.equal(count('clone'), 3, `${file}: the clone must be retried until it works (two resets, then success)`);
      assert.equal(count('interface'), 3, `${file}: the big archive must be retried until it works (two resets, then success)`);
      assert.equal(count('other'), 2, `${file}: a file that already arrived must not be fetched again because another one failed`);
      assert.match(said, /attempt 2 did not finish/, `${file}: a failed attempt must say that it is trying again`);
      assert.deepEqual(readdirSync(join(home, 'obsidian', 'src', 'releases')).sort(), [`obsidian-interface-selfhost-${version}.tar.gz`, `obsidian-node-operator-${version}.tar.gz`, 'SHA256SUMS'].sort(), `${file}: Step 4 must leave exactly three files`);
      assert.ok(!existsSync(join(home, 'obsidian', 'src', 'README.md')), `${file}: Step 4 must not download the rest of the project`);
      const escaped = version.replaceAll('.', '\\.');
      assert.match(run.stdout, new RegExp(`obsidian-node-operator-${escaped}\\.tar\\.gz: OK`), `${file}: the node archive must verify`);
      assert.match(run.stdout, new RegExp(`obsidian-interface-selfhost-${escaped}\\.tar\\.gz: OK`), `${file}: the interface archive must verify`);
      assert.ok(!/FAILED|No such file/.test(run.stdout), `${file}: Step 5 reported a failure:\n${run.stdout}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  for (const [name, values] of Object.entries(shared)) assert.equal(values.size, 1, `the two phone guides must carry the same ${name} command`);
});

test('the guides carry no hard-coded test counts, which go stale the moment a test is added', () => {
  const found = [];
  // The qualifier allowance matters: a count written as "N automated tests" or
  // "N protocol invariants" is still a count, and two of them sat in a guide
  // precisely because the number and the noun were not adjacent.
  const counted = /\b\d{2,4}\s+(?:\w[\w-]*\s+){0,3}(?:tests?|test cases?|test files?|assertions?)\b|\b\d{2,4}\s+invariants?\b|#\s*\d{2,4}\s+tests?\b/i;
  for (const file of currentDocs()) {
    for (const hit of grepLines(read(file), counted)) found.push(`${file}:${hit.line}: ${hit.text.slice(0, 110)}`);
  }
  assert.deepEqual(found, [], `numbers of tests belong in the CHANGELOG's dated record, not in guides:\n${found.join('\n')}`);
});

// ── the networks the code defines, against the guides ───────────────────────

async function definedNetworks() {
  const { getNetwork } = await import(pathToFileURL(join(CORE, 'dist', 'protocol', 'networks.js')).href);
  const interfacePorts = { mainnet: 8788, testnet: 18788, staging: 28788, devnet: 38788 };
  const ifaceBuilt = join(IFACE, 'dist', 'server', 'networks.js');
  if (existsSync(ifaceBuilt)) {
    const mod = await import(pathToFileURL(ifaceBuilt).href);
    for (const name of NETWORKS) interfacePorts[name] = mod.interfaceNetwork(name).interfacePort;
  }
  return Object.fromEntries(
    NETWORKS.map((name) => {
      const net = getNetwork(name);
      return [name, { chainId: net.chainId, hrp: net.addressHrp, rpc: net.defaultRpcPort, p2p: net.defaultP2pPort, ui: interfacePorts[name] }];
    }),
  );
}

test('the port, chain id and prefix tables in the guides are the ones the code defines', { skip: skipUnbuilt }, async () => {
  const defined = await definedNetworks();
  const port = (n) => new RegExp(`(?<![0-9])${n}(?![0-9])`);
  let rows = 0;
  for (const file of ['docs/LAUNCH-GUIDE.md', 'README.md', 'docs/node-operator.md']) {
    for (const name of NETWORKS) {
      for (const hit of grepLines(read(file), new RegExp(`^\\|\\s*${name}\\s*\\|.*\\d{4}`))) {
        const d = defined[name];
        // A row that lists node ports (a port table) must list THIS network's; a row that only
        // names the interface port (the interface table) is checked by the isolation rule below.
        const numbers = (hit.text.match(/(?<![0-9])\d{4,5}(?![0-9])/g) ?? []).filter((n) => !['7777', '7778', '7779', '7780'].includes(n));
        if (new Set(numbers).size >= 2) {
          assert.ok(port(d.rpc).test(hit.text) && port(d.p2p).test(hit.text), `${file}:${hit.line}: the ${name} row must list its own ports ${d.rpc}/${d.p2p}: ${hit.text}`);
        }
        for (const other of NETWORKS.filter((n) => n !== name)) {
          for (const foreign of [defined[other].rpc, defined[other].p2p, defined[other].ui]) {
            assert.ok(!port(foreign).test(hit.text), `${file}:${hit.line}: the ${name} row lists ${other}'s port ${foreign}: ${hit.text}`);
          }
        }
        rows += 1;
      }
    }
  }
  assert.ok(rows >= 10, `expected to find the port tables, found ${rows} rows`);

  // The launch guide's table, cell by cell.
  const guide = read('docs/LAUNCH-GUIDE.md');
  for (const name of NETWORKS) {
    const d = defined[name];
    const row = grepLines(guide, new RegExp(`^\\|\\s*${name}\\s*\\|\\s*\\d{4}`))[0];
    assert.ok(row, `the launch guide's table has no ${name} row`);
    const cells = row.text.split('|').map((cell) => cell.trim().replace(/`/g, '')).filter(Boolean);
    assert.deepEqual(cells, [name, String(d.chainId), `${d.hrp}1`, String(d.rpc), String(d.p2p), String(d.ui)], `${name} row of the launch guide's table`);
  }
});

test('the identity values in the docs are the ones `genesis init` prints', { skip: skipUnbuilt }, () => {
  const good = new Map();
  for (const name of NETWORKS) {
    const out = spawnSync(process.execPath, [join(CORE, 'dist', 'index.js'), 'genesis', 'init', '--network', name], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const g = JSON.parse(out.stdout);
    for (const [label, value] of [['genesisId', g.genesisId], ['genesisHash', g.genesisHash], ['stateRoot', g.stateRoot], ['paramsHash', g.paramsHash]]) {
      good.set(value, `${name} ${label}`);
    }
  }
  const stale = [];
  const files = [
    // Operator documentation may contain only live network identities.
    ...currentDocs(),
    '.env.example',
    ...walk(join(ROOT, 'obsidian-core', 'deployment'), () => true).map((p) => relative(ROOT, p)),
    ...walk(join(ROOT, 'obsidian-interface', 'deployment'), () => true).map((p) => relative(ROOT, p)),
  ];
  for (const file of files) {
    lines(read(file)).forEach((line, index) => {
      // The published devnet Genesis Invitation hash is `scrypt$N$r$p$<salt>$<hash>`: not an identity value.
      const without = line.replace(/scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+/g, '');
      for (const m of without.matchAll(/(?<![0-9a-fA-F])([0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})(?![0-9a-fA-F])/g)) {
        if (!good.has(m[1])) stale.push(`${file}:${index + 1}: ${m[1].slice(0, 16)}…`);
      }
    });
  }
  assert.deepEqual(stale, [], `identity-shaped values that no network derives:\n${stale.join('\n')}`);
  // and the guides do carry the real ones
  const guide = read('docs/LAUNCH-GUIDE.md');
  for (const [value, label] of good) {
    if (label.endsWith('genesisId')) assert.ok(guide.includes(value), `the launch guide does not state the ${label} ${value}`);
  }
  const mainnetLaunch = read('docs/mainnet-launch.md');
  for (const [value, label] of good) {
    if (label.startsWith('mainnet') && /genesisId|genesisHash/.test(label)) assert.ok(mainnetLaunch.includes(value), `mainnet-launch.md does not state the ${label}`);
  }
});

// ── the four networks never mixed ───────────────────────────────────────────

const GUIDE_SECTIONS = {
  'docs/LAUNCH-GUIDE.md': { mainnet: /^## 5\. Mainnet/, testnet: /^## 3\. Testnet/, staging: /^## 4\. Staging/, devnet: /^## 2\. Devnet/ },
  'docs/TERMUX-QUICKSTART.md': { devnet: /^## 3\. Devnet/, testnet: /^## 4\. Testnet/, staging: /^## 5\. Staging/, mainnet: /^## 6\. Mainnet/ },
  'docs/ORACLE-VPS-DEPLOYMENT.md': { devnet: /^### 7\.1 Devnet/, testnet: /^### 7\.2 Testnet/, staging: /^### 7\.3 Staging/, mainnet: /^### 7\.4 Mainnet/ },
};

test('each network\'s section of a guide names only that network: no other port, chain id, prefix, flag or service', { skip: skipUnbuilt }, async () => {
  const defined = await definedNetworks();
  for (const [file, headings] of Object.entries(GUIDE_SECTIONS)) {
    const text = read(file);
    for (const name of NETWORKS) {
      const body = section(text, headings[name]);
      assert.ok(body.length > 800, `${file}: the ${name} section is suspiciously short`);
      for (const other of NETWORKS.filter((n) => n !== name)) {
        const o = defined[other];
        const forbidden = [
          [new RegExp(`(?<![0-9])(?:${o.rpc}|${o.p2p}|${o.ui})(?![0-9])`), `${other}'s port`],
          [new RegExp(`(?<![0-9])${o.chainId}(?![0-9])`), `${other}'s chain id`],
          [new RegExp(`\\b${o.hrp}1`), `${other}'s address prefix`],
          [new RegExp(`--network\\s+${other}\\b`), `--network ${other}`],
          [new RegExp(`obsidian-network\\.sh\\s+${other}\\b`), `obsidian-network.sh ${other}`],
          [new RegExp(`@${other}\\b`), `a ${other} service instance`],
          [new RegExp(`/(?:etc|var/lib)/obsidian/${other}\\b`), `${other}'s folders`],
          [new RegExp(`obsidian-data/${other}\\b`), `${other}'s data folder`],
          [new RegExp(`obsidian-${other}-1`), `${other}'s network id`],
        ];
        for (const [regex, what] of forbidden) {
          const hit = grepLines(body, regex)[0];
          assert.ok(!hit, `${file}, the ${name} section mentions ${what}: ${hit?.text}`);
        }
      }
      // and it does name its own
      const d = defined[name];
      assert.ok(body.includes(String(d.rpc)) && body.includes(String(d.p2p)) && body.includes(String(d.ui)), `${file}: the ${name} section must state its own three ports`);
    }
  }
});

test('the helper commands the guides show exist, for networks that exist', () => {
  const bad = [];
  for (const file of currentDocs()) {
    lines(read(file)).forEach((line, index) => {
      for (const m of line.matchAll(/(?:bash |\.\/)obsidian-network\.sh\s+([a-z<>]+)\s+([a-z-]+)/g)) {
        const [, net, command] = m;
        const okNet = NETWORKS.includes(net) || net === '<network>';
        if (!okNet || !HELPER_COMMANDS.includes(command)) bad.push(`${file}:${index + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, []);
  // and the script really implements each command it advertises
  const script = read('scripts/obsidian-network.sh');
  for (const command of HELPER_COMMANDS.filter((c) => c !== 'help')) {
    assert.match(script, new RegExp(`^\\s*${command}\\)`, 'm'), `the helper script has no "${command}" command`);
  }
});

// ── environment variables ───────────────────────────────────────────────────

function envNamesRead() {
  const names = new Set();
  const sources = [
    ...walk(join(CORE, 'src'), (p) => p.endsWith('.ts')),
    ...walk(join(IFACE, 'server'), (p) => p.endsWith('.ts')),
    ...walk(join(ROOT, 'scripts'), (p) => /\.(sh|mjs)$/.test(p)),
    ...walk(join(ROOT, 'cloudflare', 'src'), (p) => p.endsWith('.js')),
    join(CORE, 'deployment', 'docker', 'entrypoint.sh'),
  ];
  for (const file of sources) for (const m of readFileSync(file, 'utf8').matchAll(/OBSIDIAN_[A-Z0-9_]+/g)) names.add(m[0]);
  return names;
}

test('every environment variable an example, a compose file or a unit sets is one the code reads', () => {
  const read_ = envNamesRead();
  const unknown = [];
  // Docker Compose interpolation variables that choose which host address a port is published on.
  // They are read by `docker compose`, not by the node or the interface.
  const composeOnly = /^OBSIDIAN_(?:RPC|P2P|INTERFACE)_BIND$/;
  const files = [
    '.env.example',
    'obsidian-core/deployment/node.env.example',
    'obsidian-interface/deployment/interface.env.example',
    'obsidian-core/deployment/docker/docker-compose.yml',
    'obsidian-interface/deployment/docker/docker-compose.yml',
    ...walk(join(CORE, 'deployment', 'systemd'), () => true).map((p) => relative(ROOT, p)),
    ...walk(join(IFACE, 'deployment', 'systemd'), () => true).map((p) => relative(ROOT, p)),
  ].filter(exists);
  for (const file of files) {
    lines(read(file)).forEach((line, index) => {
      for (const m of line.matchAll(/OBSIDIAN_[A-Z0-9_]+/g)) {
        if (file.endsWith('docker-compose.yml') && composeOnly.test(m[0])) continue;
        if (!read_.has(m[0])) unknown.push(`${file}:${index + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(unknown, [], `settings that nothing reads (they would silently do nothing):\n${unknown.join('\n')}`);
});

test('the guides mention only environment variables that exist', () => {
  const read_ = envNamesRead();
  const unknown = [];
  for (const file of currentDocs()) {
    lines(read(file)).forEach((line, index) => {
      for (const m of line.matchAll(/OBSIDIAN_[A-Z0-9_]+/g)) {
        if (/^OBSIDIAN_[A-Z0-9_]+_$/.test(m[0])) continue; // a prefix, as in "the OBSIDIAN_* variables"
        if (/_V\d+$/.test(m[0])) continue; // a hash domain-separation tag (OBSIDIAN_CAPSULE_V1), not a setting
        if (!read_.has(m[0])) unknown.push(`${file}:${index + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(unknown, [], `variables named in a guide that no code reads:\n${unknown.join('\n')}`);
});

test('no example selects mainnet, the unit-oriented examples select no network, and no active line has a trailing comment', () => {
  const examples = ['.env.example', 'obsidian-core/deployment/node.env.example', 'obsidian-interface/deployment/interface.env.example'].filter(exists);
  for (const file of examples) {
    lines(read(file)).forEach((line, index) => {
      if (/^\s*#/.test(line) || !/^[A-Z_]+=/.test(line)) return;
      assert.ok(!/^OBSIDIAN_(?:INTERFACE_)?NETWORK=mainnet\b/.test(line), `${file}:${index + 1} makes mainnet the default of anyone who copies it: ${line}`);
      // an environment file has no trailing comments: text after a value becomes part of the value
      assert.ok(!/\s#/.test(line), `${file}:${index + 1} has a trailing comment, which systemd and docker read as part of the value: ${line}`);
    });
  }
  // The template units take the network from the instance name; a network in the file would be a second opinion.
  for (const file of ['obsidian-core/deployment/node.env.example', 'obsidian-interface/deployment/interface.env.example']) {
    const active = lines(read(file)).filter((line) => /^OBSIDIAN_(?:INTERFACE_)?NETWORK=/.test(line));
    assert.deepEqual(active, [], `${file} activates a network, which conflicts with the instance name of the template units`);
  }
});

// ── deployment files ────────────────────────────────────────────────────────

test('systemd units: the right directories, the right entry points, the network from the instance name', () => {
  const units = [
    ['obsidian-core/deployment/systemd/obsidian-node@.service', '/opt/obsidian/obsidian-core', 'dist/index.js', 'obsidian-core/src/index.ts', true],
    ['obsidian-core/deployment/systemd/obsidian-node.service', '/opt/obsidian/obsidian-core', 'dist/index.js', 'obsidian-core/src/index.ts', false],
    ['obsidian-interface/deployment/systemd/obsidian-interface@.service', '/opt/obsidian/obsidian-interface', 'dist/server/main.js', 'obsidian-interface/server/main.ts', true],
    ['obsidian-interface/deployment/systemd/obsidian-interface.service', '/opt/obsidian/obsidian-interface', 'dist/server/main.js', 'obsidian-interface/server/main.ts', false],
  ];
  for (const [file, workdir, entry, source, template] of units) {
    const text = read(file);
    assert.match(text, new RegExp(`^WorkingDirectory=${workdir}$`, 'm'), `${file}: WorkingDirectory must be where the archive extracts (${workdir})`);
    assert.match(text, new RegExp(`^ExecStart=/usr/bin/node ${entry.replace('.', '\\.')}`, 'm'), `${file}: ExecStart`);
    assert.ok(exists(source), `${file}: ${entry} is built from ${source}, which does not exist`);
    assert.ok(!/^MemoryDenyWriteExecute\s*=\s*(?:true|yes)/m.test(text), `${file}: MemoryDenyWriteExecute stops V8's JIT; node cannot start under it`);
    assert.match(text, /^NoNewPrivileges=true$/m, `${file}: NoNewPrivileges`);
    assert.match(text, /^User=obsidian$/m, `${file}: runs as the unprivileged account`);
    if (template) {
      assert.match(text, /--network %i\b/, `${file}: the network must come from the instance name`);
      assert.match(text, /--data-dir \/var\/lib\/obsidian\/%i\//, `${file}: the data directory must be per network`);
      assert.match(text, /^EnvironmentFile=\/etc\/obsidian\/%i\//m, `${file}: the settings file must be per network`);
      assert.match(text, /^ConditionPathExists=\/etc\/obsidian\/%i\//m, `${file}: an unconfigured instance must not start`);
      assert.match(text, /^StateDirectory=obsidian\/%i$/m, `${file}: StateDirectory must be per network`);
    }
  }
});

test('the nginx files use nothing newer than the nginx that Ubuntu ships', () => {
  for (const file of ['obsidian-interface/deployment/nginx/obsidian-interface.conf', 'obsidian-core/deployment/nginx/obsidian-node.conf']) {
    const active = lines(read(file)).filter((line) => !/^\s*#/.test(line)).join('\n');
    // `http2 on;` arrived in nginx 1.25.1; Ubuntu 22.04 ships 1.18 and 24.04 ships 1.24, where it is a startup error.
    assert.ok(!/^\s*http2\s+on\s*;/m.test(active), `${file}: "http2 on;" is a startup error on nginx before 1.25.1; use "listen 443 ssl http2;"`);
    assert.ok(!/\b(?:http3|quic)\b/.test(active), `${file}: HTTP/3 directives are not available on Ubuntu's nginx`);
  }
  assert.match(read('obsidian-interface/deployment/nginx/obsidian-interface.conf'), /listen 443 ssl http2;/);
});

test('the nginx pipeline in the Oracle guide produces a correct, distinct site for every network', { skip: skipUnbuilt }, async () => {
  const defined = await definedNetworks();
  const guide = read('docs/ORACLE-VPS-DEPLOYMENT.md');
  const work = mkdtempSync(join(tmpdir(), 'obsidian-nginx-'));
  const upstreams = new Set();
  for (const name of NETWORKS) {
    const body = section(guide, GUIDE_SECTIONS['docs/ORACLE-VPS-DEPLOYMENT.md'][name]);
    const m = body.match(new RegExp(`(sudo sed -e [\\s\\S]*?\\| sudo tee /etc/nginx/sites-available/obsidian-${name} >/dev/null)`));
    assert.ok(m, `the ${name} section has no sed pipeline`);
    const out = join(work, `${name}.conf`);
    const command = m[1]
      .replace('sudo sed', 'sed')
      .replace(`| sudo tee /etc/nginx/sites-available/obsidian-${name} >/dev/null`, `> ${out}`)
      .replace('/opt/obsidian/obsidian-interface/deployment/nginx/obsidian-interface.conf', join(IFACE, 'deployment', 'nginx', 'obsidian-interface.conf'));
    const run = spawnSync('bash', ['-c', `DOMAIN=${name}.example.com; ${command}`], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const site = readFileSync(out, 'utf8');
    assert.ok(site.includes(`server 127.0.0.1:${defined[name].ui};`), `${name}: the upstream is not on the interface port ${defined[name].ui}`);
    assert.ok(site.includes(`server_name ${name}.example.com;`) && !site.includes('obsidian.example'), `${name}: the hostname was not substituted`);
    assert.ok(site.includes(`proxy_pass http://obsidian_interface_${name};`), `${name}: the upstream was not renamed`);
    upstreams.add(`obsidian_interface_${name}`);
  }
  assert.equal(upstreams.size, 4, 'four sites need four distinct upstream names, or nginx refuses to load them together');
});

test('the npm scripts name a network, and each one uses its own network\'s config', () => {
  const scripts = json('obsidian-core/package.json').scripts;
  assert.ok(!/mainnet/.test(scripts.start), `npm start must not mean mainnet: ${scripts.start}`);
  for (const name of NETWORKS) {
    assert.equal(scripts[`start:${name}`], `node dist/index.js start --config config/${name}.json`, `start:${name}`);
    assert.equal(json(`obsidian-core/config/${name}.json`).network, name, `config/${name}.json names a different network`);
  }
});

// ── the docs ────────────────────────────────────────────────────────────────

test('every document is in the index, and every link and repository path in the guides resolves', () => {
  const index = read('docs/README.md');
  const missing = readdirSync(join(ROOT, 'docs')).filter((name) => name.endsWith('.md') && name !== 'README.md' && !index.includes(`(${name})`));
  assert.deepEqual(missing, [], `documents missing from docs/README.md: ${missing.join(', ')}`);

  const broken = [];
  for (const file of currentDocs()) {
    const base = dirname(join(ROOT, file));
    lines(read(file)).forEach((line, number) => {
      for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1].split('#')[0];
        if (!target || /^(?:[a-z]+:|\/\/)/i.test(target)) continue;
        if (!existsSync(resolve(base, target))) broken.push(`${file}:${number + 1}: link to ${m[1]}`);
      }
      // `scripts/foo.sh`, `docs/bar.md`, `obsidian-core/src/x.ts` ... named as code
      for (const m of line.matchAll(/`((?:scripts|docs|tests|cloudflare|obsidian-core|obsidian-interface|\.github)\/[A-Za-z0-9_.@\/-]+)`/g)) {
        const target = m[1].replace(/[.,;:]+$/, '');
        if (/[*<>$]/.test(target)) continue;
        // Guides often write tests/… or scripts/… relative to the package they belong to.
        const roots = ['', 'obsidian-core/', 'obsidian-interface/', 'cloudflare/'];
        if (!roots.some((prefix) => exists(prefix + target))) broken.push(`${file}:${number + 1}: path ${target}`);
      }
    });
  }
  assert.deepEqual(broken, [], `links and paths that point at nothing:\n${broken.join('\n')}`);
});

test('the Genesis Invitation in the guides is a hash, never a code, and both guides carry the same hash', () => {
  const hashes = new Map();
  const codePattern = /OBS-GENESIS-([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})/g;
  const files = [
    ...currentDocs(),
    ...walk(join(ROOT, 'scripts'), () => true).map((p) => relative(ROOT, p)),
    ...walk(join(ROOT, '.github'), () => true).map((p) => relative(ROOT, p)),
    ...walk(join(CORE, 'deployment'), () => true).map((p) => relative(ROOT, p)),
    ...walk(join(IFACE, 'deployment'), () => true).map((p) => relative(ROOT, p)),
  ];
  const leaked = [];
  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(codePattern)) {
      // placeholders and the deliberately wrong code used to show a refusal
      if (/^(?:XXXX|AAAA)$/.test(m[1]) && m[1] === m[2] && m[2] === m[3] && m[3] === m[4]) continue;
      leaked.push(`${file}: ${m[0]}`);
    }
    for (const m of text.matchAll(/scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)/g)) hashes.set(`${file}`, m[0]);
  }
  assert.deepEqual(leaked, [], `a real-looking Genesis Invitation CODE is in the repository (only its hash may be):\n${leaked.join('\n')}`);
  for (const [file, hash] of hashes) {
    assert.match(hash, /^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/, `${file}: malformed invitation hash`);
  }
  const distinct = new Set(hashes.values());
  assert.equal(distinct.size, 1, `the guides disagree about the shipped devnet invitation hash: ${[...hashes].map(([f]) => f).join(', ')}`);
});

test('trusted origins: one matcher in two packages, and the docs name the hostnames the code registers', () => {
  // The node and the interface each ship their own copy, so a fix to one that is not copied to the other
  // would leave two components disagreeing about who may call them.
  const core = read('obsidian-core/src/config/trusted-origins.ts');
  const iface = read('obsidian-interface/server/trusted-origins.ts');
  assert.equal(iface, core, 'obsidian-interface/server/trusted-origins.ts must be an exact copy of obsidian-core/src/config/trusted-origins.ts');

  const domain = core.match(/OFFICIAL_DOMAIN = '([^']+)'/)[1];
  const doc = read('docs/trusted-domains.md');
  for (const host of [domain, `api.${domain}`, `devnet.${domain}`, `testnet.${domain}`, `staging.${domain}`]) {
    assert.ok(doc.includes(`\`${host}\``), `docs/trusted-domains.md must name ${host}`);
  }
  // Every environment variable the guide tells an operator to set is one the code reads.
  for (const variable of ['OBSIDIAN_RPC_TRUST_OFFICIAL_DOMAINS', 'OBSIDIAN_INTERFACE_TRUST_OFFICIAL_DOMAINS', 'OBSIDIAN_RPC_CORS_ORIGINS', 'OBSIDIAN_INTERFACE_ALLOWED_ORIGINS']) {
    assert.ok(doc.includes(variable), `docs/trusted-domains.md must mention ${variable}`);
    const read_by = [read('obsidian-core/src/config/config.ts'), read('obsidian-interface/server/config.ts')].some((source) => source.includes(variable));
    assert.ok(read_by, `${variable} is documented but nothing reads it`);
  }
  // The only wildcard the code trusts by default is the official domain, over https.
  assert.match(core, /OFFICIAL_ORIGIN_PATTERNS[^=]*= \[`https:\/\/\$\{OFFICIAL_DOMAIN\}`, `https:\/\/\*\.\$\{OFFICIAL_DOMAIN\}`\]/);
});

test('the current docs describe only products that still exist', () => {
  // A discontinued product must not keep a guide: a document that describes a
  // feature the chain no longer has is worse than no document, because it is
  // believed. The removal report describes what is gone and must stay accurate
  // about it.
  for (const retired of ['docs/capsules.md', 'docs/circle.md', 'docs/social.md']) {
    assert.ok(!exists(join(ROOT, retired)), `${retired} describes a discontinued product`);
  }
  for (const file of currentDocs()) {
    assert.ok(!/docs\/(capsules|circle|social)\.md/.test(read(file)), `${file} links to a discontinued product's guide`);
  }
  assert.ok(!/docs\/(capsules|circle|social)\.md/.test(read('docs/removal-report.md')), 'the removal report links to a discontinued guide');
});

test('an alert-rule count beside the alerts file is the count the file carries', () => {
  // "six rules: chain stalled, …" sat in the monitoring table while the file
  // carried eight — the two alerts added since were invisible in the doc, and a
  // reader checking the list against the file would find it short. Any line that
  // names the file and quotes a count must quote the file's count.
  const rules = [...read('obsidian-core/deployment/monitoring/obsidian-alerts.yml').matchAll(/^\s*- alert:/gm)].length;
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const stale = [];
  for (const file of [...currentDocs(), 'obsidian-core/deployment/monitoring/README.md']) {
    if (!exists(file)) continue;
    lines(read(file)).forEach((line, index) => {
      if (!line.includes('obsidian-alerts.yml')) return;
      for (const match of line.matchAll(/(?<![-\w])(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:alert\s+)?rules?\b/g)) {
        const value = words[match[1]] ?? Number(match[1]);
        if (value !== rules) stale.push(`${file}:${index + 1}: ${match[0]} (the alerts file carries ${rules})`);
      }
    });
  }
  assert.deepEqual(stale, [], `a doc quotes an alert-rule count the file does not carry:\n${stale.join('\n')}`);
});

test('the removal report names every compliance key the gate checks', () => {
  // The report shows the reader the response they are about to get. A key the CI
  // gate greps for that the report omits makes the report look stale before they
  // have even run the command.
  const list = /const forbidden = \[([\s\S]*?)\];/.exec(read('.github/workflows/ci.yml'));
  assert.ok(list, 'CI carries the removed-feature list');
  const checked = [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(checked.length >= 16, `expected the removed-feature list, found ${checked.length} names`);
  const report = read('docs/removal-report.md');
  const missing = [...checked, 'revenueSplitEnforced'].filter((name) => !report.includes(`"${name}"`));
  assert.deepEqual(missing, [], `the removal report omits keys the node reports:\n${missing.join('\n')}`);
});

test('every RPC route the node serves is in the API reference', () => {
  // docs/api.md is what a client author reads; a route that exists in the router
  // and not in the reference is one nobody outside this repository knows exists.
  // `GET /wallet/<address>/next-nonce` was in exactly that state.
  const PLACEHOLDER = '<…>';
  const source = read('obsidian-core/src/rpc/server.ts');
  const router = source.slice(
    source.indexOf("if (path === '/' || path === '/health')"),
    source.indexOf("code: 'ERR_NOT_FOUND'"),
  );
  assert.ok(router.length > 500, 'the router table must be found in obsidian-core/src/rpc/server.ts');
  const routes = new Set();
  for (const match of router.matchAll(/path === '([^']+)'/g)) routes.add(match[1]);
  for (const match of router.matchAll(/path\.startsWith\('([^']+)'\)(?: && path\.endsWith\('([^']+)'\))?/g)) {
    routes.add(match[2] ? `${match[1]}${PLACEHOLDER}${match[2]}` : match[1]);
  }
  const api = read('docs/api.md');
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = (route) => {
    const body = route.includes(PLACEHOLDER) ? route.split(PLACEHOLDER).map(escape).join('[^`\\s]*') : escape(route);
    return new RegExp("(?:GET|POST) " + body + "(?=[`<]|\\?|$)");
  };
  const missing = [...routes].filter((route) => route !== '/' && !pattern(route).test(api)).sort();
  assert.deepEqual(missing, [], `routes the node serves and docs/api.md never names:\n${missing.join('\n')}`);
});

test('the helper, the packaging gate and CI all run this test', () => {
  assert.match(read('scripts/package-releases.sh'), /repo-consistency\.test\.mjs/, 'package-releases.sh must run the consistency test before it builds anything');
  assert.match(read('.github/workflows/ci.yml'), /repo-consistency\.test\.mjs/, 'CI must run the consistency test');
  assert.match(read('.github/workflows/ci.yml'), /check-nginx-conf\.py/, 'CI must check the nginx files');
});
