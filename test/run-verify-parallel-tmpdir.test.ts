import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("run-verify-parallel.sh default log dir", () => {
  it("is created under TMPDIR, not a hard-coded /tmp", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-tmpdir-"));
    const missing = join(root, "does-not-exist");
    try {
      const r = spawnSync("bash", ["scripts/run-verify-parallel.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: missing,
          GBRAIN_VERIFY_LOG_DIR: "",
          // Exit early (usage error) right after the log dir is created.
          GBRAIN_VERIFY_MAX_PARALLEL: "0",
        },
      });
      // mktemp must have tried to create the dir under TMPDIR.
      expect(r.stderr).toContain(missing);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
