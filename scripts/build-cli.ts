import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { which } from "bun";

function executableCandidate(label: "git" | "tar"): string {
  const windowsRoots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const systemCandidates = process.platform === "win32"
    ? windowsRoots.flatMap((root) => label === 'git'
      ? [join(root, 'Git', 'cmd', 'git.exe'), join(root, 'Git', 'bin', 'git.exe')]
      : [join(root, 'Git', 'usr', 'bin', 'tar.exe')])
    : [`/usr/bin/${label}`, `/opt/homebrew/bin/${label}`, `/usr/local/bin/${label}`];
  const candidate = systemCandidates.find((path) => {
    try { return lstatSync(path).isFile(); } catch { return false; }
  }) ?? (process.platform === 'win32' ? null : which(label));
  if (!candidate) throw new Error(`no se encontró ${label} en este sistema`);
  return candidate;
}

function trustedExecutable(candidate: string, label: string): string {
  const executable = realpathSync(candidate);
  const stat = lstatSync(executable);
  const trustedOwner = process.platform === "win32"
    || stat.uid === 0
    || stat.uid === process.getuid?.();
  if (!stat.isFile() || !trustedOwner || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) {
    throw new Error(`${label} no es un ejecutable protegido: ${executable}`);
  }
  accessSync(executable, constants.X_OK);
  return executable;
}

