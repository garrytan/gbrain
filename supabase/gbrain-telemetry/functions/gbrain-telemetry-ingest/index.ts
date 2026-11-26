// gbrain-telemetry-ingest: the only write path into gbrain's telemetry tables.
// Called by gbrain's client (src/core/telemetry/) with the project's public
// key, which itself can read and write nothing (G001). Every field is checked
// here before the insert; anything off its list is stored as null or dropped,
// and unknown keys never reach the table. Writes use the service-role key from
// the function's own environment.
//
// Deploy: supabase functions deploy gbrain-telemetry-ingest (or paste this file
// into the dashboard editor with validate.ts beside it). Every field check lives
// in validate.ts, which gbrain's tests import directly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { MAX_BATCH, MAX_BYTES, type Row, str, toRow, UUID_RE } from "./validate.ts";

// Global daily ceiling, counted in accepted requests and rows per UTC day.
// gbrain clients send at most one request per install per 6 hours, so 15,000
// requests a day covers about 3,700 opted-in installs at that cadence (about
// 450,000 accepted requests a month). With gstack's own traffic (about 310,000
// invocations a month on 2026-11-22) that stays under half the Pro quota of
// 2 million. Over the ceiling the function answers 429 without touching the
// tables. It caps what lands, not what callers send: a caller that floods the
// endpoint still spends invocations, which Supabase counts before this code runs.
const MAX_REQUESTS_PER_DAY = 15_000;
const MAX_ROWS_PER_DAY = 150_000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "post_required" });
  if (parseInt(req.headers.get("content-length") || "0") > MAX_BYTES) return json(413, { error: "payload_too_large" });

  let body: unknown;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES) return json(413, { error: "payload_too_large" });
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // gbrain telemetry forget: {"forget": "<installation id>"}. It stays outside
  // the daily ceiling, so a flood can never block withdrawal; it only deletes,
  // and an unknown id is one index lookup.
  if (body && typeof body === "object" && !Array.isArray(body) && "forget" in body) {
    const id = str(UUID_RE, (body as Row).forget);
    if (!id) return json(400, { error: "invalid_installation_id" });
    const { data, error } = await supabase.rpc("gbrain_telemetry_forget", { p_installation_id: id });
    if (error) return json(500, { error: "forget_failed" });
    return json(200, { forgotten: true, events_cleared: data ?? 0 });
  }

  const events = Array.isArray(body) ? body : [body];
  if (events.length > MAX_BATCH) return json(400, { error: "batch_too_large", max: MAX_BATCH });

  const rows: Row[] = [];
  for (const e of events) {
    const row = e && typeof e === "object" ? toRow(e as Row) : null;
    if (row) rows.push(row);
  }
  const rejected = events.length - rows.length;
  if (rows.length === 0) return json(200, { accepted: 0, rejected });

  const { data: room, error: reserveError } = await supabase.rpc("gbrain_ingest_reserve", {
    p_rows: rows.length,
    p_max_requests: MAX_REQUESTS_PER_DAY,
    p_max_rows: MAX_ROWS_PER_DAY,
  });
  if (reserveError) return json(500, { error: "reserve_failed" });
  if (room !== true) return json(429, { error: "daily_ceiling", retry_after_s: 3600 });

  const { error: insertError } = await supabase.from("gbrain_telemetry_events").insert(rows);
  if (insertError) return json(500, { error: "insert_failed" });

  const today = new Date().toISOString().slice(0, 10);
  const installs = new Map<string, Row>();
  for (const r of rows) {
    if (typeof r.installation_id === "string" && r.source === "live") {
      installs.set(r.installation_id, { installation_id: r.installation_id, last_seen: today, gbrain_version: r.gbrain_version, os: r.os });
    }
  }
  if (installs.size) {
    await supabase.from("gbrain_installations").upsert([...installs.values()], { onConflict: "installation_id" });
  }

  return json(200, { accepted: rows.length, rejected });
});
