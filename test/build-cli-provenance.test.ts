import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { which } from "bun";

const gitExecutable = which("git");
if (!gitExecutable) throw new Error("Git is required for build provenance tests");
const GIT: string = gitExecutable;
const BUN = process.execPath;
const buildScript = join(import.meta.dir, "..", "scripts", "build-cli.ts");
const temporaryPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync(GIT, args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.platform === "win32" ? (process.env.PATH ?? "") : "/usr/bin:/bin",
      HOME: temporaryDirectory("gbrain-build-home-"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepository(moduleCount = 0): { root: string; commit: string; output: string } {
  const root = temporaryDirectory("gbrain-build-repo-");
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  cpSync(buildScript, join(root, "scripts", "build-cli.ts"));
  writeFileSync(join(root, ".gitignore"), "bin/\n");
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');

  const imports: string[] = [];
  for (let index = 0; index < moduleCount; index += 1) {
    const name = `module-${index}.ts`;
    writeFileSync(join(root, "src", name), `export const value${index} = ${index};\n`);
    imports.push(`import { value${index} } from "./${name}";`);
  }
  writeFileSync(
    join(root, "src", "cli.ts"),
    `${imports.join("\n")}\ndeclare const __GBRAIN_BUILD_COMMIT__: string;\nconsole.log(__GBRAIN_BUILD_COMMIT__);\n`,
  );

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "build-test@example.invalid"]);
  git(root, ["config", "user.name", "Build Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return {
    root,
    commit: git(root, ["rev-parse", "HEAD"]),
    output: join(root, "bin", "gbrain"),
  };
}

function runBuild(root: string, output: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(BUN, ["run", "scripts/build-cli.ts", output], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 120_000,
  });
}

function runBinary(path: string): string {
  const result = spawnSync(path, [], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("procedencia del build CLI", () => {
  test("ignora un git falso al principio de PATH", () => {
    if (process.platform === "win32") return;
    const repo = createRepository();
    const fakeBin = temporaryDirectory("gbrain-fake-git-");
    const marker = join(fakeBin, "invoked");
    writeFileSync(join(fakeBin, "git"), `#!/bin/sh\ntouch '${marker}'\nprintf '%040d\\n' 0\n`);
    chmodSync(join(fakeBin, "git"), 0o755);

    const result = runBuild(repo.root, repo.output, { PATH: `${fakeBin}:/usr/bin:/bin` });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(runBinary(repo.output)).toBe(repo.commit);
  }, 120_000);

  test("ignora GIT_DIR heredado y usa el repositorio del script", () => {
    const repo = createRepository();
    const other = createRepository();
    git(other.root, ["commit", "--allow-empty", "-qm", "different head"]);

    const result = runBuild(repo.root, repo.output, { GIT_DIR: join(other.root, ".git") });

    expect(result.status, result.stderr).toBe(0);
    expect(runBinary(repo.output)).toBe(repo.commit);
  }, 120_000);

  test("rechaza cambios rastreados y no rastreados", () => {
    const tracked = createRepository();
    writeFileSync(join(tracked.root, "src", "cli.ts"), "console.log('dirty');\n");
    const dirtyResult = runBuild(tracked.root, tracked.output);
    expect(dirtyResult.status).not.toBe(0);

    const untracked = createRepository();
    writeFileSync(join(untracked.root, "src", "rogue.ts"), "export {};\n");
    const untrackedResult = runBuild(untracked.root, untracked.output);
    expect(untrackedResult.status).not.toBe(0);
  }, 120_000);

  test("rechaza un archivo que cambia mientras compila", async () => {
    const repo = createRepository(800);
    const child = spawn(BUN, ["run", "scripts/build-cli.ts", repo.output], {
      cwd: repo.root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const deadline = Date.now() + 30_000;
    while (!stderr.includes("[build-cli] compilando instantánea verificada")) {
      if (child.exitCode !== null) break;
      if (Date.now() > deadline) throw new Error(`no apareció la señal de compilación: ${stderr}`);
      await Bun.sleep(2);
    }
    if (child.exitCode === null) {
      writeFileSync(join(repo.root, "src", "module-0.ts"), "export const value0 = 999;\n");
    }

    const status = child.exitCode !== null
      ? child.exitCode
      : await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(status, `${stdout}\n${stderr}`).not.toBe(0);
  }, 120_000);

  test("rechaza cambios de HEAD y del índice durante la compilación", async () => {
    for (const mutation of ["head", "index"] as const) {
      const repo = createRepository(800);
      const child = spawn(BUN, ["run", "scripts/build-cli.ts", repo.output], {
        cwd: repo.root,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });

      const deadline = Date.now() + 30_000;
      while (!stderr.includes("[build-cli] compilando instantánea verificada")) {
        if (child.exitCode !== null) break;
        if (Date.now() > deadline) throw new Error(`no apareció la señal de compilación: ${stderr}`);
        await Bun.sleep(2);
      }
      if (mutation === "head") {
        git(repo.root, ["commit", "--allow-empty", "-qm", "concurrent head"]);
      } else {
        writeFileSync(join(repo.root, "src", "staged.ts"), "export {};\n");
        git(repo.root, ["add", "src/staged.ts"]);
      }

      const status = child.exitCode !== null
        ? child.exitCode
        : await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(status, `${mutation}\n${stdout}\n${stderr}`).not.toBe(0);
    }
  }, 120_000);

  test("respeta un bloqueo existente sin eliminarlo", () => {
    const repo = createRepository();
    const lock = join(repo.root, ".git", "gbrain-build.lock");
    writeFileSync(lock, "owner\n");

    const result = runBuild(repo.root, repo.output);

    expect(result.status).not.toBe(0);
    expect(readFileSync(lock, "utf8")).toBe("owner\n");
  }, 120_000);

  test("conserva el build normal para un commit limpio", () => {
    const repo = createRepository();

    const result = runBuild(repo.root, repo.output);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(repo.output).byteLength).toBeGreaterThan(0);
    expect(runBinary(repo.output)).toBe(repo.commit);
  }, 120_000);
});
