/**
 * Opt-in telemetry must never reach the live endpoint from a test run (gstack
 * once stored 554,000 fixture rows that way). With this set,
 * src/core/telemetry/endpoint.ts returns no endpoint unless a test points
 * GBRAIN_TELEMETRY_URL at its own local stand-in. Child processes inherit it.
 */
process.env.GBRAIN_TEST_BLOCK_LIVE_TELEMETRY = '1';
