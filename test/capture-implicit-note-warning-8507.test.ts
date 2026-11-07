/**
 * #8507: a capture with no type stored `note` under a pack that does not declare it, and nothing told the caller.
 * #4655 keeps that write working on purpose (bare capture never fails under a pack that omits `note`), so it now returns
 * the same `type_warning` put_page does (#5880). An explicit undeclared type is still rejected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "../src/commands/capture.ts";
import { operations, type OperationContext } from "../src/core/operations.ts";
import { disposePersistenceConsumer } from "../src/core/persistence/service.ts";
import { PGLiteEngine } from "../src/core/pglite-engine.ts";
import { _resetPackCacheForTests } from "../src/core/schema-pack/registry.ts";
import { resetPgliteState } from "./helpers/reset-pglite.ts";
import { withEnv } from "./helpers/with-env.ts";

const home = mkdtempSync(join(tmpdir(), "gbrain-8507-"));
const capture = operations.find(op => op.name === "capture")!;
const packYaml = (name: string, aliases: string[]) => ["api_version: gbrain-schema-pack-v1", `name: ${name}`, "version: 1.0.0", "description: \"\"", "gbrain_min_version: 0.38.0",
  "extends: null", "borrow_from: []", "page_types:", "  - name: finding", "    primitive: temporal", "    path_prefixes: [\"findings/\"]", `    aliases: [${aliases.join(", ")}]`,
  "link_types: []", "frontmatter_links: []", "takes_kinds: [fact]", "enrichable_types: []", "filing_rules: []", ""].join("\n");
let engine: PGLiteEngine;

beforeAll(async () => {
  for (const [name, aliases] of [["no-note", []], ["note-alias", ["note"]]] as const) {
    mkdirSync(join(home, ".gbrain", "schema-packs", name), { recursive: true });
    writeFileSync(join(home, ".gbrain", "schema-packs", name, "pack.yaml"), packYaml(name, [...aliases]));
  }
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'schema_pack%'");
  await engine.setConfig("schema_pack", "gbrain-base");
});

const ctx = (remote: boolean, warns: string[] = [], sourceId = "default") => ({ engine, config: { engine: "pglite" as const, embedding_disabled: true },
  logger: { info: () => {}, warn: (line: string) => { warns.push(line); }, error: () => {} }, dryRun: false, remote, sourceId }) as OperationContext;
const write = (context: OperationContext, params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined },
  () => capture.handler(context, params)) as Promise<Record<string, any>>;
const storedType = async (slug: string) => (await engine.executeRaw<{ type: string }>("SELECT type FROM pages WHERE slug=$1", [slug]))[0]?.type;

describe("#8507 capture with no type", () => {
  // Value: protects=an agent learns its capture landed under a type the pack does not declare, and how to fix it, while the write still
  // succeeds (#4655); fails_when=capture stops warning, rejects, or checks the wrong type; why_new=#5880 covers put_page, whose response
  // path capture shares but whose warning it skipped; seam=none; no_claim=a same-ID replay, which returns the stored receipt without it, as put_page does
  for (const remote of [true, false]) {
    test(`${remote ? "a remote" : "a local"} capture stores the page and warns under a pack without note`, async () => {
      await engine.setConfig("schema_pack.source.default", "no-note");
      const warns: string[] = [];
      const result = await write(ctx(remote, warns), { content: "A finding worth keeping.", slug: "inbox/no-note" });
      expect(result.type_warning).toMatchObject({ code: "page_type_undeclared", type: "note", pack: "no-note", docs: "docs/architecture/schema-packs.md#undeclared-page-types" });
      expect(result.type_warning.cause).toContain("capture: page type 'note' is not declared");
      expect(result.type_warning.fix).toContain("finding");
      expect(warns.filter(line => line.includes("page_type_undeclared"))).toHaveLength(1);
      expect(await storedType("inbox/no-note")).toBe("note");
    });
  }

  // Value: protects=`gbrain capture --json` carries the warning an agent reads; fails_when=the CLI receipt drops it (it lists its fields);
  // why_new=the op tests stop at the handler; seam=console.log is captured; no_claim=the human receipt, where the warning is the stderr line
  test("gbrain capture --json carries the warning", async () => {
    await engine.setConfig("schema_pack.source.default", "no-note");
    const lines: string[] = [], log = console.log, warn = console.warn, error = console.error;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    console.warn = console.error = () => {};
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, () => runCapture(engine, ["--slug", "inbox/cli", "--json", "A finding worth keeping."]));
    } finally { console.log = log; console.warn = warn; console.error = error; }
    expect(JSON.parse(lines.join("\n")).type_warning).toMatchObject({ code: "page_type_undeclared", type: "note", pack: "no-note" });
  });

  // Value: protects=packs that declare or alias note see no new noise; fails_when=the check uses declared names alone or ignores the pack;
  // why_new=the warning is new; seam=none; no_claim=none
  for (const pack of ["gbrain-base", "note-alias"]) {
    test(`no warning under ${pack}, which covers note`, async () => {
      await engine.setConfig("schema_pack.source.default", pack);
      const warns: string[] = [];
      const result = await write(ctx(true, warns), { content: "A finding worth keeping.", slug: "inbox/covered" });
      expect(result.type_warning).toBeUndefined();
      expect(warns.filter(line => line.includes("page_type_undeclared"))).toEqual([]);
    });
  }

  // Value: protects=the check reads the destination source's pack; fails_when=it reads the default pack; why_new=the issue asks for it;
  // seam=none; no_claim=none
  test("the warning follows the destination source pack", async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('source-a','source-a') ON CONFLICT DO NOTHING");
    await engine.setConfig("schema_pack.source.source-a", "no-note");
    expect((await write(ctx(true), { content: "Into the default source.", slug: "inbox/default" })).type_warning).toBeUndefined();
    expect((await write(ctx(true, [], "source-a"), { content: "Into source a.", slug: "inbox/a" })).type_warning).toMatchObject({ pack: "no-note" });
  });

  // Value: protects=the #4655 line: an explicit name the caller chose is still refused; fails_when=the warning path also covers explicit types;
  // why_new=pins the two paths side by side under a custom pack; seam=none; no_claim=none
  test("an explicit note under the same pack is still rejected", async () => {
    await engine.setConfig("schema_pack.source.default", "no-note");
    await expect(write(ctx(true), { content: "Explicit.", slug: "inbox/explicit", type: "note" })).rejects.toMatchObject({ code: "invalid_params" });
    expect(await storedType("inbox/explicit")).toBeUndefined();
  });
});
