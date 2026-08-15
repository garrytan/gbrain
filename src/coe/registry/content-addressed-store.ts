import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmod,
  constants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

import { CoeContractError, canonicalizeJson, sha256Bytes } from "../contracts/index.ts";

const SAFE_KEY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const SQLITE_LEASE_SENTINEL = "gbrain-coe-sqlite-lease-v1\n";

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isDatabaseBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export interface StoredObject {
  content_hash: string;
  object_key: string;
  byte_size: number;
  created: boolean;
}

export interface RegistryLockOptions {
  /** Maximum time spent waiting to acquire a lock. */
  lock_timeout_ms?: number;
  /** Heartbeat lease duration. Expiration permits a liveness check, never takeover by itself. */
  lock_lease_ms?: number;
  /** Delay between acquisition attempts. */
  lock_retry_ms?: number;
}

export type ContentAddressedStoreOptions = RegistryLockOptions;

interface RegistryLockProcessIdentity {
  hostname: string;
  machine_id: string;
  boot_id: string;
  pid_namespace: string;
  pid: number;
  process_start_ticks: string;
}

type RegistryLockOwnerLiveness = "alive" | "dead" | "unknown";

export interface RegistryLockLease {
  readonly owner_id: string;
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
}

interface RegistryLockRow extends RegistryLockProcessIdentity {
  name: string;
  owner_id: string;
  lease_expires_at_ms: number;
  updated_at_ms: number;
}

interface RegistryLockConfig {
  timeout_ms: number;
  lease_ms: number;
  retry_ms: number;
}

function parseProcessStat(statLine: string): { state: string; start_ticks: string } | null {
  const commandEnd = statLine.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fieldsFromState = statLine.slice(commandEnd + 2).trim().split(/\s+/);
  const state = fieldsFromState[0];
  const startTicks = fieldsFromState[19];
  return state && startTicks ? { state, start_ticks: startTicks } : null;
}

export class ContentAddressedStore {
  private ready: Promise<void> | undefined;
  private canonicalRoot = "";
  private leaseDatabasePath = "";

  constructor(
    readonly root: string,
    private readonly nonce: () => string,
    private readonly options: ContentAddressedStoreOptions = {},
  ) {}

  private ensureReady(): Promise<void> {
    this.ready ??= this.initialize();
    return this.ready;
  }

