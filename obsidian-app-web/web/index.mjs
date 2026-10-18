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
  walletFromPrivateKey,
  checkPrivateKey,
  secretFromPrivateKey,
  privateKeyForPhrase,
  isKeySecret,
  KEY_SECRET_PREFIX,
  generatePhrase,
  retargetAddress,
  sign,
  signLinkChallenge,
  WALLET_LINK_DOMAIN,
  signingDigestFor,
  buildMiningBody,
  buildPaymentBody,
  buildOnsBody,
  buildMarketBody,
  TxType,
  OnsOp,
  MarketOp,
  PROTOCOL_VERSION,
  expectedGas,
} from './signing.mjs';

export {
  submitClaim,
  linkWalletProven,
  submitPayment,
  submitNameRegistration,
  submitNameRenewal,
  submitNameUpdate,
  submitNameTransfer,
  submitNameTransferAccept,
  submitNameTransferCancel,
  submitNameRecoverySet,
  submitNameRecoveryStart,
  submitNameRecoveryCancel,
  submitNameRecoveryFinalize,
  submitMarketList,
  submitMarketUpdate,
  submitMarketDelist,
  submitMarketBuy,
  submitMarketOffer,
  submitMarketAccept,
  submitMarketDecline,
  submitMarketCancel,
  VALIDITY_SECONDS,
} from './ops.mjs';

export { qrModules, qrSvg, decodeQr, readScanned } from './qr.mjs';

// A `.obs` name becomes a validated address before any payment is built — one resolver for every surface.
export {
  recipientKind,
  parseOnsName,
  resolveOnsName,
  reconfirmOnsName,
  failureMessage as onsFailureMessage,
  networkLabel,
} from '../../obsidian-interface/web/core/protocol/recipient.js';

export { parseObs, formatObs } from '../../obsidian-interface/web/core/protocol/amount.js';
export { isValidAddress } from '../../obsidian-interface/web/core/crypto/keys.js';

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
  MIN_PASSPHRASE_LENGTH,
} from './vault.mjs';
