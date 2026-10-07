/**
 * Which browser origins a node or an interface will answer.
 *
 * THIS FILE EXISTS IN TWO PACKAGES — obsidian-core/src/config/ and obsidian-interface/server/ — and the
 * two copies must be identical: tests/scripts/repo-consistency.test.mjs fails if they differ. Change
 * one and copy it to the other.
 *
 * What "trusted" means here, exactly
 *   A page served from a trusted origin may call this node or interface from a browser. That is all.
 *   It changes nothing about consensus, and it does not let a page act for a user: every transaction
 *   still has to be signed with a key the page does not have, and carries the chain id and address
 *   prefix of the one network it was signed for.
 *
 * The project's own domain
 *   `obsmainnet.us.ci` and every subdomain beneath it (api., devnet., testnet., staging., wallet.,
 *   explorer., …) are trusted by default, over HTTPS only. An operator who does not want that sets
 *   OBSIDIAN_RPC_TRUST_OFFICIAL_DOMAINS=false (node) or
 *   OBSIDIAN_INTERFACE_TRUST_OFFICIAL_DOMAINS=false (interface).
 *
 * Adding more
 *   The operator's own list (OBSIDIAN_RPC_CORS_ORIGINS, OBSIDIAN_INTERFACE_ALLOWED_ORIGINS) takes
 *   exact origins (`https://wallet.example.org`) and whole-subdomain patterns
 *   (`https://*.example.org`, which does NOT include `https://example.org` itself).
 *
 * What a pattern can never do
 *   - match by prefix or by substring: `https://*.example.org` does not match
 *     `https://example.org.evil.test` or `https://evilexample.org`, because a wildcard matches whole
 *     labels, on a dot;
 *   - be written for a public suffix (`*.com`, `*.co.uk`, `*.github.io`, `*.us.ci`): that would trust
 *     strangers, and is refused when the configuration is read;
 *   - be plain HTTP, when it is a wildcard;
 *   - carry a path, a query, a fragment or a user name.
 */

export type NetworkKey = 'mainnet' | 'testnet' | 'staging' | 'devnet';

/** The one registered domain the project's networks are served from. */
export const OFFICIAL_DOMAIN = 'obsmainnet.us.ci';

const MAINNET_SITES = ['mine', 'wallet', 'explorer', 'ons', 'node', 'developer', 'interface'] as const;

/**
 * The hostnames each network is served from. A network lists only its own: a devnet node never vouches
 * for mainnet's names, because those names are what people check a wallet address against.
 */
export const OFFICIAL_HOSTS: Readonly<Record<NetworkKey, readonly string[]>> = {
  mainnet: [OFFICIAL_DOMAIN, `api.${OFFICIAL_DOMAIN}`, ...MAINNET_SITES.map((site) => `${site}.${OFFICIAL_DOMAIN}`)],
  testnet: [`testnet.${OFFICIAL_DOMAIN}`],
  staging: [`staging.${OFFICIAL_DOMAIN}`],
  devnet: [`devnet.${OFFICIAL_DOMAIN}`],
};

/** Origins trusted by default: the official domain, and everything beneath it. */
export const OFFICIAL_ORIGIN_PATTERNS: readonly string[] = [`https://${OFFICIAL_DOMAIN}`, `https://*.${OFFICIAL_DOMAIN}`];

export interface OriginPattern {
  scheme: 'http' | 'https';
  /** Lowercase. For a wildcard, the base the subdomains sit under, without the `*.`. */
  host: string;
  /** Always concrete: 443 for https and 80 for http when none was written. */
  port: number;
  wildcard: boolean;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Domains under which strangers can register their own names. A wildcard written for one of these
 * would trust every one of them, so it is refused. This is a safety net, not the public suffix list:
 * it covers the shared hosts people actually reach for.
 */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  'us.ci', 'us.kg', 'eu.org', 'co.uk', 'org.uk', 'com.au', 'com.ng', 'co.za', 'co.in', 'co.jp', 'com.br',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com',
  'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'blogspot.com',
  'duckdns.org', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'onrender.com', 'fly.dev',
  'surge.sh', 'glitch.me', 'repl.co', 'nip.io', 'sslip.io', 'localhost.run', 'loca.lt',
]);

