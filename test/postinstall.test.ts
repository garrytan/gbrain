import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  POSTINSTALL_MESSAGE,
  runPostinstall,
} from "../scripts/postinstall.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("postinstall", () => {
  test("package.json uses the cross-platform helper", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
    );

    expect(pkg.scripts.postinstall).toBe("bun run scripts/postinstall.ts");
    expect(pkg.scripts.postinstall).not.toContain(">/dev/null");
    expect(pkg.scripts.postinstall).not.toContain("2>&1");
  });

  test("prints upgrade guidance without probing or mutating a brain", async () => {
    const logs: string[] = [];

    expect(await runPostinstall({ log: (m) => logs.push(m) })).toBe(0);
    expect(logs).toEqual([POSTINSTALL_MESSAGE]);
    expect(POSTINSTALL_MESSAGE).toContain("does not open your brain");
    expect(POSTINSTALL_MESSAGE).toContain("gbrain upgrade");
    expect(POSTINSTALL_MESSAGE).toContain("gbrain post-upgrade");
    expect(POSTINSTALL_MESSAGE).not.toContain("apply-migrations");
  });
});
