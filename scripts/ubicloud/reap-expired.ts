#!/usr/bin/env bun
/**
 * scripts/ubicloud/reap-expired.ts — destroy expired ci:ubicloud VMs, whoever
 * owns them. Operator side: it runs where the Ubicloud token already lives
 * (the operator's Capy automation), never in GitHub Actions.
 *
 *   bun scripts/ubicloud/reap-expired.ts              # dry run: plan + owner notices
 *   bun scripts/ubicloud/reap-expired.ts --apply      # destroy the expired VMs
 *
 * Options:
 *   --apply              destroy (default: dry run, nothing is destroyed)
 *   --grace-minutes N    keep a VM this long past its expiry (default 15)
 *   --max N              refuse the whole run (exit 3) when more than N VMs
 *                        are expired: a burst that large needs a human look (default 40)
 *   --now EPOCH          evaluate at this time (default now; for tests and replays)
 *
 * Only names in the expiring format are ever selected:
 *
 *   ubirun-<owner>-<created epoch>-x<expiry epoch>-<suffix>
 *
 * which `ci:ubicloud` writes for its gate VMs (`--ttl-hours`, default 2) and
 * `ubi-runner.sh up|run --ttl-hours H` writes on request. Owner-tagged names
 * without an expiry (`ubirun-<owner>-<epoch>-<suffix>`: long dev, benchmark
 * and eval VMs), legacy untagged `ubirun-<epoch>-*` names and VMs the runner
 * did not name are never selected. Ubicloud has no VM tags, so the expiry
 * lives in the name and the list's location and name columns are all the
 * reaper reads.
 *
 * It lists the project's VMs through the same Ubicloud CLI endpoint
 * ubi-runner.sh uses (POST $UBICLOUD_API_URL/cli with UBICLOUD_API_KEY or
 * UBICLOUD_API_TOKEN), prints one row per ubi-runner VM (owner, action, age,
 * expiry, location/name) and an owner-notice block grouping expired VMs by
 * owner with the thread code the owner tag names (gbra135 -> GBRA-135). With
 * --apply each expired VM goes through `ubi-runner.sh down NAME -l LOC`,
 * which destroys it and polls until it is confirmed gone.
 *
 * Exit codes: 0 done (dry run, or every destroy confirmed), 1 the list or a
 * destroy failed, 2 usage, 3 more expired VMs than --max (nothing destroyed).
 * Tests: test/scripts/ubicloud-reap-expired.test.ts.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "ubi-runner.sh");
const MAX_NAME = 63;
const OWNER = "[a-z][a-z0-9]{0,11}";
const EXPIRING = new RegExp(`^ubirun-(${OWNER})-(\\d{10})-x(\\d{10})-([a-z0-9]{1,24})$`);
const NO_EXPIRY = new RegExp(`^ubirun-(${OWNER})-(\\d{10})-([a-z0-9]{1,24})$`);
const LEGACY = /^ubirun-(\d{10})-[a-z0-9]{1,24}$/;

export type ParsedName =
  | { kind: "expiring"; owner: string; createdAt: number; expiresAt: number }
  | { kind: "no-expiry"; owner: string; createdAt: number }
  | { kind: "legacy"; createdAt: number }
  | { kind: "foreign" };

export function parseVmName(name: string): ParsedName {
  let m = EXPIRING.exec(name);
  if (m) return { kind: "expiring", owner: m[1]!, createdAt: Number(m[2]), expiresAt: Number(m[3]) };
  m = NO_EXPIRY.exec(name);
  if (m) return { kind: "no-expiry", owner: m[1]!, createdAt: Number(m[2]) };
  m = LEGACY.exec(name);
  if (m) return { kind: "legacy", createdAt: Number(m[1]) };
  return { kind: "foreign" };
}

/** A gate VM name: expiring `ttlHours` after `createdAt`, or no expiry when ttlHours is 0. */
export function expiringVmName(o: { owner: string; createdAt: number; ttlHours: number; suffix: string }): string {
  if (!Number.isInteger(o.ttlHours) || o.ttlHours < 0 || o.ttlHours > 8760) throw new Error(`ttl must be a whole number of hours from 0 to 8760, got ${o.ttlHours}`);
  const name = o.ttlHours
    ? `ubirun-${o.owner}-${o.createdAt}-x${o.createdAt + o.ttlHours * 3600}-${o.suffix}`
    : `ubirun-${o.owner}-${o.createdAt}-${o.suffix}`;
  if (name.length > MAX_NAME || parseVmName(name).kind !== (o.ttlHours ? "expiring" : "no-expiry")) throw new Error(`not a valid ubi-runner VM name: ${name}`);
  return name;
}