const GIT = trustedExecutable(executableCandidate("git"), "Git");
const TAR = trustedExecutable(executableCandidate("tar"), "tar");

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !name.startsWith("GIT_")
      && !name.startsWith("DYLD_")
      && name !== "LD_PRELOAD"
      && name !== "LD_LIBRARY_PATH"
      && name !== "BUN_OPTIONS"
      && name !== "NODE_OPTIONS"
    ) {
      env[name] = value;
    }
  }
  return {
    ...env,
    PATH: process.platform === "win32"
      ? (process.env.PATH ?? "")
      : [...new Set([dirname(GIT), dirname(TAR), "/usr/bin", "/bin"])].join(":"),
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

const SAFE_ENV = cleanEnvironment();
const GIT_PREFIX = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

function git(cwd: string, args: string[], options: { encoding?: "utf8" | "buffer"; maxBuffer?: number } = {}): string | Buffer {
  return execFileSync(GIT, [...GIT_PREFIX, "-C", cwd, ...args], {
    encoding: options.encoding ?? "utf8",
    env: SAFE_ENV,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitText(cwd: string, args: string[]): string {
  return (git(cwd, args, { encoding: "utf8" }) as string).trim();
}

function assertInside(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`${label} queda fuera del repositorio esperado`);
}

function hashPath(hash: ReturnType<typeof createHash>, root: string, relativePath: string): void {
  const absolutePath = join(root, relativePath);
  const stat = lstatSync(absolutePath);
  hash.update(relativePath.replaceAll(sep, "/"));
  hash.update("\0");
  hash.update(String(stat.mode & 0o7777));
  hash.update("\0");
  if (stat.isSymbolicLink()) {
    hash.update("link\0");
    hash.update(readlinkSync(absolutePath));
  } else if (stat.isFile()) {
    hash.update("file\0");
    hash.update(readFileSync(absolutePath));
  } else if (stat.isDirectory()) {
    hash.update("directory\0");
  } else {
    throw new Error(`tipo de archivo no admitido: ${relativePath}`);
  }
  hash.update("\0");
}

function hashTrackedWorktree(repoRoot: string): string {
  const listed = git(repoRoot, ["ls-files", "-z", "--cached"], { encoding: "buffer" }) as Buffer;
  const paths = listed.toString("utf8").split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const path of paths) hashPath(hash, repoRoot, path);
  return hash.digest("hex");
}

function hashSnapshot(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = directory ? join(directory, entry.name) : entry.name;
      if (path === "node_modules") continue;
      hashPath(hash, root, path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk("");
  return hash.digest("hex");
}

type RepositoryState = {
  commit: string;
  indexTree: string;
  worktreeHash: string;
};

function readCleanState(repoRoot: string): RepositoryState {
  const status = git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" }) as Buffer;
  if (status.length !== 0) {
    throw new Error("el build exige un árbol limpio, sin cambios preparados, rastreados ni archivos no rastreados");
  }
  const commit = gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("HEAD no devolvió un SHA-1 completo en minúsculas");
  }
  git(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  return {
    commit,
    indexTree: gitText(repoRoot, ["write-tree"]),
    worktreeHash: hashTrackedWorktree(repoRoot),
  };
}

function assertSameState(repoRoot: string, expected: RepositoryState): void {
  const actual = readCleanState(repoRoot);
  if (actual.commit !== expected.commit) throw new Error("HEAD cambió durante el build");
  if (actual.indexTree !== expected.indexTree) throw new Error("el índice cambió durante el build");
  if (actual.worktreeHash !== expected.worktreeHash) throw new Error("los archivos rastreados cambiaron durante el build");
}

const [outfileArgument, target] = process.argv.slice(2);
if (!outfileArgument) {
  throw new Error("uso: bun scripts/build-cli.ts <outfile> [target]");
}

const scriptDirectory = realpathSync(import.meta.dir);
const repoRoot = realpathSync(gitText(scriptDirectory, ["rev-parse", "--show-toplevel"]));
assertInside(repoRoot, scriptDirectory, "el script de build");
const scriptPath = relative(repoRoot, join(scriptDirectory, "build-cli.ts")).replaceAll(sep, "/");
git(repoRoot, ["ls-files", "--error-unmatch", "--", scriptPath]);

const commonDirectoryRaw = gitText(repoRoot, ["rev-parse", "--git-common-dir"]);
const commonDirectory = realpathSync(isAbsolute(commonDirectoryRaw) ? commonDirectoryRaw : resolve(repoRoot, commonDirectoryRaw));
const lockPath = join(commonDirectory, "gbrain-build.lock");
const lockToken = randomUUID();
let lockDescriptor: number | undefined;
let lockAcquired = false;
let temporaryRoot: string | undefined;
let stagedOutput: string | undefined;

interface BuildLockRecord {
  pid: number;
  started_at: string;
  token: string;
}

function readBuildLock(path: string): BuildLockRecord {
  const stat = lstatSync(path);
  const trustedOwner = process.platform === "win32"
    || stat.uid === 0
    || stat.uid === process.getuid?.();
  if (!stat.isFile() || !trustedOwner || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) {
    throw new Error(`el bloqueo existente no es un archivo protegido: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BuildLockRecord>;
  if (
    !Number.isSafeInteger(parsed.pid)
    || Number(parsed.pid) <= 0
    || typeof parsed.started_at !== "string"
    || !Number.isFinite(Date.parse(parsed.started_at))
    || typeof parsed.token !== "string"
    || !/^[a-zA-Z0-9-]{8,128}$/.test(parsed.token)
  ) {
    throw new Error(`el bloqueo existente tiene un formato inválido: ${path}`);
  }
  return parsed as BuildLockRecord;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireBuildLock(path: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lockDescriptor = openSync(path, "wx", 0o600);
      const record: BuildLockRecord = {
        pid: process.pid,
        started_at: new Date().toISOString(),
        token: lockToken,
      };
      writeFileSync(lockDescriptor, `${JSON.stringify(record)}\n`);
      closeSync(lockDescriptor);
      lockDescriptor = undefined;
      lockAcquired = true;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = readBuildLock(path);
      if (processIsAlive(record.pid)) {
        throw new Error(`otro build conserva el bloqueo ${path}`);
      }
      const unchanged = readBuildLock(path);
      if (JSON.stringify(unchanged) !== JSON.stringify(record)) {
        throw new Error(`el bloqueo cambió durante la recuperación: ${path}`);
      }
      unlinkSync(path);
    }
  }
  throw new Error(`no se pudo adquirir el bloqueo ${path}`);
}

try {
  try {
    acquireBuildLock(lockPath);
  } catch (error) {
    throw new Error(`otro build conserva el bloqueo ${lockPath}`, { cause: error });
  }

  const initialState = readCleanState(repoRoot);
  temporaryRoot = mkdtempSync(join(tmpdir(), "gbrain-build-snapshot-"));
  chmodSync(temporaryRoot, 0o700);
  const archivePath = join(temporaryRoot, "source.tar");
  const snapshotRoot = join(temporaryRoot, "source");
  mkdirSync(snapshotRoot, { mode: 0o700 });

  git(repoRoot, ["archive", "--format=tar", `--output=${archivePath}`, initialState.commit], { maxBuffer: 1024 * 1024 * 1024 });
  const extract = spawnSync(TAR, ["-xf", archivePath, "-C", snapshotRoot], {
    env: SAFE_ENV,
    encoding: "utf8",
  });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error(`no se pudo extraer la instantánea: ${extract.stderr}`);
  unlinkSync(archivePath);

  const snapshotHash = hashSnapshot(snapshotRoot);
  const dependencies = join(repoRoot, "node_modules");
  try {
    if (lstatSync(dependencies).isDirectory()) {
      symlinkSync(dependencies, join(snapshotRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  assertSameState(repoRoot, initialState);
  const outfile = resolve(process.cwd(), outfileArgument);
  mkdirSync(dirname(outfile), { recursive: true });
  const buildOutput = join(temporaryRoot, "compiled-cli");
  const args = ["build", "--compile", "--outfile", buildOutput];
  if (target) args.push("--target", target);
  args.push("--define", `__GBRAIN_BUILD_COMMIT__=${JSON.stringify(initialState.commit)}`, "src/cli.ts");

  console.error("[build-cli] compilando instantánea verificada");
  const result = spawnSync(process.execPath, args, {
    cwd: snapshotRoot,
    env: SAFE_ENV,
    stdio: "inherit",
  });

  if (hashSnapshot(snapshotRoot) !== snapshotHash) {
    throw new Error("la instantánea de fuentes cambió durante la compilación");
  }
  assertSameState(repoRoot, initialState);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Bun no pudo compilar la instantánea (salida ${result.status ?? 1})`);
  stagedOutput = `${outfile}.tmp-${process.pid}`;
  copyFileSync(buildOutput, stagedOutput);
  renameSync(stagedOutput, outfile);
  stagedOutput = undefined;
} finally {
  if (lockDescriptor !== undefined) closeSync(lockDescriptor);
  if (stagedOutput !== undefined) rmSync(stagedOutput, { force: true });
  if (temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true });
  if (lockAcquired) {
    try {
      if (readBuildLock(lockPath).token === lockToken) unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
