/**
 * scripts/ubicloud/schedule.ts — work-item weighting and dynamic batching for
 * scripts/ci-ubicloud.ts.
 *
 * Every test file is one item in a single global queue, ordered heaviest
 * first. Idle VM slots pull from the head of the queue (longest-processing-
 * time-first list scheduling, done dynamically), so a slow VM or a mis-weighted
 * file only delays the slot that holds it instead of a whole static shard.
 * Light items are handed out in same-lane batches to amortize SSH round trips;
 * the batch target shrinks as the queue drains so the tail stays fine-grained.
 */

import { existsSync, readFileSync } from "node:fs";

export type Lane = "unit" | "serial" | "slow" | "e2e" | "pg-arms";

export interface Item {
  lane: Lane;
  file: string;
  weight: number;
  attempts: number;
}

export type WeightTable = Map<string, number>;

export const weightKey = (lane: Lane, file: string) => `${lane}:${file}`;

/** Read a {key: ms} JSON object; a missing file is an empty table. */
export function readWeightTable(path: string, scale = 1, keyPrefix = ""): WeightTable {
  const table: WeightTable = new Map();
  if (!existsSync(path)) return table;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      table.set(keyPrefix + key, value * scale);
    }
  }
  return table;
}

/**
 * Weight each file from the first table that knows it (tables are ordered
 * most-trusted first). Files no table knows get the lane's p75 so new heavy
 * integration tests are not starved to the back of the queue.
 */
export function buildItems(lane: Lane, files: string[], tables: WeightTable[]): Item[] {
  const lookup = (file: string) => {
    for (const table of tables) {
      const value = table.get(weightKey(lane, file));
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const known = files.map(lookup).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.min(known.length - 1, Math.ceil(known.length * 0.75) - 1)]! : 1000;
  return files.map((file) => ({ lane, file, weight: lookup(file) ?? Math.max(fallback, 1), attempts: 0 }));
}

export function sortQueue(queue: Item[]): void {
  queue.sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export interface BatchOpts {
  slots: number;
  maxTargetMs?: number;
  minTargetMs?: number;
  maxFiles?: number;
  /** Items this slot may not take now; they stay queued for other slots. */
  skip?: (item: Item) => boolean;
}

/**
 * Remove and return the next batch from a heaviest-first queue. The first item
 * the slot may take leads; lighter items of the same lane join it until the
 * batch reaches the target weight.
 */
export function takeBatch(queue: Item[], opts: BatchOpts): Item[] {
  const { slots, maxTargetMs = 8000, minTargetMs = 750, maxFiles = 25, skip } = opts;
  const head = skip ? queue.findIndex((item) => !skip(item)) : 0;
  if (head < 0 || queue.length === 0) return [];
  const remaining = queue.reduce((sum, item) => sum + item.weight, 0);
  const target = Math.min(maxTargetMs, Math.max(minTargetMs, remaining / (Math.max(slots, 1) * 4)));
  const batch = queue.splice(head, 1);
  let total = batch[0]!.weight;
  for (let i = 0; i < queue.length && total < target && batch.length < maxFiles; ) {
    const item = queue[i]!;
    if (item.lane === batch[0]!.lane && total + item.weight <= target && !skip?.(item)) {
      batch.push(item);
      total += item.weight;
      queue.splice(i, 1);
    } else {
      i++;
    }
  }
  return batch;
}

export interface ItemResult {
  lane: string;
  file: string;
  rc: number;
  ms: number;
  output: string;
  /** The VM's 1-minute load average per vCPU as the item ended (ci-item.sh's __ubi_load__ line). */
  load?: number;
}

/** Split a ci-item.sh log into per-item results using its marker lines. */
export function parseItemLog(log: string): ItemResult[] {
  const results: ItemResult[] = [];
  let lines: string[] = [];
  for (const line of log.split("\n")) {
    if (line.startsWith("__ubi_item_begin__ ")) {
      lines = [];
      continue;
    }
    const done = /^__ubi_item__ rc=(\d+) ms=(\d+) lane=(\S+) file=(.+)$/.exec(line);
    if (done) {
      results.push({ rc: Number(done[1]), ms: Number(done[2]), lane: done[3]!, file: done[4]!, output: lines.join("\n") });
      lines = [];
      continue;
    }
    const load = /^__ubi_load__ load1=([\d.]+) vcpus=(\d+)$/.exec(line);
    if (load && results.length) {
      results[results.length - 1]!.load = Number(load[1]) / Number(load[2]);
      continue;
    }
    lines.push(line);
  }
  return results;
}

/** The project's total vCPUs from `ubi-runner.sh usage` (its `total VMS VCPUS` row), or null. */
export function parseUsageTotal(report: string): number | null {
  const total = /^total\s+\d+\s+(\d+)\s*$/m.exec(report);
  return total ? Number(total[1]) : null;
}

export interface FleetOpts {
  /** vCPUs the project's VMs hold now; null when usage could not be read. */
  usedVcpus: number | null;
  vmVcpus: number;
  defaultVms: number;
  maxVms: number;
  /** Never push the project's VM vCPUs past this. */
  ceilingVcpus: number;
  /** VMs the run's work can keep busy. */
  workVms: number;
}

/**
 * Burst sizing: as many VMs as fit under the ceiling, between the default and
 * the burst maximum, and no more than the work can use. A busy project gets the
 * default; a VM the quota then refuses just shrinks the fleet.
 */
export function burstVms(o: FleetOpts): { vms: number; reason: string } {
  if (o.usedVcpus === null) {
    const vms = Math.min(o.defaultVms, o.workVms);
    return { vms, reason: `project usage unreadable, using ${vms} VM(s)` };
  }
  const fit = Math.floor((o.ceilingVcpus - o.usedVcpus) / o.vmVcpus);
  const target = Math.max(o.defaultVms, Math.min(o.maxVms, fit));
  const vms = Math.max(1, Math.min(o.workVms, target));
  const why = vms < target ? "all the work can use"
    : fit >= o.maxVms ? `burst maximum ${o.maxVms}`
    : fit > o.defaultVms ? `room for ${fit} under the ceiling`
    : `quota busy, default ${o.defaultVms}`;
  return { vms, reason: `project VMs hold ${o.usedVcpus} vCPUs, ceiling ${o.ceilingVcpus}: ${vms} VM(s) × ${o.vmVcpus} vCPUs (${why})` };
}
