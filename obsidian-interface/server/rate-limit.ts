/**
 * Per-client token buckets for the interface.
 *
 * The interface is the public face of a deployment, and several of its endpoints cost real CPU on purpose
 * (password hashing is slow so that a stolen file is hard to crack). Slow-by-design plus unthrottled is a
 * denial-of-service switch, so every costly route is held to a budget per client address. The implementation is
 * shared, byte for byte, with the node's RPC server: see keyed-limiter.ts.
 */

export { KeyedLimiter, clientBucket } from './keyed-limiter.js';
