import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";

interface EvaluationPair {
  question: string;
  answer: string;
}

describe("MCP retrieval evaluation corpus", () => {
  const xmlPath = join(import.meta.dir, "evaluations", "mcp-retrieval.xml");
  const xml = readFileSync(xmlPath, "utf8");
  const parsed = new XMLParser().parse(xml) as {
    evaluation: { qa_pair: EvaluationPair[] };
  };
  const pairs = parsed.evaluation.qa_pair;

  test("contains exactly ten stable read-only question and answer pairs", () => {
    expect(pairs).toHaveLength(10);
    expect(new Set(pairs.map((pair) => pair.question)).size).toBe(10);
    expect(pairs.every((pair) => pair.question.length > 20)).toBe(true);
    expect(pairs.every((pair) => String(pair.answer).trim().length > 0)).toBe(true);
  });

  test("covers paraphrased and multi-hop retrieval instead of tool implementation details", () => {
    const questions = pairs.map((pair) => pair.question).join("\n");
    expect(questions).toContain("先找出");
    expect(questions).toContain("再确认");
    expect(questions).toContain("哪位投资人");
    expect(questions).not.toMatch(/\b(search|query|get_page|MCP)\b/i);
  });
});
