/**
 * Transport selection for the Canadian region.
 *
 * Kia Canada's TLS handshake does not complete under `got` on Node >= 21, so
 * both Canadian request paths switch to undici's `fetch` with a dispatcher
 * carrying `SSL_OP_LEGACY_SERVER_CONNECT`. That decision used to be an inline
 * `process.versions.node` read duplicated in `canadian.controller.ts` and
 * `canadian.vehicle.ts`, which made it untestable: a suite could only ever
 * exercise whichever arm the local interpreter happened to select, and every
 * Canadian test mocks `got`, so on Node >= 21 the mock covered an arm that
 * never ran and the fetch arm made real network calls (#26).
 *
 * Keeping it here as one pure function of the version string gives both call
 * sites a single decision and lets tests drive either arm on any interpreter.
 */

/** The first Node major whose `got` path fails against Kia Canada's TLS. */
export const FETCH_TRANSPORT_MIN_NODE_MAJOR = 21;

/**
 * True when the Canadian region should use undici's `fetch` rather than `got`.
 *
 * An unparseable version yields `NaN`, which compares false and therefore
 * selects `got` — the same fallback the inline checks had.
 */
export function shouldUseFetchTransport(nodeVersion: string = process.versions.node): boolean {
  const [major] = nodeVersion.split('.').map(Number);
  return major >= FETCH_TRANSPORT_MIN_NODE_MAJOR;
}
