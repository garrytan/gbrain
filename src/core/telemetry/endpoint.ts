/**
 * Where opt-in telemetry goes: gbrain's own edge functions in the Supabase
 * project gbrain shares with gstack (docs/guides/telemetry.md). The key is
 * the project's publishable key, the same one gstack ships: it can call the
 * two edge functions and cannot read or write any table.
 *
 * GBRAIN_TELEMETRY_URL (with GBRAIN_TELEMETRY_KEY) points the client at another
 * base URL, which tests use for a local stand-in. Without it, the test preload
 * (GBRAIN_TEST_BLOCK_LIVE_TELEMETRY=1) and bun's NODE_ENV=test return null, so
 * no test can reach the live project.
 */
const PROJECT_URL = 'https://frugpmstpnojnhfyimgv.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_tR4i6cyMIrYTE3s6OyHGHw_ppx2p6WK';

export interface TelemetryEndpoint { url: string; key: string }

export function telemetryEndpoint(): TelemetryEndpoint | null {
  const override = process.env.GBRAIN_TELEMETRY_URL?.trim();
  if (override) return { url: override.replace(/\/+$/, ''), key: process.env.GBRAIN_TELEMETRY_KEY ?? PUBLISHABLE_KEY };
  if (process.env.GBRAIN_TEST_BLOCK_LIVE_TELEMETRY === '1' || process.env.NODE_ENV === 'test') return null;
  return { url: PROJECT_URL, key: PUBLISHABLE_KEY };
}
