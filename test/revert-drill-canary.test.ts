import { describe, expect, test } from "bun:test";

describe("revert drill canary", () => {
  test("runs from its own file", () => {
    expect(import.meta.path.endsWith("revert-drill-canary.test.ts")).toBe(true);
  });
});