interface ParsedOrigin {
  scheme: 'http' | 'https';
  host: string;
  port: number;
}

/** Split `scheme://host[:port]` — and nothing longer — into its parts, or say it is not one. */
function splitOrigin(raw: string): ParsedOrigin | undefined {
  const match = /^(https?):\/\/([^/?#@\s]+)$/i.exec(raw.trim());
  if (!match) return undefined;
  const scheme = match[1]!.toLowerCase() as 'http' | 'https';
  const authority = match[2]!.toLowerCase();
  const bracketed = authority.startsWith('[');
  const parts = bracketed ? /^(\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/.exec(authority) : /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!parts) return undefined;
  const host = parts[1]!;
  if (host.endsWith('.')) return undefined;
  const port = parts[2] === undefined ? (scheme === 'https' ? 443 : 80) : Number(parts[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { scheme, host, port };
}

function isDnsName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host.split('.').every((label) => LABEL.test(label));
}

/**
 * Read one entry of an origin list. Throws, with the reason, for anything that is not a bare origin or a
 * safe wildcard: a security list that quietly ignores a typo is a list that does not do its job.
 */
export function parseOriginPattern(entry: string): OriginPattern {
  const fail = (reason: string): never => {
    throw new Error(`invalid origin "${entry}": ${reason}`);
  };
  const parsed = splitOrigin(entry);
  if (!parsed) {
    return fail('expected scheme://host or scheme://host:port, with no path, query, fragment or user name (for example https://wallet.example.org or https://*.example.org)');
  }
  const wildcard = parsed.host.startsWith('*.');
  if (!wildcard) {
    const literal = parsed.host === 'localhost' || IPV4.test(parsed.host) || parsed.host.startsWith('[');
    if (!literal && !isDnsName(parsed.host)) return fail('the host is not a valid name');
    if (parsed.host.includes('*')) return fail('a * may only stand for the whole left-most label, as in https://*.example.org');
    return { ...parsed, wildcard: false };
  }
  const base = parsed.host.slice(2);
  if (base.includes('*')) return fail('a * may only stand for the whole left-most label, as in https://*.example.org');
  if (parsed.scheme !== 'https') return fail('a wildcard is for https only');
  if (!isDnsName(base) || IPV4.test(base)) return fail('the part after *. must be a domain name');
  if (base.split('.').length < 2) return fail('a wildcard on a top-level domain would trust everyone beneath it');
  if (SHARED_SUFFIXES.has(base)) return fail(`${base} is a domain strangers register names under, so a wildcard on it would trust them all; write the name you own, such as *.yourname.${base}`);
  return { scheme: 'https', host: base, port: parsed.port, wildcard: true };
}

/** Read a whole list, once. The entry `*` is the caller's business (a node allows it, deliberately). */
export function compileOrigins(entries: readonly string[]): OriginPattern[] {
  return entries.map((entry) => parseOriginPattern(entry));
}

/**
 * Whether the `Origin` a browser sent is covered by any pattern. Never throws: whatever arrives on the
 * wire that is not a well-formed origin (`null`, a path, a user name, junk) simply does not match.
 */
export function originMatches(origin: string | undefined | null, patterns: readonly OriginPattern[]): boolean {
  if (!origin) return false;
  const seen = splitOrigin(origin);
  if (!seen) return false;
  for (const pattern of patterns) {
    if (pattern.scheme !== seen.scheme || pattern.port !== seen.port) continue;
    if (!pattern.wildcard) {
      if (seen.host === pattern.host) return true;
      continue;
    }
    // Whole labels, on a dot: `evilexample.org` and `example.org.evil.test` are not under `example.org`.
    const suffix = `.${pattern.host}`;
    if (seen.host.length > suffix.length && seen.host.endsWith(suffix)) {
      const subdomain = seen.host.slice(0, -suffix.length);
      if (subdomain.split('.').every((label) => LABEL.test(label))) return true;
    }
  }
  return false;
}

/** The official patterns, compiled once. */
export const OFFICIAL_PATTERNS: readonly OriginPattern[] = compileOrigins(OFFICIAL_ORIGIN_PATTERNS);
