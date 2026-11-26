// gbrain-telemetry-pulse: the public aggregate view of gbrain's opt-in
// telemetry, cached for an hour. It returns counts only: no installation id,
// no row. Read by `gbrain telemetry pulse` and GBrain's 8-hourly severe sweep.
//
// Contract (same as gstack's community-pulse): a healthy answer carries
// status "ok"; when the summary can't be computed it serves the last cached
// answer marked stale: true, or 503 {"error":"pulse_unavailable"} with no
// cache. An outage never reads as zeros.
//
// Only versions up to the newest gbrain release count: the function reads the
// released VERSION from GitHub (cached with the summary), so a row claiming a
// future version can't fake a regression. If GitHub can't be read it reuses the
// last version it saw, and with none it counts every release-shaped version and
// says so (max_version: null).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const CLAIM_MS = 5 * 60 * 1000;
const VERSION_URL = "https://raw.githubusercontent.com/garrytan/gbrain/master/VERSION";
const VERSION_RE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5}))?$/;
const HEADERS = { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" };
const STALE_HEADERS = { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" };

async function newestRelease(): Promise<string | null> {
  try {
    const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const v = (await res.text()).trim();
    return VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "POST") return new Response("GET required", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  let cached: { data: Record<string, unknown>; refreshed_at: string } | null = null;
  try {
    const { data } = await supabase.from("gbrain_pulse_cache").select("data, refreshed_at").eq("id", 1).maybeSingle();
    cached = data?.data && "setup" in data.data ? data : null;
  } catch {
    cached = null;
  }
  if (cached && Date.now() - new Date(cached.refreshed_at).getTime() < CACHE_MAX_AGE_MS) {
    return new Response(JSON.stringify({ ...cached.data, status: "ok", refreshed_at: cached.refreshed_at }), { status: 200, headers: HEADERS });
  }
  const stale = () =>
    cached
      ? new Response(JSON.stringify({ ...cached.data, status: "ok", stale: true, refreshed_at: cached.refreshed_at }), { status: 200, headers: STALE_HEADERS })
      : new Response(JSON.stringify({ error: "pulse_unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });

  try {
    // One refresh at a time, and after a failure none for 5 minutes: the request
    // that claims the cache row recomputes; every other one gets the stale answer.
    const claimBefore = new Date(Date.now() - CLAIM_MS).toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("gbrain_pulse_cache")
      .update({ attempted_at: new Date().toISOString() })
      .eq("id", 1)
      .or(`attempted_at.is.null,attempted_at.lt."${claimBefore}"`)
      .select("id");
    if (claimError || !claimed?.length) return stale();

    const prior = typeof cached?.data?.max_version === "string" ? (cached.data.max_version as string) : null;
    const maxVersion = (await newestRelease()) ?? prior;
    const { data: summary, error } = await supabase.rpc("gbrain_pulse_summary", { p_max_version: maxVersion });
    if (error) throw error;
    if (!summary || typeof summary !== "object") throw new Error("empty pulse summary");
    const refreshed_at = new Date().toISOString();
    const result = { status: "ok", ...(summary as Record<string, unknown>) };
    await supabase.from("gbrain_pulse_cache").update({ data: result, refreshed_at }).eq("id", 1);
    return new Response(JSON.stringify({ ...result, refreshed_at }), { status: 200, headers: HEADERS });
  } catch {
    return stale();
  }
});
