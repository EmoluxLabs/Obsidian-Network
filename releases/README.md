# Releases

The downloadable artefacts, the digests that prove they are unchanged, and the
manifest that says what they contain. Everything here was produced by
`scripts/package-releases.sh` from the commit named in `MANIFEST.json`.

| Asset | What it is | Who it is for |
| --- | --- | --- |
| `obsidian-core-1.0.0.zip` / `.tar.gz` | the node: source, tests, built `dist/`, `config/`, deployment recipes | anyone who wants to read or build the protocol |
| `obsidian-interface-1.0.0.zip` / `.tar.gz` | the reader: server, tests, browser bundles, every site directory | anyone deploying the apps |
| `obsidian-cloudflare-1.0.0.zip` / `.tar.gz` | the edge worker, tests and Terraform | optional edge caching, never consensus |
| `obsidian-node-operator-1.0.0.zip` / `.tar.gz` | built node + systemd/nginx/Docker recipes + operator docs | running a node in production |
| `obsidian-interface-selfhost-1.0.0.zip` / `.tar.gz` | built interface + all 11 site directories + docs | serving the interface yourself |
| `obsidian-network-source-1.0.0.tar.gz` | the entire repository at that commit (`git archive`) | auditors and forks |
| `SHA256SUMS` | SHA-256 of every archive | verifying the download |
| `MANIFEST.json` | commit, build time, network parameters, asset sizes | cross-checking a build against a chain |
| `RELEASE-NOTES-1.0.0.md` | what is in the release and what is not | reading before deploying |

## Verify before you run anything

```bash
cd releases
sha256sum -c SHA256SUMS                 # every digest must print OK
cat MANIFEST.json                       # commit, networks, supply constants
../scripts/verify-release.sh obsidian-core-1.0.0.tar.gz
```

`verify-release.sh` refuses an archive that is not listed in `SHA256SUMS`,
extracts into a temporary directory (never over your working tree), checks the
entry points, and with `--with-tests` runs the shipped suite.

## Run the node package

```bash
tar -xzf obsidian-node-operator-1.0.0.tar.gz && cd obsidian-core
npm ci --omit=dev
node dist/index.js start --config config/devnet.json --data-dir ./data/devnet
curl -s http://127.0.0.1:38630/health | jq
curl -s http://127.0.0.1:38630/audit/compliance | jq   # removed mechanics absent
```

## Run the self-hosted interface package

```bash
tar -xzf obsidian-interface-selfhost-1.0.0.tar.gz && cd obsidian-interface
node dist/server/main.js --nodes http://127.0.0.1:38630 --port 8788
# → http://127.0.0.1:8788/  (landing, mine, wallet, explorer, …)
```

The interface has **no runtime dependencies** — Node.js built-ins only — so the
self-host package runs straight from the extracted archive. It finds the site
directories in either layout (checkout or self-contained package); if they are
missing it refuses to start rather than serving a blank page.

## Rebuilding a release

```bash
./scripts/package-releases.sh          # build + test + package (needs a clean tree)
./scripts/package-releases.sh --skip-e2e   # everything except the three-node cluster test
```

The script refuses to package a tree with uncommitted changes (so an archive
always corresponds to a commit) and refuses to continue if any suite fails. The
test counts in `RELEASE-NOTES-*.md` are read back from the runs themselves, so
they cannot drift from reality.

Archives are produced from the working tree after a full build, while the
`obsidian-network-source` archive is produced by `git archive` from the same
commit. `MANIFEST.json` records that commit; the artefact commit that follows it
contains exactly these files.
