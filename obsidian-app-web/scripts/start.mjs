/**
 * Start the app for ONE network:  node scripts/start.mjs <mainnet|testnet|staging|devnet>
 *
 * This is what `npm run start:mainnet` (and :testnet, :staging, :devnet) runs. It only
 * sets the two things that make a deployment a particular network's and hands over to
 * server/main.mjs, which does the real work and the real refusing:
 *
 *   OBSIDIAN_APP_NETWORK   the network this deployment is
 *   OBSIDIAN_PLATFORM_URL  the platform behind it
 *
 * The platform URL defaults to that network's own platform port on this machine for
 * testnet, staging and devnet. Mainnet has NO default: a production app must be told,
 * on purpose, which platform it fronts. Whatever is chosen, main.mjs checks the
 * platform really is on this network and exits 3 if it is not.
 */

import { NETWORK_NAMES, networkFor } from '../server/networks.mjs';

const PLATFORM_PORT = { mainnet: 8788, testnet: 18788, staging: 28788, devnet: 38788 };

const wanted = process.argv[2];
let network;
try {
  network = networkFor(wanted);
} catch {
  console.error(`usage: node scripts/start.mjs <${NETWORK_NAMES.join('|')}>`);
  process.exit(2);
}

const already = process.env.OBSIDIAN_APP_NETWORK;
if (already && already.toLowerCase() !== network.name) {
  console.error(
    `refusing to start: this is the ${network.name} entry point but OBSIDIAN_APP_NETWORK is ${already}. ` +
      'Unset it, or use the matching start script.',
  );
  process.exit(2);
}
process.env.OBSIDIAN_APP_NETWORK = network.name;

if (!process.env.OBSIDIAN_PLATFORM_URL) {
  if (network.production) {
    console.error(
      'refusing to start mainnet without OBSIDIAN_PLATFORM_URL. A production app is told which platform ' +
        'it fronts; it does not assume one.',
    );
    process.exit(2);
  }
  process.env.OBSIDIAN_PLATFORM_URL = `http://127.0.0.1:${PLATFORM_PORT[network.name]}`;
}

await import('../server/main.mjs');
