import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { CoeContractError, canonicalizeJson, sha256Bytes } from "../contracts/index.ts";

const SAFE_KEY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
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

export interface ContentAddressedStoreOptions {
  lock_timeout_ms?: number;
}

export class ContentAddressedStore {
  private ready: Promise<void> | undefined;
  private canonicalRoot = "";

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

  async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{64}$/.test(name)) {
      throw new CoeContractError("invalid_contract", "Registry lock names must be SHA-256 hex values");
    }
    const key = `locks/${name}.lock`;
    const path = await this.containedPath(key, true);
    const token = this.nonce();
    const lockTimeoutMs = this.options.lock_timeout_ms ?? 10_000;
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs <= 0 || lockTimeoutMs > 60_000) {
      throw new CoeContractError("invalid_contract", "Registry lock timeout must be between 1 and 60000 ms");
    }
    const deadline = Date.now() + lockTimeoutMs;
    let acquired = false;

    while (!acquired) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(token, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        acquired = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (Date.now() >= deadline) {
          throw new CoeContractError("policy_violation", `Timed out acquiring registry lock ${name}`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }

    try {
      return await operation();
    } finally {
      const owner = await this.readFileNoFollow(path, `registry lock ${name}`)
        .then((bytes) => bytes.toString("utf8"))
        .catch(() => null);
      if (owner === token) await unlink(path).catch(() => undefined);
    }
  }
}
