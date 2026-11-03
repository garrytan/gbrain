// ubi-runner-bsd-userland.test.ts — scripts/ubicloud/ubi-runner.sh pack under
// the bsdtar macOS ships (ported from gstack's
// test/regression-issue3680-ubicloud-bsd-userland.test.ts, gstack #3746).
//
// Protects: pack writes the whole checkout under bsdtar: tracked, staged,
// untracked, symlinked, spaced and option-like names, a linked worktree and an
// empty file list, with no files.tar left inside the archive.
// Fails when: pack passes tar options after an operand, or resolves its -T list
// after a -C, again (bsdtar then archives .git alone and exits 1).
// Needs: macOS's /usr/bin/tar, or bsdtar on PATH (libarchive-tools); skipped
// without it. usage under the one-true-awk is covered in ubi-runner.test.ts.
// Network: none.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RUNNER = resolve(import.meta.dir, "..", "..", "scripts/ubicloud/ubi-runner.sh");
const bsdTar = process.platform === "darwin" ? "/usr/bin/tar" : Bun.which("bsdtar");
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

describe(`pack under bsdtar${bsdTar ? "" : ": skipped, no bsdtar (install libarchive-tools)"}`, () => {
  it.skipIf(!bsdTar)("ships tracked, staged, untracked, symlinked, spaced and option-like names, a linked worktree and an empty file list", () => {
    const d = mkdtempSync(join(tmpdir(), "ubi-bsd-pack-"));
    try {
      mkdirSync(join(d, "bsd-bin"));
      symlinkSync(bsdTar!, join(d, "bsd-bin", "tar"));
      const PATH = `${join(d, "bsd-bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`;
      const sh = (cmd: string, cwd: string) => {
        const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, timeout: 30_000, env: { PATH, HOME: d, ...gitEnv } });
        expect(r.exitCode, `${cmd}\n${r.stderr.toString()}`).toBe(0);
        return r.stdout.toString();
      };
      expect(sh("tar --version", d)).toContain("bsdtar");
      const pack = (src: string, out: string) => sh(`bash ${JSON.stringify(RUNNER)} pack ${JSON.stringify(src)} > ${JSON.stringify(out)}`, d);
      const unpack = (tgz: string, to: string) => {
        mkdirSync(join(d, to));
        sh(`tar -xzf ${JSON.stringify(tgz)} -C ${JSON.stringify(to)}`, d);
        return join(d, to);
      };
      const status = (cwd: string) => sh("git status --short", cwd).split("\n").filter(Boolean).sort();

      sh('git init -q plain && cd plain && echo a > a && echo b > gone && echo s > "with space" && ln -s a link && echo o > ./-C && echo o > ./--files-from=a && git add -A && git commit -qm one && rm gone && echo st > staged && git add staged && echo u > untracked && echo x > "untracked space"', d);
      pack("plain", "plain.tgz");
      expect(sh("tar -tzf plain.tgz", d).split("\n").some((l) => l.endsWith("files.tar"))).toBe(false);
      const vm = unpack("plain.tgz", "vm-plain");
      expect(status(vm)).toEqual(status(join(d, "plain")));
      expect(status(vm)).toEqual([" D gone", '?? "untracked space"', "?? untracked", "A  staged"]);
      expect(readFileSync(join(vm, "with space"), "utf8")).toBe("s\n");
      expect(sh("readlink link", vm).trim()).toBe("a");
      expect(existsSync(join(vm, "-C")) && existsSync(join(vm, "--files-from=a"))).toBe(true);

      sh("git init -q main && cd main && echo a > a && git add a && git commit -qm one && git branch feat && git worktree add -q ../wt feat", d);
      sh("echo b > b && git add b && git commit -qm two && echo u > u && echo ignored > ig && echo ig > .gitignore", join(d, "wt"));
      pack("wt", "wt.tgz");
      const vmWt = unpack("wt.tgz", "vm-wt");
      expect(existsSync(join(vmWt, "ig"))).toBe(false);
      expect(sh("git rev-parse --abbrev-ref HEAD && git status --short && git log --oneline | wc -l", vmWt).replace(/\s+/g, " ").trim()).toBe("feat ?? .gitignore ?? u 2");

      sh("git init -q empty && cd empty && echo a > a && git add a && git commit -qm one && rm a", d);
      pack("empty", "empty.tgz");
      expect(status(unpack("empty.tgz", "vm-empty"))).toEqual([" D a"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});
