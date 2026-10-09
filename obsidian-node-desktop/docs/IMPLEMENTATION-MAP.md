# Implementation map

Every screen and action of Obsidian Node, the code that serves it, and the part of the
**existing** Obsidian Network implementation it relies on. Nothing here re-implements
consensus, the transaction format, keys, validators or the RPC server: the app runs the real
`@obsidian/core` node (staged into `vendor/obsidian-core`, see `scripts/stage-core.mjs`) and
talks to it over its own HTTP RPC on `127.0.0.1`.

Layers: **renderer** (`src/renderer`, sandboxed, no Node) → **preload** (generated from
`src/shared/contract.ts`, allow-list of 40 channels) → **handlers** (`src/core/handlers.ts`,
validate every payload again) → **services** (`src/core/*-service.ts`) → **core node / core
library**.

## Core pieces reused (never re-implemented)

| Need | Reused from `@obsidian/core` |
| --- | --- |
| Node process, genesis, storage, lock, block production | `dist/index.js start --network … --data-dir … --keystore … ` (run by `node-supervisor.ts` through `main/node-host.ts`; the app never opens the database itself) |
| Network constants (chain id, address prefix, ports) | `protocol/networks.js` → `NETWORKS` |
| Consensus parameters shown in the UI | `protocol/params.js` → `CONSENSUS_PARAMS`, `VALIDATOR`; `blockchain/state-root.js` → `PARAMS_HASH` |
| Recovery phrase, key derivation | `crypto/mnemonic.js` → `generateRecoveryPhrase`, `deriveWallet`, `isValidRecoveryPhrase` |
| Addresses | `crypto/keys.js` → `addressFromPublicKey`, `isValidAddress` |
| Amounts, gas | `protocol/amount.js` → `parseObs`, `formatObs`; `transactions/helpers.js` → `expectedGas` |
| Payment / validator bodies | `transactions/executors/{payment,validator}.js` → `encodePaymentBody`, `encodeValidatorBody` |
| Signing and tx id | `transactions/encode.js` → `signTransaction`, `encodeSignedTx`, `txIdOf` |
| Node identity key (validator account) | `crypto/keystore.js` → `Keystore` (the file the node itself created) |

## RPC routes used (all verified in `obsidian-core/src/rpc/server.ts` and against a running devnet node)

`GET /health /status /finality /params /network /peers /pot /validators /mempool /version`,
`GET /blocks /block/:id /tx/:id /address/:addr /wallet/:addr/next-nonce`,
`POST /wallet/balance /tx/simulate /tx/submit`.
No other route is called. Responses are shape-checked in `core/rpc-client.ts` (`parse*`),
with a timeout, a size limit and a failure class (`unavailable | timeout | http | malformed |
too-large | refused`). The client refuses any host that is not loopback.

## Screens

| Screen (route) | UI file | IPC channels | Service | Node / core |
| --- | --- | --- | --- | --- |
| Overview (`#/overview`) | `screens/overview.ts` | `chain:snapshot`, `node:state`, `node:logs` | `chain-service.ts` | `/health /status /finality /pot /peers /mempool` |
| Node Management (`#/node`) | `screens/node.ts`, `node-actions.ts` | `node:start/stop/restart/state`, `chain:detail` | `node-supervisor.ts` | node process; `/health` readiness (running is reported only after `/health` answers) |
| Network & Peers (`#/network`) | `screens/network.ts` | `chain:detail`, `network:switch` | `chain-service.ts` | `/network /peers /params /version` |
| Validator Centre (`#/validator`) | `screens/validator.ts` | `validator:view/list/prepare`, `tx:execute`, `tx:cancel` | `validator-service.ts`, `tx-service.ts` | `/validators`, `/params`, `/wallet/:addr/next-nonce`, `/tx/simulate` (claim readiness), `/tx/submit`; tx type `VALIDATOR` ops REGISTER, UNREGISTER, CLAIM_UNBONDED |
| Wallet (`#/wallet`) | `screens/wallet.ts` | `wallet:status/begin-create/finish-create/cancel-create/import/balance/history/remove`, `tx:prepare-payment` | `wallet-service.ts`, `vault.ts`, `payment-service.ts` | `/wallet/balance`, `/address/:addr`; keys by core mnemonic functions |
| Transactions (`#/tx`) | `screens/tx.ts` | `tx:submissions/status/resubmit`, `explorer:mempool` | `tx-service.ts` | `/tx/:id`, `/mempool`, `/tx/submit` (idempotent resubmit of identical bytes) |
| Explorer (`#/explorer`) | `screens/explorer.ts` | `explorer:blocks/block/tx/address/mempool/search` | `explorer-service.ts` | `/blocks /block/:id /tx/:id /address/:addr /mempool` |
| Logs & Diagnostics (`#/logs`) | `screens/logs.ts` | `node:logs`, `node:logs-clear`, `diag:run/report/save` | `log-buffer.ts`, `diagnostics-service.ts`, `redact.ts` | node stdout/stderr (JSON lines), `/health /version /params` |
| Settings (`#/settings`) | `screens/settings.ts` | `settings:get`, `settings:node-update`, `settings:ui-update`, `network:switch` | `settings.ts` | start-up flags only (name, block production, log level, port offset, seeds); restart-required fields are flagged |
| Help & Support (`#/help`) | `screens/help.ts` | `app:info`, `app:open-external`, `diag:report`, `diag:save` | `handlers.ts`, `core-loader.ts` | core version, source commit, protocol version, `PARAMS_HASH` |

The template has 17 mock screens; the ones that only existed to show states of these screens
(empty, error, dialogs) are rendered by the same screen code from real states. The template
lacks JAILED and SLASHED validator states, which the protocol has; they were added.

## Actions

| Action | Where | What guarantees it is real |
| --- | --- | --- |
| Start node | `node.start` → `node:start` | refuses a taken port, refuses to talk to a foreign node on the RPC port, refuses to create a new chain unless the user confirms (never auto-initialises genesis) |
| Stop / restart | `node:stop`, `node:restart` | SIGTERM → core's own graceful shutdown → wait for exit → SIGKILL only after a timeout, which is reported; the data-dir `LOCK` must be released |
| Switch network | `network:switch` | confirmation dialog; refused while a node process exists; each network has its own data dir, vault and settings |
| Create / import wallet | `wallet.create`, `wallet.import` | core derivation; vault `obsidian.vault.v1` (PBKDF2-SHA256 600k, AES-GCM) — the same format as the web app, interoperability is tested |
| Send | `wallet.review` → `tx:prepare-payment` → dialog → `tx:execute` | prepare shows amount, fee and total from `expectedGas`; passphrase needed per transaction; node simulation of the exact signed bytes; "submitted" only after `/tx/submit` accepts; "confirmed" only when `/tx/:id` says so |
| Validator register / unbond / claim | `validator.prepare` → dialog → `tx:execute` | amounts and gas from core params; availability from live state; **claim availability is a node dry-run** (`/tx/simulate`), so it is offered only when the node would accept it |
| Copy / save diagnostics | `help.report-copy`, `help.report-save` | report passes through `redact.ts`; save goes through a native save dialog |
| Open external link | `app:open-external` | allow-list: `https://github.com/EmoluxLabs/…` only |

## Not supported (and shown as such)

* A persistent "unlock wallet" session: every signature asks for the passphrase.
* Validator operations beyond REGISTER / UNREGISTER / CLAIM_UNBONDED: the protocol has none.
* Connecting to a remote node: the app only talks to the node it started (loopback).
* Auto-update and code signing: not configured (see README).