export interface VmRow { location: string; name: string }
export interface PlanRow extends VmRow {
  parsed: ParsedName;
  action: "destroy" | "keep" | "skip";
  reason?: string;
  result?: "destroyed" | "failed";
}

export function planReap(rows: VmRow[], o: { now: number; graceSeconds: number }): PlanRow[] {
  return rows.map((row) => {
    const parsed = parseVmName(row.name);
    if (parsed.kind === "foreign") return { ...row, parsed, action: "skip", reason: "not named by ubi-runner" };
    if (parsed.kind === "legacy") return { ...row, parsed, action: "skip", reason: "legacy name" };
    if (parsed.kind === "no-expiry") return { ...row, parsed, action: "skip", reason: "no expiry" };
    if (parsed.expiresAt <= parsed.createdAt) return { ...row, parsed, action: "skip", reason: "expiry before creation" };
    return { ...row, parsed, action: o.now >= parsed.expiresAt + o.graceSeconds ? "destroy" : "keep" };
  });
}

const span = (seconds: number) => {
  const m = Math.max(0, Math.floor(seconds / 60));
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};
const ownerOf = (p: ParsedName) => ("owner" in p ? p.owner : p.kind === "legacy" ? "(untagged)" : "(other)");
const threadOf = (owner: string) => {
  const m = /^([a-z]+)(\d+)$/.exec(owner);
  return m ? `${m[1]!.toUpperCase()}-${m[2]}` : null;
};

function actionLabel(row: PlanRow, apply: boolean): string {
  if (row.action === "skip") return `skip: ${row.reason}`;
  if (row.action === "keep") return "keep";
  if (row.result) return row.result === "destroyed" ? "destroyed" : "destroy FAILED";
  return apply ? "destroy" : "would destroy";
}

export function renderPlan(plan: PlanRow[], o: { now: number; apply: boolean; graceSeconds: number }): string {
  const mine = plan.filter((row) => row.parsed.kind !== "foreign");
  const foreign = plan.length - mine.length;
  const lines = [
    `reap-expired: ${o.apply ? "apply" : "dry run (pass --apply to destroy)"}, now ${new Date(o.now * 1000).toISOString()}, grace ${o.graceSeconds / 60}m`,
    `${"OWNER".padEnd(13)} ${"ACTION".padEnd(26)} ${"AGE".padEnd(8)} ${"EXPIRY".padEnd(22)} VM`,
  ];
  for (const row of mine) {
    const p = row.parsed;
    const age = "createdAt" in p ? span(o.now - p.createdAt) : "-";
    const expiry = p.kind === "expiring" ? (p.expiresAt <= o.now ? `expired ${span(o.now - p.expiresAt)} ago` : `expires in ${span(p.expiresAt - o.now)}`) : "-";
    lines.push(`${ownerOf(p).padEnd(13)} ${actionLabel(row, o.apply).padEnd(26)} ${age.padEnd(8)} ${expiry.padEnd(22)} ${row.location}/${row.name}`);
  }
  if (foreign) lines.push(`${foreign} VM(s) not named by ubi-runner: skipped`);
  const count = (action: PlanRow["action"]) => plan.filter((row) => row.action === action).length;
  lines.push(`summary: ${count("destroy")} expired (${o.apply ? "destroy" : "would destroy"}), ${count("keep")} not yet expired, ${mine.length - count("destroy") - count("keep")} without a usable expiry (never reaped), ${foreign} not ubi-runner's`);
  return lines.join("\n");
}

