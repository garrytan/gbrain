import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, readlink, rm, stat, symlink, unlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContentAddressedStore,
  type ContentAddressedStoreOptions,
  type RegistryLockLease,
} from "../src/coe/registry/content-addressed-store.ts";

const LOCK_NAME = "b".repeat(64);
const LEASE_MS = 60;

function options(overrides: Partial<ContentAddressedStoreOptions> = {}): ContentAddressedStoreOptions {
  return {
    lock_timeout_ms: 180,
    lock_lease_ms: LEASE_MS,
    lock_retry_ms: 5,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
}

function leaseDatabase(root: string): string {
  return join(root, "locks", "leases.sqlite");
}

async function assertProcessGone(pid: number): Promise<void> {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
    }
  });
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text.split("\n", 1)[0]?.trim() ?? "";
}

async function linuxProcessIdentity(pid: number): Promise<{
  machine_id: string;
  boot_id: string;
  pid_namespace: string;
  process_start_ticks: string;
  state: string;
}> {
  const [machineId, bootId, pidNamespace, statLine] = await Promise.all([
    readFile("/etc/machine-id", "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readlink("/proc/self/ns/pid"),
    readFile(`/proc/${pid}/stat`, "utf8"),
  ]);
  const commandEnd = statLine.lastIndexOf(")");
  const fields = statLine.slice(commandEnd + 2).trim().split(/\s+/);
  return {
    machine_id: machineId.trim(),
    boot_id: bootId.trim(),
    pid_namespace: pidNamespace,
    process_start_ticks: fields[19] ?? "",
    state: fields[0] ?? "",
  };
}

describe("CoE registry owner leases", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  test("recovers an expired lease only after its owner process has crashed", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-crash-"));
    roots.push(root);
    const modulePath = join(import.meta.dir, "../src/coe/registry/content-addressed-store.ts");
    const childSource = `
      import { ContentAddressedStore } from ${JSON.stringify(modulePath)};
      const store = new ContentAddressedStore(${JSON.stringify(root)}, () => "unused-test-nonce", {
        lock_timeout_ms: 180,
        lock_lease_ms: ${LEASE_MS},
        lock_retry_ms: 5,
      });
      await store.withLock(${JSON.stringify(LOCK_NAME)}, async () => {
        console.log("LOCK_ACQUIRED");
        await new Promise(() => {});
      });
    `;
    const child = Bun.spawn([process.execPath, "-e", childSource], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const childPid = child.pid;
    const stdout = await readFirstLine(child.stdout);
    expect(stdout).toBe("LOCK_ACQUIRED");
    await Bun.sleep(LEASE_MS * 2);
    child.kill(9);
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect([9, 137]).toContain(exitCode);
    expect(stderr).toBe("");
    await assertProcessGone(childPid);
    await Bun.sleep(LEASE_MS + 20);

    const recovered = new ContentAddressedStore(root, () => "replacement-owner", options());
    await expect(recovered.withLock(LOCK_NAME, async () => "recovered")).resolves.toBe("recovered");
    const inspection = new Database(leaseDatabase(root), { readonly: true });
    const remaining = inspection.query("SELECT count(*) AS count FROM registry_lock_leases").get() as { count: number };
    inspection.close();
    expect(remaining.count).toBe(0);
  });

  test("recovers an expired lease from a zombie owner", async () => {
    const python = process.platform === "linux" ? Bun.which("python3") : null;
    if (!python) return;
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-zombie-"));
    roots.push(root);
    const parent = Bun.spawn([
      python,
      "-c",
      "import os,time; pid=os.fork(); (os._exit(0) if pid == 0 else print(pid, flush=True)); time.sleep(30)",
    ], { stdout: "pipe", stderr: "pipe" });
    const zombiePid = Number(await readFirstLine(parent.stdout));
    try {
      expect(Number.isSafeInteger(zombiePid) && zombiePid > 0).toBe(true);
      await waitFor(async () => (await linuxProcessIdentity(zombiePid)).state === "Z");
      const identity = await linuxProcessIdentity(zombiePid);
      const store = new ContentAddressedStore(root, () => "zombie-reclaimer", options());
      await store.listKeys("locks");
      const database = new Database(leaseDatabase(root));
      database.run(
        `INSERT INTO registry_lock_leases (
          name, owner_id, hostname, machine_id, boot_id, pid_namespace, pid, process_start_ticks,
          lease_expires_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          LOCK_NAME,
          "zombie-owner",
          hostname(),
          identity.machine_id,
          identity.boot_id,
          identity.pid_namespace,
          zombiePid,
          identity.process_start_ticks,
          1,
          1,
        ],
      );
      database.close();

      await expect(store.withLock(LOCK_NAME, async () => "recovered-zombie")).resolves.toBe("recovered-zombie");
    } finally {
      parent.kill();
      await parent.exited;
      await assertProcessGone(zombiePid);
    }
  });

  test("renews a live owner lease and keeps contenders out", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-live-"));
    roots.push(root);
    let entered!: () => void;
    let release!: () => void;
    const operationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const owner = new ContentAddressedStore(root, () => "live-owner", options());
    const contender = new ContentAddressedStore(root, () => "contender", options({ lock_timeout_ms: 90 }));

    const owning = owner.withLock(LOCK_NAME, async () => {
      entered();
      await hold;
      return "owner-finished";
    });
    await operationEntered;
    await Bun.sleep(LEASE_MS * 2);

    await expect(contender.withLock(LOCK_NAME, async () => "stolen")).rejects.toMatchObject({
      code: "policy_violation",
    });
    release();
    await expect(owning).resolves.toBe("owner-finished");
  });

  test("never steals an expired lease whose exact process owner is still alive", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-expired-live-"));
    roots.push(root);
    const store = new ContentAddressedStore(root, () => "contender", options({ lock_timeout_ms: 30 }));
    await store.listKeys("locks");
    const identity = await linuxProcessIdentity(process.pid);
    const database = new Database(leaseDatabase(root));
    database.run(
      `INSERT INTO registry_lock_leases (
        name, owner_id, hostname, machine_id, boot_id, pid_namespace, pid, process_start_ticks,
        lease_expires_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        LOCK_NAME,
        "expired-live-owner",
        hostname(),
        identity.machine_id,
        identity.boot_id,
        identity.pid_namespace,
        process.pid,
        identity.process_start_ticks,
        1,
        1,
      ],
    );
    database.close();

    await expect(store.withLock(LOCK_NAME, async () => "stolen")).rejects.toMatchObject({
      code: "policy_violation",
    });
    const inspection = new Database(leaseDatabase(root), { readonly: true });
    const row = inspection.query("SELECT owner_id FROM registry_lock_leases WHERE name = ?").get(LOCK_NAME) as {
      owner_id: string;
    };
    inspection.close();
    expect(row.owner_id).toBe("expired-live-owner");
  });

  test("never steals an expired lease from another PID namespace", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-namespace-"));
    roots.push(root);
    const store = new ContentAddressedStore(root, () => "contender", options({ lock_timeout_ms: 30 }));
    await store.listKeys("locks");
    const identity = await linuxProcessIdentity(process.pid);
    const database = new Database(leaseDatabase(root));
    database.run(
      `INSERT INTO registry_lock_leases (
        name, owner_id, hostname, machine_id, boot_id, pid_namespace, pid, process_start_ticks,
        lease_expires_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        LOCK_NAME,
        "other-namespace-owner",
        hostname(),
        identity.machine_id,
        identity.boot_id,
        "pid:[other]",
        999_999_999,
        "1",
        1,
        1,
      ],
    );
    database.close();

    await expect(store.withLock(LOCK_NAME, async () => "stolen")).rejects.toMatchObject({
      code: "policy_violation",
    });
    const inspection = new Database(leaseDatabase(root), { readonly: true });
    const row = inspection.query("SELECT owner_id FROM registry_lock_leases WHERE name = ?").get(LOCK_NAME) as {
      owner_id: string;
    };
    inspection.close();
    expect(row.owner_id).toBe("other-namespace-owner");
  });

  test("serializes two contenders recovering the same crashed owner", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-race-"));
    roots.push(root);
    const databasePath = leaseDatabase(root);
    const seeder = new ContentAddressedStore(root, () => "seed-owner", options());
    await seeder.listKeys("locks");

    const database = new Database(databasePath);
    const identity = await linuxProcessIdentity(process.pid);
    database.run(
      `INSERT INTO registry_lock_leases (
        name, owner_id, hostname, machine_id, boot_id, pid_namespace, pid, process_start_ticks,
        lease_expires_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        LOCK_NAME,
        "dead-owner",
        hostname(),
        identity.machine_id,
        "dead-boot",
        identity.pid_namespace,
        999_999_999,
        "1",
        1,
        1,
      ],
    );
    database.close();

    let active = 0;
    let maximumActive = 0;
    const run = async (ownerId: string) => {
      const store = new ContentAddressedStore(root, () => ownerId, options({ lock_timeout_ms: 500 }));
      return store.withLock(LOCK_NAME, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(30);
        active -= 1;
        return ownerId;
      });
    };

    await expect(Promise.all([run("reclaimer-a"), run("reclaimer-b")])).resolves.toEqual([
      "reclaimer-a",
      "reclaimer-b",
    ]);
    expect({ active, maximumActive }).toEqual({ active: 0, maximumActive: 1 });
  });

  test("serializes lock owners across separate processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-process-race-"));
    roots.push(root);
    const modulePath = join(import.meta.dir, "../src/coe/registry/content-addressed-store.ts");
    const runChild = async (label: string) => {
      const childSource = `
        import { ContentAddressedStore } from ${JSON.stringify(modulePath)};
        const store = new ContentAddressedStore(${JSON.stringify(root)}, () => "unused", {
          lock_timeout_ms: 1000,
          lock_lease_ms: 120,
          lock_retry_ms: 5,
        });
        const interval = await store.withLock(${JSON.stringify(LOCK_NAME)}, async () => {
          const entered_at = Date.now();
          await Bun.sleep(80);
          return { label: ${JSON.stringify(label)}, entered_at, exited_at: Date.now() };
        });
        console.log(JSON.stringify(interval));
      `;
      const child = Bun.spawn([process.execPath, "-e", childSource], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      await assertProcessGone(child.pid);
      return JSON.parse(stdout) as { label: string; entered_at: number; exited_at: number };
    };

    const intervals = await Promise.all([runChild("a"), runChild("b")]);
    intervals.sort((left, right) => left.entered_at - right.entered_at);
    expect(intervals[1]!.entered_at).toBeGreaterThanOrEqual(intervals[0]!.exited_at);
  });

  test("a displaced owner cannot renew or release the replacement lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-owner-"));
    roots.push(root);
    let entered!: (lease: RegistryLockLease) => void;
    const operationEntered = new Promise<RegistryLockLease>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const finishOperation = new Promise<void>((resolve) => { finish = resolve; });
    const owner = new ContentAddressedStore(root, () => "original-owner", options({ lock_lease_ms: 120 }));

    const owning = owner.withLock(LOCK_NAME, async (lease) => {
      entered(lease);
      await finishOperation;
      return "must-not-succeed";
    });
    const lease = await operationEntered;
    const databasePath = leaseDatabase(root);
    const database = new Database(databasePath);
    database.run(
      `UPDATE registry_lock_leases
       SET owner_id = ?, lease_expires_at_ms = ?, updated_at_ms = ?
       WHERE name = ?`,
      ["replacement-owner", Date.now() + 10_000, Date.now(), LOCK_NAME],
    );
    database.close();

    await waitFor(() => lease.signal.aborted, 500);
    await expect(lease.assertOwned()).rejects.toMatchObject({ code: "policy_violation" });
    finish();
    await expect(owning).rejects.toMatchObject({ code: "policy_violation" });

    const inspection = new Database(databasePath, { readonly: true });
    const row = inspection.query("SELECT owner_id FROM registry_lock_leases WHERE name = ?").get(LOCK_NAME) as {
      owner_id: string;
    } | null;
    inspection.close();
    expect(row?.owner_id).toBe("replacement-owner");
  });

  test("leaves legacy owner files untouched because their liveness cannot be proven", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-legacy-"));
    roots.push(root);
    const store = new ContentAddressedStore(root, () => "new-owner", options({ lock_timeout_ms: 30 }));
    await store.listKeys("locks");
    const path = join(root, "locks", `${LOCK_NAME}.lock`);
    await Bun.write(path, "legacy-owner");

    await expect(store.withLock(LOCK_NAME, async () => "unsafe-recovery")).rejects.toMatchObject({
      code: "policy_violation",
    });
    expect(await readFile(path, "utf8")).toBe("legacy-owner");
  });

  test("publishes a persistent compatibility sentinel that blocks the legacy algorithm", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-sentinel-"));
    roots.push(root);
    const path = join(root, "locks", `${LOCK_NAME}.lock`);
    const store = new ContentAddressedStore(root, () => "unused", options());
    const legacyCanAcquire = async (): Promise<boolean> => {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.close();
        await unlink(path);
        return true;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
          return false;
        }
        throw error;
      }
    };

    await expect(store.withLock(LOCK_NAME, async () => {
      expect(await readFile(path, "utf8")).toBe("gbrain-coe-sqlite-lease-v1\n");
      expect(await legacyCanAcquire()).toBe(false);
      return "first";
    })).resolves.toBe("first");

    expect(await legacyCanAcquire()).toBe(false);
    const successor = new ContentAddressedStore(root, () => "unused", options());
    await expect(successor.withLock(LOCK_NAME, async () => "second")).resolves.toBe("second");
    expect((await successor.listKeys("staging")).filter((key) => key.includes("lock-sentinel-"))).toEqual([]);
  });

  test("recovers an expired portable lease when the local PID no longer exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-portable-"));
    roots.push(root);
    const store = new ContentAddressedStore(root, () => "unused", options());
    await store.listKeys("locks");
    const database = new Database(leaseDatabase(root));
    database.run(
      `INSERT INTO registry_lock_leases (
        name, owner_id, hostname, machine_id, boot_id, pid_namespace, pid, process_start_ticks,
        lease_expires_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [LOCK_NAME, "portable-owner", hostname(), "unknown", "portable-pid-only", "unknown", 999_999_999, "unknown", 1, 1],
    );
    database.close();

    await expect(store.withLock(LOCK_NAME, async () => "portable-recovered")).resolves.toBe("portable-recovered");
  });

  test("never recovers an expired lease owned by another host", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-remote-"));
    roots.push(root);
    const store = new ContentAddressedStore(root, () => "local-owner", options({ lock_timeout_ms: 30 }));
    await store.listKeys("locks");
    const database = new Database(leaseDatabase(root));
    database.run(
      `INSERT INTO registry_lock_leases (
        name, owner_id, hostname, machine_id, boot_id, pid_namespace, pid, process_start_ticks,
        lease_expires_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        LOCK_NAME,
        "remote-owner",
        "another-host",
        "another-machine",
        "unknown-boot",
        "unknown-namespace",
        999_999_999,
        "1",
        1,
        1,
      ],
    );
    database.close();

    await expect(store.withLock(LOCK_NAME, async () => "unsafe-recovery")).rejects.toMatchObject({
      code: "policy_violation",
    });
    const inspection = new Database(leaseDatabase(root), { readonly: true });
    const row = inspection.query("SELECT owner_id FROM registry_lock_leases WHERE name = ?").get(LOCK_NAME) as {
      owner_id: string;
    };
    inspection.close();
    expect(row.owner_id).toBe("remote-owner");
  });

  test("recovers a pre-reboot owner even when the machine hostname changed", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-reboot-"));
    roots.push(root);
    const store = new ContentAddressedStore(root, () => "unused", options());
    await store.listKeys("locks");
    const identity = await linuxProcessIdentity(process.pid);
    const database = new Database(leaseDatabase(root));
    database.run(
      `INSERT INTO registry_lock_leases (
        name, owner_id, hostname, machine_id, boot_id, pid_namespace, pid, process_start_ticks,
        lease_expires_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        LOCK_NAME,
        "pre-reboot-owner",
        "previous-hostname",
        identity.machine_id,
        "previous-boot",
        identity.pid_namespace,
        999_999_999,
        "1",
        1,
        1,
      ],
    );
    database.close();

    await expect(store.withLock(LOCK_NAME, async () => "recovered-after-reboot")).resolves.toBe(
      "recovered-after-reboot",
    );
  });

  test("retries transient SQLite contention during acquisition and heartbeat", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-busy-"));
    roots.push(root);
    const store = new ContentAddressedStore(root, () => "busy-owner", options({ lock_timeout_ms: 300 }));
    await store.listKeys("locks");

    const acquisitionBlocker = new Database(leaseDatabase(root));
    acquisitionBlocker.exec("BEGIN EXCLUSIVE");
    let acquisitionBlocked = true;
    const releaseAcquisitionBlocker = setTimeout(() => {
      acquisitionBlocker.exec("COMMIT");
      acquisitionBlocked = false;
    }, 30);
    try {
      await expect(store.withLock(LOCK_NAME, async () => "acquired-after-busy")).resolves.toBe("acquired-after-busy");
    } finally {
      clearTimeout(releaseAcquisitionBlocker);
      if (acquisitionBlocked) acquisitionBlocker.exec("ROLLBACK");
      acquisitionBlocker.close();
    }

    let entered!: () => void;
    const operationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const owning = store.withLock(LOCK_NAME, async () => {
      entered();
      await Bun.sleep(100);
      return "renewed-after-busy";
    });
    await operationEntered;
    const heartbeatBlocker = new Database(leaseDatabase(root));
    heartbeatBlocker.exec("BEGIN EXCLUSIVE");
    let heartbeatBlocked = true;
    const releaseHeartbeatBlocker = setTimeout(() => {
      heartbeatBlocker.exec("COMMIT");
      heartbeatBlocked = false;
    }, 35);
    try {
      await expect(owning).resolves.toBe("renewed-after-busy");
    } finally {
      clearTimeout(releaseHeartbeatBlocker);
      if (heartbeatBlocked) heartbeatBlocker.exec("ROLLBACK");
      heartbeatBlocker.close();
    }
  });

  test("rejects a symlinked lease database and creates regular databases with mode 0600", async () => {
    const safeRoot = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-mode-"));
    roots.push(safeRoot);
    const safeStore = new ContentAddressedStore(safeRoot, () => "safe-owner", options());
    await safeStore.listKeys("locks");
    const safeMetadata = await stat(leaseDatabase(safeRoot));
    expect(safeMetadata.mode & 0o777).toBe(0o600);
    const safeDatabase = new Database(leaseDatabase(safeRoot), { readonly: true });
    expect((safeDatabase.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    safeDatabase.close();

    const hostileRoot = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-symlink-"));
    const targetRoot = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-target-"));
    roots.push(hostileRoot, targetRoot);
    await mkdir(join(hostileRoot, "locks"), { mode: 0o700 });
    const target = join(targetRoot, "outside.sqlite");
    await Bun.write(target, "do-not-touch");
    await symlink(target, leaseDatabase(hostileRoot));
    const hostileStore = new ContentAddressedStore(hostileRoot, () => "hostile-owner", options());

    await expect(hostileStore.listKeys("locks")).rejects.toMatchObject({ code: "policy_violation" });
    expect(await readFile(target, "utf8")).toBe("do-not-touch");

    const futureRoot = await mkdtemp(join(tmpdir(), "gbrain-coe-lock-future-"));
    roots.push(futureRoot);
    await mkdir(join(futureRoot, "locks"), { mode: 0o700 });
    const futureDatabase = new Database(leaseDatabase(futureRoot));
    futureDatabase.exec("PRAGMA user_version = 99");
    futureDatabase.close();
    const futureStore = new ContentAddressedStore(futureRoot, () => "future-owner", options());
    await expect(futureStore.listKeys("locks")).rejects.toMatchObject({ code: "policy_violation" });
  });
});
