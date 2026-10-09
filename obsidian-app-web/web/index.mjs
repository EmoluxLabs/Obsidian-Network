/**
 * The single browser entry point.
 *
 * One entry, one bundle. Every protocol operation in this app needs the same
 * canonical crypto, and esbuild inlines it per entry point — so splitting these
 * into five bundles would ship the core five times and risk two copies drifting
 * apart inside one page. One bundle means one derivation, one encoder, one
 * signature scheme on the page, which is the whole promise of syncing the core
 * instead of reimplementing it.
 *
 * Nothing here is logic. It is the public surface the app is allowed to import,
 * kept in one place so the boundary between "canonical core" and "this app's
 * sequencing" stays visible.
 */

export {
  isValidPhrase,
  walletFromPhrase,
  retargetAddress,
  sign,
  signingDigestFor,
  buildMiningBody,
  buildPaymentBody,
  buildOnsBody,
  TxType,
  OnsOp,
  PROTOCOL_VERSION,
  expectedGas,
} from './signing.mjs';

export {
  submitClaim,
  submitPayment,
  submitNameRegistration,
  submitNameRenewal,
  submitNameUpdate,
  submitNameTransfer,
  VALIDITY_SECONDS,
} from './ops.mjs';

export { parseObs, formatObs } from '../../obsidian-interface/web/core/protocol/amount.js';

export {
  createVault,
  openVault,
  saveVault,
  loadVault,
  destroyVault,
  saveWalletAddress,
  loadWalletAddress,
  PassphraseError,
  PBKDF2_ITERATIONS,
  KDF,
} from './vault.mjs';
