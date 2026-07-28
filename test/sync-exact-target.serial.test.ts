/**
 * Paired exact-target sync must bind both planning and import reads to one
 * immutable Git commit. These tests deliberately change the live worktree
 * after the paired plan has been captured and before import begins.
 *
 * This file is serial because it temporarily intercepts console.error phase
 * breadcrumbs and scans the process temp directory for the private target-tree
 * materialization owned by the in-flight sync.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { PGLiteEngine } from "../src/core/pglite-engine.ts";
import { recordCompleted, syncFingerprint } from "../src/core/op-checkpoint.ts";
import { resetPgliteState } from "./helpers/reset-pglite.ts";

const TARGET_TREE_PREFIX = "gbrain-target-tree-";

let engine: PGLiteEngine;
let repoPath: string;
const extraRepos: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(prefix: string): string {
  const repo = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@test.com"]);
  git(repo, ["config", "user.name", "Test"]);
  return repo;
}

function page(title: string, body: string): string {
  return ["---", "type: concept", `title: ${title}`, "---", "", body, ""].join(
    "\n",
  );
}

function write(repo: string, relativePath: string, content: string): void {
  const absolutePath = join(repo, relativePath);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, content);
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function commitAt(repo: string, message: string, timestamp: string): string {
  git(repo, ["add", "-A"]);
  execFileSync("git", ["commit", "-m", message], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return git(repo, ["rev-parse", "HEAD"]);
}

async function registerSource(sourceId: string, repo: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, $2, '{}'::jsonb)`,
    [sourceId, repo],
  );
}

async function sourceBookmark(sourceId: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0]?.last_commit ?? null;
}

function findMaterializedTarget(
  relativePath: string,
  exactContent: string,
): string | null {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(TARGET_TREE_PREFIX)) continue;
    const root = join(tmpdir(), name);
    const candidate = join(root, relativePath);
    if (!existsSync(candidate)) continue;
    try {
      if (readFileSync(candidate, "utf8") === exactContent) return root;
    } catch {
      // A concurrent cleanup can remove a candidate between readdir and read.
    }
  }
  return null;
}

async function atLoadPhase<T>(
  callback: () => void,
  operation: () => Promise<T>,
): Promise<{ result: T; phaseObserved: boolean }> {
  const originalError = console.error;
  let phaseObserved = false;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (
      !phaseObserved &&
      line.includes("[gbrain phase] sync.load_active_pack")
    ) {
      phaseObserved = true;
      callback();
    }
    originalError(...args);
  };
  try {
    return {
      result: await operation(),
      phaseObserved,
    };
  } finally {
    console.error = originalError;
  }
}

async function seedNamedSource(
  sourceId: string,
  repo: string,
): Promise<string> {
  const { performSync } = await import("../src/commands/sync.ts");
  const result = await performSync(engine, {
    sourceId,
    repoPath: repo,
    strategy: "markdown",
    noPull: true,
    noEmbed: true,
    noExtract: true,
  });
  expect(result.status).toBe("first_sync");
  const bookmark = await sourceBookmark(sourceId);
  expect(bookmark).not.toBeNull();
  return bookmark!;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  repoPath = initRepo("gbrain-exact-target");
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
  for (const repo of extraRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("paired exact-target immutable tree", () => {
  test("paired source without --repo pins the resolved registered path across repeated preflights", async () => {
    const { performSync, SyncPreconditionError } = await import(
      "../src/commands/sync.ts"
    );
    const sourceId = `exact-source-path-${randomUUID()}`;
    write(repoPath, "notes/base.md", page("Base", "registered source body"));
    const target = commit(repoPath, "registered source target");
    await registerSource(sourceId, repoPath);

    const replacementPath = initRepo("gbrain-replaced-source-path");
    extraRepos.push(replacementPath);
    write(
      replacementPath,
      "notes/replacement.md",
      page("Replacement", "must never be planned"),
    );
    commit(replacementPath, "replacement path target");

    const originalExecuteRaw = engine.executeRaw.bind(engine);
    let pathChangedAfterResolution = false;
    engine.executeRaw = (async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
      opts?: { signal?: AbortSignal },
    ): Promise<T[]> => {
      const rows = await originalExecuteRaw<T>(sql, params, opts);
      if (
        !pathChangedAfterResolution &&
        sql.includes("SELECT local_path AS value FROM sources WHERE id = $1") &&
        params?.[0] === sourceId
      ) {
        pathChangedAfterResolution = true;
        await originalExecuteRaw(
          `UPDATE sources SET local_path = $1 WHERE id = $2`,
          [replacementPath, sourceId],
        );
      }
      return rows;
    }) as typeof engine.executeRaw;

    try {
      await expect(
        performSync(engine, {
          sourceId,
          strategy: "markdown",
          dryRun: true,
          noPull: true,
          noEmbed: true,
          noExtract: true,
          expectedTarget: target,
          expectedBookmark: null,
          requireClean: true,
        }),
      ).rejects.toMatchObject({
        name: SyncPreconditionError.name,
        reasonCode: "source_changed",
      });
    } finally {
      engine.executeRaw = originalExecuteRaw;
    }

    expect(pathChangedAfterResolution).toBe(true);
    expect(await sourceBookmark(sourceId)).toBeNull();
    expect(
      await engine.getPage("notes/base", {
        sourceId,
      }),
    ).toBeNull();
    expect(
      await engine.getPage("notes/replacement", {
        sourceId,
      }),
    ).toBeNull();
  }, 60_000);

  test("incremental apply imports target-commit bytes, not a later dirty worktree, and cleans its snapshot", async () => {
    const { performSync } = await import("../src/commands/sync.ts");
    const sourceId = `exact-incremental-${randomUUID()}`;
    const relativePath = "notes/topic.md";
    const baseline = page("Topic", "baseline body");
    write(repoPath, relativePath, baseline);
    commit(repoPath, "initial");
    await registerSource(sourceId, repoPath);
    const bookmark = await seedNamedSource(sourceId, repoPath);

    const targetMarker = `target commit body ${randomUUID()}`;
    const targetContent = page("Topic", targetMarker);
    write(repoPath, relativePath, targetContent);
    const target = commit(repoPath, "target update");
    const paired = {
      sourceId,
      repoPath,
      strategy: "markdown" as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };
    const preview = await performSync(engine, {
      ...paired,
      dryRun: true,
    });

    const liveMarker = `uncommitted worktree body ${randomUUID()}`;
    let snapshotRoot: string | null = null;
    const { result, phaseObserved } = await atLoadPhase(
      () => {
        snapshotRoot = findMaterializedTarget(relativePath, targetContent);
        write(repoPath, relativePath, page("Topic", liveMarker));
      },
      () =>
        performSync(engine, {
          ...paired,
          expectedPlanDigest: preview.planDigest!,
        }),
    );

    expect(phaseObserved).toBe(true);
    expect(snapshotRoot).not.toBeNull();
    expect(result.status).toBe("blocked_by_failures");
    expect(await sourceBookmark(sourceId)).toBe(bookmark);
    const indexed = await engine.getPage("notes/topic", { sourceId });
    expect(indexed?.compiled_truth).toContain(targetMarker);
    expect(indexed?.compiled_truth).not.toContain(liveMarker);
    expect(existsSync(snapshotRoot!)).toBe(false);
  }, 60_000);

  test("first/full apply imports and timestamps the target commit despite a transient later descendant", async () => {
    const { performSync } = await import("../src/commands/sync.ts");
    const sourceId = `exact-first-${randomUUID()}`;
    const relativePath = "notes/first.md";
    const targetMarker = `first target body ${randomUUID()}`;
    const targetContent = page("First", targetMarker);
    const targetTimestamp = "2024-01-02T03:04:05Z";
    const descendantTimestamp = "2024-02-03T04:05:06Z";
    write(repoPath, relativePath, targetContent);
    const target = commitAt(repoPath, "initial target", targetTimestamp);
    await registerSource(sourceId, repoPath);
    const paired = {
      sourceId,
      repoPath,
      strategy: "markdown" as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: null,
      requireClean: true,
    };
    const preview = await performSync(engine, {
      ...paired,
      dryRun: true,
    });

    const liveMarker = `first descendant mutation ${randomUUID()}`;
    let snapshotRoot: string | null = null;
    let descendant = "";
    let loadPhaseObserved = false;
    let restorePhaseObserved = false;
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (
        !loadPhaseObserved &&
        line.includes("[gbrain phase] sync.load_active_pack")
      ) {
        loadPhaseObserved = true;
        snapshotRoot = findMaterializedTarget(relativePath, targetContent);
        write(repoPath, relativePath, page("First", liveMarker));
        descendant = commitAt(
          repoPath,
          "descendant during first paired sync",
          descendantTimestamp,
        );
      }
      if (
        !restorePhaseObserved &&
        line.includes("[gbrain phase] sync.fullsync.import done")
      ) {
        restorePhaseObserved = true;
        git(repoPath, ["checkout", "--detach", target]);
      }
      originalError(...args);
    };

    const result = await (async () => {
      try {
        return await performSync(engine, {
          ...paired,
          expectedPlanDigest: preview.planDigest!,
        });
      } finally {
        console.error = originalError;
      }
    })();

    expect(loadPhaseObserved).toBe(true);
    expect(restorePhaseObserved).toBe(true);
    expect(snapshotRoot).not.toBeNull();
    expect(descendant).not.toBe(target);
    expect(git(repoPath, ["rev-parse", "HEAD"])).toBe(target);
    expect(["first_sync", "synced"]).toContain(result.status);
    expect(await sourceBookmark(sourceId)).toBe(target);
    const indexed = await engine.getPage("notes/first", { sourceId });
    expect(indexed?.compiled_truth).toContain(targetMarker);
    expect(indexed?.compiled_truth).not.toContain(liveMarker);
    const rows = await engine.executeRaw<{
      newest_content_at: string | Date | null;
    }>(
      `SELECT newest_content_at
         FROM sources
        WHERE id = $1`,
      [sourceId],
    );
    const newestContentAt = rows[0]?.newest_content_at;
    const newestContentMs =
      newestContentAt instanceof Date
        ? newestContentAt.getTime()
        : Date.parse(newestContentAt ?? "");
    expect(newestContentMs).toBe(Date.parse(targetTimestamp));
    expect(newestContentMs).not.toBe(Date.parse(descendantTimestamp));
    expect(existsSync(snapshotRoot!)).toBe(false);
  }, 60_000);

  test("paired include-gitignored fails closed while ordinary include-gitignored remains supported", async () => {
    const { performSync, SyncPreconditionError } =
      await import("../src/commands/sync.ts");
    const sourceId = `exact-ignored-${randomUUID()}`;
    write(repoPath, ".gitignore", "notes/ignored.md\n");
    write(repoPath, "notes/tracked.md", page("Tracked", "tracked body"));
    const target = commit(repoPath, "tracked baseline");
    const ignoredMarker = `ignored body ${randomUUID()}`;
    write(repoPath, "notes/ignored.md", page("Ignored", ignoredMarker));
    await registerSource(sourceId, repoPath);

    let refusal: unknown;
    try {
      await performSync(engine, {
        sourceId,
        repoPath,
        strategy: "markdown",
        includeGitignored: true,
        noPull: true,
        noEmbed: true,
        noExtract: true,
        expectedTarget: target,
        expectedBookmark: null,
        expectedPlanDigest: "0".repeat(64),
        requireClean: true,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SyncPreconditionError);
    expect(
      (refusal as InstanceType<typeof SyncPreconditionError>).reasonCode,
    ).toBe("plan_failed");
    expect(await sourceBookmark(sourceId)).toBeNull();
    expect(await engine.getPage("notes/ignored", { sourceId })).toBeNull();

    const ordinary = await performSync(engine, {
      sourceId,
      repoPath,
      strategy: "markdown",
      includeGitignored: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(ordinary.status).toBe("first_sync");
    expect(
      (await engine.getPage("notes/ignored", { sourceId }))?.compiled_truth,
    ).toContain(ignoredMarker);
  }, 60_000);

  test("paired descendant HEAD drift blocks bookmark advancement and imports only the exact target tree", async () => {
    const { performSync } = await import("../src/commands/sync.ts");
    const sourceId = `exact-head-drift-${randomUUID()}`;
    write(repoPath, "notes/base.md", page("Base", "base body"));
    commit(repoPath, "initial");
    await registerSource(sourceId, repoPath);
    const bookmark = await seedNamedSource(sourceId, repoPath);

    const targetMarker = `exact target x ${randomUUID()}`;
    write(repoPath, "notes/x.md", page("X", targetMarker));
    const target = commit(repoPath, "exact target");
    const paired = {
      sourceId,
      repoPath,
      strategy: "markdown" as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };
    const preview = await performSync(engine, {
      ...paired,
      dryRun: true,
    });
    const laterMarker = `descendant y ${randomUUID()}`;
    let descendant = "";
    const { result, phaseObserved } = await atLoadPhase(
      () => {
        write(repoPath, "notes/y.md", page("Y", laterMarker));
        descendant = commit(repoPath, "descendant during paired sync");
      },
      () =>
        performSync(engine, {
          ...paired,
          expectedPlanDigest: preview.planDigest!,
        }),
    );

    expect(phaseObserved).toBe(true);
    expect(descendant).not.toBe(target);
    expect(await sourceBookmark(sourceId)).toBe(bookmark);
    expect(result.status).toBe("blocked_by_failures");
    expect(
      (await engine.getPage("notes/x", { sourceId }))?.compiled_truth,
    ).toContain(targetMarker);
    expect(await engine.getPage("notes/y", { sourceId })).toBeNull();
  }, 60_000);

  test("ordinary sync still accepts a descendant HEAD and advances only to its pinned checkpoint target", async () => {
    const { performSync } = await import("../src/commands/sync.ts");
    const sourceId = `ordinary-descendant-${randomUUID()}`;
    const ordinaryRepo = initRepo("gbrain-ordinary-descendant");
    extraRepos.push(ordinaryRepo);
    write(ordinaryRepo, "notes/base.md", page("Base", "base body"));
    commit(ordinaryRepo, "initial");
    await registerSource(sourceId, ordinaryRepo);
    const bookmark = await seedNamedSource(sourceId, ordinaryRepo);

    write(ordinaryRepo, "notes/x.md", page("X", "pinned x body"));
    const pin = commit(ordinaryRepo, "pinned target");
    const fingerprint = syncFingerprint({
      sourceId,
      lastCommit: bookmark,
    });
    await recordCompleted(engine, { op: "sync-target", fingerprint }, [pin]);
    write(ordinaryRepo, "notes/y.md", page("Y", "later y body"));
    const descendant = commit(ordinaryRepo, "later descendant");

    const result = await performSync(engine, {
      sourceId,
      repoPath: ordinaryRepo,
      strategy: "markdown",
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(descendant).not.toBe(pin);
    expect(result.status).toBe("synced");
    expect(result.toCommit).toBe(pin);
    expect(await sourceBookmark(sourceId)).toBe(pin);
    expect(await engine.getPage("notes/x", { sourceId })).not.toBeNull();
    expect(await engine.getPage("notes/y", { sourceId })).toBeNull();
  }, 60_000);

  test("ordinary sync binds planning, execution, result, and bookmark to the same HEAD", async () => {
    const { performSync } = await import("../src/commands/sync.ts");
    const sourceId = `ordinary-double-head-${randomUUID()}`;
    write(repoPath, "notes/base.md", page("Base", "base body"));
    commit(repoPath, "initial");
    await registerSource(sourceId, repoPath);
    await seedNamedSource(sourceId, repoPath);

    write(repoPath, "notes/h1.md", page("H1", "first captured head"));
    const h1 = commit(repoPath, "h1");

    const originalExecuteRaw = engine.executeRaw.bind(engine);
    let advancedDuringPlannerPreflight = false;
    let h2 = "";
    engine.executeRaw = (async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
      opts?: { signal?: AbortSignal },
    ): Promise<T[]> => {
      const rows = await originalExecuteRaw<T>(sql, params, opts);
      if (
        !advancedDuringPlannerPreflight &&
        sql.includes("SELECT local_path FROM sources WHERE id = $1") &&
        params?.[0] === sourceId
      ) {
        advancedDuringPlannerPreflight = true;
        write(repoPath, "notes/h2.md", page("H2", "second planner head"));
        h2 = commit(repoPath, "h2");
      }
      return rows;
    }) as typeof engine.executeRaw;

    let result;
    try {
      result = await performSync(engine, {
        sourceId,
        repoPath,
        strategy: "markdown",
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });
    } finally {
      engine.executeRaw = originalExecuteRaw;
    }

    expect(advancedDuringPlannerPreflight).toBe(true);
    expect(h2).not.toBe(h1);
    expect(result.status).toBe("synced");
    expect(result.toCommit).toBe(h2);
    expect(await sourceBookmark(sourceId)).toBe(h2);
    expect(await engine.getPage("notes/h1", { sourceId })).not.toBeNull();
    expect(await engine.getPage("notes/h2", { sourceId })).not.toBeNull();
  }, 60_000);

  test("paired apply refuses --skip-failed before mutating", async () => {
    const { performSync, SyncPreconditionError } = await import(
      "../src/commands/sync.ts"
    );
    const sourceId = `exact-skip-failed-${randomUUID()}`;
    write(repoPath, "notes/base.md", page("Base", "base body"));
    const target = commit(repoPath, "initial");
    await registerSource(sourceId, repoPath);

    await expect(
      performSync(engine, {
        sourceId,
        repoPath,
        strategy: "markdown",
        noPull: true,
        noEmbed: true,
        noExtract: true,
        skipFailed: true,
        expectedTarget: target,
        expectedBookmark: null,
        expectedPlanDigest: "0".repeat(64),
        requireClean: true,
      }),
    ).rejects.toMatchObject({
      name: SyncPreconditionError.name,
      reasonCode: "plan_failed",
    });
    expect(await sourceBookmark(sourceId)).toBeNull();
    expect(await engine.getPage("notes/base", { sourceId })).toBeNull();
  }, 60_000);

  test("paired apply never auto-skips a failed planned file", async () => {
    const { performSync } = await import("../src/commands/sync.ts");
    const sourceId = `exact-auto-skip-${randomUUID()}`;
    write(
      repoPath,
      "notes/bad.md",
      [
        "---",
        "type: concept",
        "title: Bad",
        "slug: wrong-slug",
        "---",
        "",
        "This must fail path-authoritative slug validation.",
        "",
      ].join("\n"),
    );
    const target = commit(repoPath, "invalid planned page");
    await registerSource(sourceId, repoPath);
    const paired = {
      sourceId,
      repoPath,
      strategy: "markdown" as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: null,
      requireClean: true,
    };
    const preview = await performSync(engine, {
      ...paired,
      dryRun: true,
    });

    const previousThreshold = process.env.GBRAIN_SYNC_AUTOSKIP_AFTER;
    process.env.GBRAIN_SYNC_AUTOSKIP_AFTER = "1";
    let result;
    try {
      result = await performSync(engine, {
        ...paired,
        expectedPlanDigest: preview.planDigest!,
      });
    } finally {
      if (previousThreshold === undefined) {
        delete process.env.GBRAIN_SYNC_AUTOSKIP_AFTER;
      } else {
        process.env.GBRAIN_SYNC_AUTOSKIP_AFTER = previousThreshold;
      }
    }

    expect(result.status).toBe("blocked_by_failures");
    expect(await sourceBookmark(sourceId)).toBeNull();
    expect(await engine.getPage("notes/bad", { sourceId })).toBeNull();
  }, 60_000);

  test("paired apply fails source_changed when the source anchor update affects zero rows", async () => {
    const { performSync, SyncPreconditionError } = await import(
      "../src/commands/sync.ts"
    );
    const sourceId = `exact-zero-anchor-${randomUUID()}`;
    write(repoPath, "notes/base.md", page("Base", "base body"));
    commit(repoPath, "initial");
    await registerSource(sourceId, repoPath);
    const bookmark = await seedNamedSource(sourceId, repoPath);
    write(repoPath, "notes/new.md", page("New", "new body"));
    const target = commit(repoPath, "target");
    const paired = {
      sourceId,
      repoPath,
      strategy: "markdown" as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };
    const preview = await performSync(engine, {
      ...paired,
      dryRun: true,
    });

    const originalExecuteRaw = engine.executeRaw.bind(engine);
    let purgedBeforeAnchor = false;
    engine.executeRaw = (async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
      opts?: { signal?: AbortSignal },
    ): Promise<T[]> => {
      if (
        !purgedBeforeAnchor &&
        /UPDATE sources[\s\S]*SET last_commit/.test(sql) &&
        params?.[1] === sourceId
      ) {
        purgedBeforeAnchor = true;
        await originalExecuteRaw(
          `DELETE FROM sources WHERE id = $1`,
          [sourceId],
        );
        return [];
      }
      return originalExecuteRaw<T>(sql, params, opts);
    }) as typeof engine.executeRaw;

    try {
      await expect(
        performSync(engine, {
          ...paired,
          expectedPlanDigest: preview.planDigest!,
        }),
      ).rejects.toMatchObject({
        name: SyncPreconditionError.name,
        reasonCode: "source_changed",
      });
    } finally {
      engine.executeRaw = originalExecuteRaw;
    }
    expect(purgedBeforeAnchor).toBe(true);
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(rows).toEqual([]);
  }, 60_000);

  test("full paired reconcile preserves a page whose path exists only on a branch unreachable from the exact target", async () => {
    const { performSync } = await import("../src/commands/sync.ts");
    const sourceId = `exact-unreachable-history-${randomUUID()}`;
    write(repoPath, "notes/base.md", page("Base", "target branch base"));
    const target = commit(repoPath, "target branch baseline");
    git(repoPath, ["branch", "exact-target", target]);
    git(repoPath, ["checkout", "-b", "unrelated-history"]);

    const branchOnlyMarker = `unrelated branch body ${randomUUID()}`;
    write(
      repoPath,
      "notes/branch-only.md",
      page("Branch Only", branchOnlyMarker),
    );
    const unrelatedBookmark = commit(repoPath, "unrelated branch page");
    await registerSource(sourceId, repoPath);
    await seedNamedSource(sourceId, repoPath);
    expect(
      (
        await engine.getPage("notes/branch-only", {
          sourceId,
        })
      )?.compiled_truth,
    ).toContain(branchOnlyMarker);

    git(repoPath, ["checkout", "exact-target"]);
    expect(git(repoPath, ["rev-parse", "HEAD"])).toBe(target);
    expect(existsSync(join(repoPath, "notes/branch-only.md"))).toBe(false);
    expect(git(repoPath, ["status", "--porcelain=v1"])).toBe("");

    const paired = {
      sourceId,
      repoPath,
      strategy: "markdown" as const,
      full: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: unrelatedBookmark,
      requireClean: true,
    };
    const preview = await performSync(engine, {
      ...paired,
      dryRun: true,
    });
    const result = await performSync(engine, {
      ...paired,
      expectedPlanDigest: preview.planDigest!,
    });

    expect(["first_sync", "synced"]).toContain(result.status);
    expect(result.deleted).toBe(0);
    expect(result.preserved).toBe(1);
    expect(await sourceBookmark(sourceId)).toBe(target);
    expect(
      (
        await engine.getPage("notes/branch-only", {
          sourceId,
        })
      )?.compiled_truth,
    ).toContain(branchOnlyMarker);
    expect(existsSync(join(repoPath, "notes/branch-only.md"))).toBe(false);
    expect(git(repoPath, ["status", "--porcelain=v1"])).toBe("");
  }, 60_000);

  test("paired detached preview ignores a live ABA manifest while ordinary detached preview still observes it", async () => {
    const { performSync } = await import("../src/commands/sync.ts");
    const { _setGitRunnerForTests } = await import("../src/core/sync-delta.ts");
    const sourceId = `exact-detached-aba-${randomUUID()}`;
    const stablePath = "notes/stable.md";
    const stableContent = page("Stable", `stable target ${randomUUID()}`);
    write(repoPath, stablePath, stableContent);
    write(repoPath, "notes/base.md", page("Base", "base body"));
    const target = commit(repoPath, "detached target");
    await registerSource(sourceId, repoPath);
    const bookmark = await seedNamedSource(sourceId, repoPath);
    expect(bookmark).toBe(target);
    git(repoPath, ["checkout", "--detach", target]);

    const stableAbsolute = join(repoPath, stablePath);
    const holdPath = join(tmpdir(), `gbrain-detached-aba-${randomUUID()}`);
    let detachedManifestReads = 0;
    const runRealGit = (repo: string, args: string[]): string =>
      execFileSync("git", ["-c", "core.quotepath=false", "-C", repo, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    _setGitRunnerForTests((repo, args) => {
      const detachedManifestRead =
        args.length === 4 &&
        args[0] === "diff" &&
        args[1] === "--name-status" &&
        args[2] === "-M" &&
        args[3] === "HEAD";
      if (!detachedManifestRead) return runRealGit(repo, args);

      detachedManifestReads++;
      renameSync(stableAbsolute, holdPath);
      try {
        return runRealGit(repo, args);
      } finally {
        renameSync(holdPath, stableAbsolute);
      }
    });

    try {
      const ordinary = await performSync(engine, {
        sourceId,
        repoPath,
        strategy: "markdown",
        dryRun: true,
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });
      expect(ordinary.status).toBe("dry_run");
      expect(ordinary.deleted).toBe(1);
      expect(detachedManifestReads).toBe(1);
      expect(readFileSync(stableAbsolute, "utf8")).toBe(stableContent);
      expect(git(repoPath, ["status", "--porcelain=v1"])).toBe("");

      const paired = await performSync(engine, {
        sourceId,
        repoPath,
        strategy: "markdown",
        dryRun: true,
        noPull: true,
        noEmbed: true,
        noExtract: true,
        expectedTarget: target,
        expectedBookmark: bookmark,
        requireClean: true,
      });
      expect(paired.status).toBe("dry_run");
      expect(paired.deleted).toBe(0);
      expect(paired.added).toBe(0);
      expect(paired.modified).toBe(0);
      expect(paired.renamed).toBe(0);
      expect(detachedManifestReads).toBe(1);
      expect(readFileSync(stableAbsolute, "utf8")).toBe(stableContent);
      expect(git(repoPath, ["status", "--porcelain=v1"])).toBe("");
      expect(
        await engine.getPage("notes/stable", {
          sourceId,
        }),
      ).not.toBeNull();
    } finally {
      _setGitRunnerForTests(null);
      if (existsSync(holdPath) && !existsSync(stableAbsolute)) {
        renameSync(holdPath, stableAbsolute);
      }
      rmSync(holdPath, { force: true });
    }
  }, 60_000);
});