export function ownerNotices(plan: PlanRow[], o: { now: number; apply: boolean }): string {
  const byOwner = new Map<string, PlanRow[]>();
  for (const row of plan) if (row.action === "destroy") byOwner.set(ownerOf(row.parsed), [...(byOwner.get(ownerOf(row.parsed)) ?? []), row]);
  const lines = ["=== owner notices ==="];
  if (!byOwner.size) return [...lines, "no expired VMs"].join("\n");
  for (const [owner, rows] of byOwner) {
    const thread = threadOf(owner);
    lines.push(`owner ${owner}${thread ? ` (thread ${thread})` : ""}: ${rows.length} expired VM(s)`);
    for (const row of rows) {
      const p = row.parsed as Extract<ParsedName, { kind: "expiring" }>;
      lines.push(`  - ${row.location}/${row.name} expired ${span(o.now - p.expiresAt)} ago (created ${span(o.now - p.createdAt)} ago)${row.result === "failed" ? ": destroy FAILED, still running" : ""}`);
    }
    lines.push(o.apply
      ? `  Destroyed by the operator reaper at ${new Date(o.now * 1000).toISOString()}. Nothing to do unless a run still needed one: start long runs with ubi-runner.sh up/run --ttl-hours H, or without --ttl-hours for a VM that never expires.`
      : `  Dry run: nothing was destroyed. The operator reaper destroys these once it runs with --apply. Destroy them now with UBI_OWNER=${owner} scripts/ubicloud/ubi-runner.sh down <name> -l <location>. An expiry can't be extended; start long runs with ubi-runner.sh up/run --ttl-hours H, or without --ttl-hours for a VM that never expires.`);
  }
  return lines.join("\n");
}

async function listVms(): Promise<VmRow[]> {
  const token = process.env.UBICLOUD_API_KEY || process.env.UBICLOUD_API_TOKEN;
  if (!token) throw new Error("UBICLOUD_API_KEY (or UBICLOUD_API_TOKEN) is not set");
  const api = process.env.UBICLOUD_API_URL || "https://api.ubicloud.com";
  const res = await fetch(`${api}/cli`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "text/plain", "content-type": "application/json", "x-ubi-version": "1.0.0" },
    body: JSON.stringify({ argv: ["vm", "list", "-N", "-f", "location,name"] }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`ubi vm list -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  return body.split("\n").map((line) => line.trim().split(/\s+/)).filter((cols) => cols.length === 2 && cols[0] && cols[1]).map(([location, name]) => ({ location: location!, name: name! }));
}

function down(row: PlanRow): Promise<{ ok: boolean; log: string }> {
  return new Promise((done) => {
    const child = spawn("bash", [RUNNER, "down", row.name, "-l", row.location], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (code) => done({ ok: code === 0, log: log.trim() }));
  });
}

function usage(message: string): never {
  console.error(`reap-expired: ${message}`);
  console.error("usage: bun scripts/ubicloud/reap-expired.ts [--apply] [--grace-minutes N] [--max N] [--now EPOCH]");
  process.exit(2);
}

async function main(argv: string[]) {
  let apply = false;
  let graceMinutes = 15;
  let max = 40;
  let now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const num = () => {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) usage(`${arg} needs a whole number`);
      return v;
    };
    if (arg === "--apply") apply = true;
    else if (arg === "--grace-minutes") graceMinutes = num();
    else if (arg === "--max") max = num();
    else if (arg === "--now") now = num();
    else usage(`unknown argument ${arg}`);
  }
  const graceSeconds = graceMinutes * 60;
  const plan = planReap(await listVms(), { now, graceSeconds });
  const expired = plan.filter((row) => row.action === "destroy");
  if (apply && expired.length > max) {
    console.log(renderPlan(plan, { now, apply: false, graceSeconds }));
    console.error(`reap-expired: ${expired.length} expired VMs exceed --max ${max}; nothing was destroyed. A burst this large means something else is wrong: check the plan above, then rerun with a higher --max.`);
    process.exit(3);
  }
  let failed = 0;
  if (apply) {
    for (let i = 0; i < expired.length; i += 4) {
      await Promise.all(expired.slice(i, i + 4).map(async (row) => {
        const r = await down(row);
        row.result = r.ok ? "destroyed" : "failed";
        if (!r.ok) {
          failed++;
          console.error(`reap-expired: destroy FAILED for ${row.location}/${row.name}:\n${r.log}`);
        }
      }));
    }
  }
  console.log(renderPlan(plan, { now, apply, graceSeconds }));
  console.log("");
  console.log(ownerNotices(plan, { now, apply }));
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`reap-expired: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
