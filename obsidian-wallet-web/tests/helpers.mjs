/** Shared by the tests: the real signing code, from the web app's own source (not a copy, not a mock). */
export * as bundle from '../../obsidian-app-web/web/index.mjs';
import * as real from '../../obsidian-app-web/web/index.mjs';

/** A fresh disposable wallet on `hrp`, made by the real generator and the real derivation. */
export function newWallet(hrp = 'dobs') {
  const phrase = real.generatePhrase();
  return { phrase, ...real.walletFromPhrase(phrase, hrp) };
}