  private async initialize(): Promise<void> {
    const existingRoot = await lstat(this.root).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (existingRoot?.isSymbolicLink()) {
      throw new CoeContractError("policy_violation", "Registry root must not be a symbolic link");
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.canonicalRoot = await realpath(this.root);
    await this.assertPrivateDirectory(this.canonicalRoot, "registry root");
    for (const directory of ["objects", "records/sources", "records/snapshots", "records/events", "journal", "staging", "locks"]) {
      await this.ensureDirectoryChain(directory, true, `registry directory ${directory}`);
    }
    this.leaseDatabasePath = resolve(this.canonicalRoot, "locks", "leases.sqlite");
    const existingLeaseDatabase = await lstat(this.leaseDatabasePath).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (existingLeaseDatabase && (existingLeaseDatabase.isSymbolicLink() || !existingLeaseDatabase.isFile())) {
      throw new CoeContractError("policy_violation", "Registry lease database must be a regular non-symlink file");
    }
    const database = new Database(this.leaseDatabasePath, { create: true, strict: true });
    try {
      database.exec("PRAGMA busy_timeout = 1000");
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec("PRAGMA synchronous = FULL");
      const schemaVersion = database.query("PRAGMA user_version").get() as { user_version: number };
      if (schemaVersion.user_version !== 0 && schemaVersion.user_version !== 1) {
        throw new CoeContractError(
          "policy_violation",
          `Unsupported registry lease database version ${schemaVersion.user_version}`,
        );
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS registry_lock_leases (
          name TEXT PRIMARY KEY NOT NULL CHECK (length(name) = 64),
          owner_id TEXT NOT NULL,
          hostname TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          boot_id TEXT NOT NULL,
          pid_namespace TEXT NOT NULL,
          pid INTEGER NOT NULL CHECK (pid > 0),
          process_start_ticks TEXT NOT NULL,
          lease_expires_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        ) STRICT
      `);
      if (schemaVersion.user_version === 0) database.exec("PRAGMA user_version = 1");
    } finally {
      database.close();
    }
    await chmod(this.leaseDatabasePath, 0o600);
  }

  private async assertPrivateDirectory(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new CoeContractError("policy_violation", `${label} must be a real directory`);
    }
    const effectiveUid = process.geteuid?.();
    if (effectiveUid !== undefined && metadata.uid !== effectiveUid) {
      throw new CoeContractError("policy_violation", `${label} must be owned by the current user`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new CoeContractError("policy_violation", `${label} must not grant group or world access`);
    }
  }

  private async ensureDirectoryChain(relativePath: string, create: boolean, label: string): Promise<void> {
    let cursor = this.canonicalRoot;
    await this.assertPrivateDirectory(cursor, "registry root");
    for (const component of relativePath.split(sep).filter(Boolean)) {
      cursor = resolve(cursor, component);
      const metadata = await lstat(cursor).catch((error) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (!metadata) {
        if (!create) await lstat(cursor);
        try {
          await mkdir(cursor, { mode: 0o700 });
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
      }
      await this.assertPrivateDirectory(cursor, label);
    }
  }

  private async readFileNoFollow(path: string, label: string): Promise<Buffer> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new CoeContractError("policy_violation", `${label} must be a regular non-symlink file`);
    }
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw new CoeContractError("policy_violation", `${label} must remain a regular file`);
      }
      return await handle.readFile();
    } finally {
      await handle?.close();
    }
  }

  private async containedPath(key: string, createParent = false): Promise<string> {
    await this.ensureReady();
    if (!SAFE_KEY.test(key)) throw new CoeContractError("invalid_contract", `Unsafe registry key: ${key}`);
    const path = resolve(this.canonicalRoot, key);
    if (path !== this.canonicalRoot && !path.startsWith(`${this.canonicalRoot}${sep}`)) {
      throw new CoeContractError("invalid_contract", `Registry key escapes root: ${key}`);
    }
    const parent = dirname(path);
    const parentRelative = relative(this.canonicalRoot, parent);
    await this.ensureDirectoryChain(parentRelative, createParent, `registry parent for ${key}`);
    return path;
  }

  private async syncDirectory(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, "r");
      await handle.sync();
    } catch {
      // Some filesystems do not support directory fsync. File fsync and link atomicity still hold.
    } finally {
      await handle?.close();
    }
  }

  async storeObject(data: Uint8Array, expectedHash?: string): Promise<StoredObject> {
    await this.ensureReady();
    const buffer = Buffer.from(data);
    const contentHash = sha256Bytes(buffer);
    if (expectedHash && expectedHash !== contentHash) {
      throw new CoeContractError("hash_mismatch", `Expected ${expectedHash}, received ${contentHash}`);
    }

    const hex = contentHash.slice("sha256:".length);
    const objectKey = `objects/sha256/${hex.slice(0, 2)}/${hex}`;
    const finalPath = await this.containedPath(objectKey, true);
    const stagingKey = `staging/${this.nonce().replace(/[^A-Za-z0-9._-]/g, "_")}.part`;
    const stagingPath = await this.containedPath(stagingKey, true);
    const stagingHandle = await open(stagingPath, "wx", 0o600);
    try {
      await stagingHandle.writeFile(buffer);
      await stagingHandle.sync();
    } finally {
      await stagingHandle.close();
    }

    const staged = await this.readFileNoFollow(stagingPath, "staged object");
    if (sha256Bytes(staged) !== contentHash) {
      await unlink(stagingPath).catch(() => undefined);
      throw new CoeContractError("hash_mismatch", "Staged bytes failed post-write hash verification");
    }

    let created = false;
    try {
      await link(stagingPath, finalPath);
      created = true;
      await this.syncDirectory(dirname(finalPath));
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await this.readFileNoFollow(finalPath, "content-addressed object");
      if (sha256Bytes(existing) !== contentHash) {
        throw new CoeContractError("hash_mismatch", "Existing content-addressed object is corrupt");
      }
    } finally {
      await unlink(stagingPath).catch(() => undefined);
    }

    return { content_hash: contentHash, object_key: objectKey, byte_size: buffer.byteLength, created };
  }

  async writeJsonOnce(key: string, value: unknown): Promise<"created" | "existing"> {
    const serialized = Buffer.from(`${canonicalizeJson(value)}\n`, "utf8");
    const finalPath = await this.containedPath(key, true);
    const keyHash = sha256Bytes(Buffer.from(key, "utf8")).slice("sha256:".length, "sha256:".length + 16);
    const tempKey = `staging/json-${keyHash}-${this.nonce().replace(/[^A-Za-z0-9._-]/g, "_")}.part`;
    const tempPath = await this.containedPath(tempKey, true);
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(tempPath, finalPath);
      await this.syncDirectory(dirname(finalPath));
      return "created";
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await this.readFileNoFollow(finalPath, `canonical key ${key}`);
      if (!existing.equals(serialized)) {
        throw new CoeContractError("id_mismatch", `Canonical key ${key} already maps to different content`);
      }
      return "existing";
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  async readJson(key: string): Promise<unknown> {
    const path = await this.containedPath(key);
    return JSON.parse((await this.readFileNoFollow(path, `canonical key ${key}`)).toString("utf8"));
  }

  async readObject(key: string, expectedHash: string): Promise<Buffer> {
    const path = await this.containedPath(key);
    const bytes = await this.readFileNoFollow(path, `raw object ${key}`);
    const actualHash = sha256Bytes(bytes);
    if (actualHash !== expectedHash) {
      throw new CoeContractError("hash_mismatch", `Raw object ${key} expected ${expectedHash}, received ${actualHash}`);
    }
    return bytes;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await lstat(await this.containedPath(key));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const start = await this.containedPath(prefix);
    try {
      await stat(start);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const output: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) output.push(relative(this.canonicalRoot, path).split(sep).join("/"));
      }
    };
    await walk(start);
    return output.sort();
  }

  async cleanupStaging(cutoff: Date): Promise<number> {
    const keys = await this.listKeys("staging");
    let removed = 0;
    for (const key of keys) {
      if (!key.endsWith(".part")) continue;
      const path = await this.containedPath(key);
      const metadata = await stat(path);
      if (metadata.mtime.getTime() >= cutoff.getTime()) continue;
      await unlink(path);
      removed += 1;
    }
    return removed;
  }

  private lockConfig(): RegistryLockConfig {
    const timeoutMs = this.options.lock_timeout_ms ?? 10_000;
    const leaseMs = this.options.lock_lease_ms ?? 30_000;
    const retryMs = this.options.lock_retry_ms ?? 10;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new CoeContractError("invalid_contract", "Registry lock timeout must be between 1 and 60000 ms");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30 || leaseMs > 3_600_000) {
      throw new CoeContractError("invalid_contract", "Registry lock lease must be between 30 and 3600000 ms");
    }
    if (!Number.isSafeInteger(retryMs) || retryMs <= 0 || retryMs > 1_000 || retryMs >= leaseMs) {
      throw new CoeContractError("invalid_contract", "Registry lock retry must be positive, at most 1000 ms, and shorter than the lease");
    }
    return { timeout_ms: timeoutMs, lease_ms: leaseMs, retry_ms: retryMs };
  }

  private lockNow(): number {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new CoeContractError("policy_violation", "System clock cannot represent registry lock milliseconds safely");
    }
    return now;
  }

  private leaseExpiresAt(now: number, leaseMs: number): number {
    const expiresAt = now + leaseMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new CoeContractError("invalid_contract", "Registry lock lease expiration exceeds safe integer milliseconds");
    }
    return expiresAt;
  }

  private validateProcessIdentity(identity: RegistryLockProcessIdentity): RegistryLockProcessIdentity {
    if (
      !identity.hostname
      || !identity.machine_id
      || !identity.boot_id
      || !identity.pid_namespace
      || !Number.isSafeInteger(identity.pid)
      || identity.pid <= 0
      || !identity.process_start_ticks
    ) {
      throw new CoeContractError("invalid_contract", "Registry lock process identity is incomplete");
    }
    return identity;
  }

  private withLeaseDatabase<T>(operation: (database: Database) => T): T {
    const database = new Database(this.leaseDatabasePath, { create: false, strict: true });
    try {
      database.exec("PRAGMA busy_timeout = 10");
      return operation(database);
    } finally {
      database.close();
    }
  }

  private readLease(name: string): RegistryLockRow | null {
    return this.withLeaseDatabase((database) =>
      database.query(`
        SELECT name, owner_id, hostname, machine_id, boot_id, pid_namespace, pid, process_start_ticks,
               lease_expires_at_ms, updated_at_ms
        FROM registry_lock_leases
        WHERE name = ?
      `).get(name) as RegistryLockRow | null,
    );
  }

  private async currentProcessIdentity(): Promise<RegistryLockProcessIdentity> {
    try {
      const [machineId, bootId, pidNamespace, processStat] = await Promise.all([
        readFile("/etc/machine-id", "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readlink("/proc/self/ns/pid"),
        readFile(`/proc/${process.pid}/stat`, "utf8"),
      ]);
      const parsedProcess = parseProcessStat(processStat);
      if (!parsedProcess) {
        throw new CoeContractError("policy_violation", "Cannot determine registry lock process start identity");
      }
      return {
        hostname: hostname(),
        machine_id: machineId.trim(),
        boot_id: bootId.trim(),
        pid_namespace: pidNamespace,
        pid: process.pid,
        process_start_ticks: parsedProcess.start_ticks,
      };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return {
        hostname: hostname(),
        machine_id: "unknown",
        boot_id: "portable-pid-only",
        pid_namespace: "unknown",
        pid: process.pid,
        process_start_ticks: "unknown",
      };
    }
  }

  private async ownerLiveness(owner: RegistryLockProcessIdentity): Promise<RegistryLockOwnerLiveness> {
    if (owner.boot_id === "portable-pid-only") {
      if (owner.hostname !== hostname()) return "unknown";
      try {
        process.kill(owner.pid, 0);
        return "alive";
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) {
          if (error.code === "ESRCH") return "dead";
          if (error.code === "EPERM") return "unknown";
        }
        return "unknown";
      }
    }
    let machineId: string;
    let bootId: string;
    let pidNamespace: string;
    try {
      [machineId, bootId, pidNamespace] = await Promise.all([
        readFile("/etc/machine-id", "utf8").then((value) => value.trim()),
        readFile("/proc/sys/kernel/random/boot_id", "utf8").then((value) => value.trim()),
        readlink("/proc/self/ns/pid"),
      ]);
    } catch {
      return "unknown";
    }
    if (owner.machine_id !== machineId || owner.pid_namespace !== pidNamespace) return "unknown";
    if (owner.boot_id !== bootId) return "dead";
    try {
      const processStat = await readFile(`/proc/${owner.pid}/stat`, "utf8");
      const parsedProcess = parseProcessStat(processStat);
      if (!parsedProcess) return "unknown";
      if (parsedProcess.start_ticks !== owner.process_start_ticks) return "dead";
      return parsedProcess.state === "Z" || parsedProcess.state === "X" ? "dead" : "alive";
    } catch (error) {
      return isMissing(error) ? "dead" : "unknown";
    }
  }

  private insertLease(
    name: string,
    ownerId: string,
    identity: RegistryLockProcessIdentity,
    expiresAt: number,
    now: number,
  ): boolean {
    const result = this.withLeaseDatabase((database) => database.run(
      `INSERT OR IGNORE INTO registry_lock_leases (
        name, owner_id, hostname, machine_id, boot_id, pid_namespace, pid, process_start_ticks,
        lease_expires_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        ownerId,
        identity.hostname,
        identity.machine_id,
        identity.boot_id,
        identity.pid_namespace,
        identity.pid,
        identity.process_start_ticks,
        expiresAt,
        now,
      ],
    ));
    return result.changes === 1;
  }

  private replaceExpiredLease(
    previous: RegistryLockRow,
    ownerId: string,
    identity: RegistryLockProcessIdentity,
    expiresAt: number,
    now: number,
  ): boolean {
    const result = this.withLeaseDatabase((database) => database.run(
      `UPDATE registry_lock_leases
       SET owner_id = ?, hostname = ?, machine_id = ?, boot_id = ?, pid_namespace = ?, pid = ?, process_start_ticks = ?,
           lease_expires_at_ms = ?, updated_at_ms = ?
       WHERE name = ? AND owner_id = ? AND lease_expires_at_ms = ?`,
      [
        ownerId,
        identity.hostname,
        identity.machine_id,
        identity.boot_id,
        identity.pid_namespace,
        identity.pid,
        identity.process_start_ticks,
        expiresAt,
        now,
        previous.name,
        previous.owner_id,
        previous.lease_expires_at_ms,
      ],
    ));
    return result.changes === 1;
  }

  private renewLease(name: string, ownerId: string, expiresAt: number, now: number): boolean {
    const result = this.withLeaseDatabase((database) => database.run(
      `UPDATE registry_lock_leases
       SET lease_expires_at_ms = ?, updated_at_ms = ?
       WHERE name = ? AND owner_id = ?`,
      [expiresAt, now, name, ownerId],
    ));
    return result.changes === 1;
  }

  private releaseLease(name: string, ownerId: string): void {
    this.withLeaseDatabase((database) => {
      database.run("DELETE FROM registry_lock_leases WHERE name = ? AND owner_id = ?", [name, ownerId]);
    });
  }

  private async legacyLockBlocks(name: string): Promise<boolean> {
    const path = await this.containedPath(`locks/${name}.lock`, true);
    const readExisting = async (): Promise<boolean> => {
      try {
        const contents = await this.readFileNoFollow(path, `registry lock compatibility sentinel ${name}`);
        return contents.toString("utf8") !== SQLITE_LEASE_SENTINEL;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    };

    if (await readExisting()) return true;
    try {
      await lstat(path);
      return readExisting();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const tempPath = await this.containedPath(`staging/lock-sentinel-${randomUUID()}.part`, true);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(SQLITE_LEASE_SENTINEL, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(tempPath, path);
        return false;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        return readExisting();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
    }
  }

  async withLock<T>(name: string, operation: (lease: RegistryLockLease) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{64}$/.test(name)) {
      throw new CoeContractError("invalid_contract", "Registry lock names must be SHA-256 hex values");
    }
    await this.ensureReady();
    const config = this.lockConfig();
    const identity = this.validateProcessIdentity(await this.currentProcessIdentity());
    const ownerId = randomUUID();
    if (!ownerId || ownerId.length > 256) {
      throw new CoeContractError("invalid_contract", "Registry lock owner IDs must contain between 1 and 256 characters");
    }
    const deadline = performance.now() + config.timeout_ms;
    let acquired = false;

    while (!acquired) {
      try {
        if (!(await this.legacyLockBlocks(name))) {
          const now = this.lockNow();
          const expiresAt = this.leaseExpiresAt(now, config.lease_ms);
          const current = this.readLease(name);
          if (!current) {
            acquired = this.insertLease(name, ownerId, identity, expiresAt, now);
          } else if (current.lease_expires_at_ms <= now) {
            const liveness = await this.ownerLiveness(current);
            if (liveness === "dead") {
              acquired = this.replaceExpiredLease(current, ownerId, identity, expiresAt, now);
            }
          }
        }
      } catch (error) {
        if (!isDatabaseBusy(error)) throw error;
      }
      if (acquired) break;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        throw new CoeContractError("policy_violation", `Timed out acquiring registry lock ${name}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(config.retry_ms, remainingMs)));
    }

    const controller = new AbortController();
    let leaseError: CoeContractError | null = null;
    const loseLease = (message: string) => {
      leaseError ??= new CoeContractError("policy_violation", message);
      if (!controller.signal.aborted) controller.abort(leaseError);
    };
    const assertOwned = async (): Promise<void> => {
      const current = this.readLease(name);
      if (current?.owner_id !== ownerId) {
        loseLease(`Lost registry lock lease ${name}`);
      }
      if (leaseError) throw leaseError;
    };
    const lease: RegistryLockLease = {
      owner_id: ownerId,
      signal: controller.signal,
      assertOwned,
    };
    let heartbeatChain = Promise.resolve();
    const heartbeat = () => {
      heartbeatChain = heartbeatChain.then(() => {
        if (leaseError) return;
        try {
          const now = this.lockNow();
          if (!this.renewLease(name, ownerId, this.leaseExpiresAt(now, config.lease_ms), now)) {
            loseLease(`Lost registry lock lease ${name} during renewal`);
          }
        } catch (error) {
          if (isDatabaseBusy(error)) return;
          loseLease(`Failed to renew registry lock lease ${name}`);
        }
      });
    };
    const heartbeatTimer = setInterval(heartbeat, Math.max(10, Math.floor(config.lease_ms / 3)));
    heartbeatTimer.unref?.();

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation(lease);
    } catch (error) {
      operationError = error;
    } finally {
      clearInterval(heartbeatTimer);
      await heartbeatChain;
    }

    if (!operationError) {
      try {
        await assertOwned();
      } catch (error) {
        operationError = error;
      }
    }
    try {
      this.releaseLease(name, ownerId);
    } catch (error) {
      if (!operationError) operationError = error;
    }
    if (operationError) throw operationError;
    return result as T;
  }
}
