/**
 * Where opt-in telemetry goes (docs/guides/telemetry.md). This build ships no
 * address: gbrain's edge functions are not deployed yet, and they stay
 * undeployed until `gbrain telemetry forget` can't be undone by an ingest
 * still running on the server (supabase/gbrain-telemetry/README.md). So
 * nothing leaves the machine and first-run setup asks nothing. The release
 * that deploys them sets the shared project's address and publishable key here.
 *
 * GBRAIN_TELEMETRY_URL (with GBRAIN_TELEMETRY_KEY) points the client at a base
 * URL, which tests use for a local stand-in and the deploy check uses for the
 * project it just deployed.
 */
export interface TelemetryEndpoint { url: string; key: string }

export function telemetryEndpoint(): TelemetryEndpoint | null {
  const url = process.env.GBRAIN_TELEMETRY_URL?.trim();
  if (!url) return null;
  return { url: url.replace(/\/+$/, ''), key: process.env.GBRAIN_TELEMETRY_KEY ?? '' };
}
