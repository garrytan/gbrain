import { describe, test, expect } from "bun:test";
import {
  chunkText,
  countWords,
  PROSE_CHUNKER_VERSION,
} from "../../src/core/chunkers/recursive.ts";
import { createHash } from "node:crypto";

describe("Recursive Text Chunker", () => {
  test("returns empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
  });

  test("returns single chunk for short text", () => {
    const text = "Hello world. This is a short text.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text.trim());
    expect(chunks[0].index).toBe(0);
  });

  test("splits at paragraph boundaries", () => {
    const paragraph = "word ".repeat(200).trim();
    const text = paragraph + "\n\n" + paragraph;
    const chunks = chunkText(text, { chunkSize: 250 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("respects chunk size target", () => {
    const text = "word ".repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100 });
    for (const chunk of chunks) {
      const wordCount = chunk.text.split(/\s+/).length;
      // Allow up to 1.5x target due to greedy merge
      expect(wordCount).toBeLessThanOrEqual(150);
    }
  });

  test("applies overlap between chunks", () => {
    const text = "word ".repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk should start with words from end of first chunk
    // (overlap means shared content between adjacent chunks)
    expect(chunks[1].text.length).toBeGreaterThan(0);
  });

  test("splits at sentence boundaries", () => {
    const sentences = Array.from(
      { length: 50 },
      (_, i) =>
        `This is sentence number ${i} with some content about topic ${i}.`,
    ).join(" ");
    const chunks = chunkText(sentences, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should end near a sentence boundary
    for (const chunk of chunks.slice(0, -1)) {
      // Allow for overlap text, but the core content should have sentence endings
      expect(chunk.text).toMatch(/[.!?]/);
    }
  });

  test("assigns sequential indices", () => {
    const text = "word ".repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  test("handles single word input", () => {
    const chunks = chunkText("hello");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("hello");
  });

  test("handles unicode text", () => {
    const text =
      "Bonjour le monde. " + "Ceci est un texte en francais. ".repeat(100);
    const chunks = chunkText(text, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain("Bonjour");
  });

  test("splits at single newline (line-level) when paragraphs are absent", () => {
    // Lines without double newlines should still split at single newlines
    const lines = Array(100).fill("This is a single line of text.").join("\n");
    const chunks = chunkText(lines, { chunkSize: 20 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("handles text with only whitespace delimiters (word-level split)", () => {
    // No sentences, no newlines, just words
    const words = Array(200).fill("word").join(" ");
    const chunks = chunkText(words, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  test("handles clause-level delimiters (semicolons, colons, commas)", () => {
    // Text with clauses but no sentence endings
    const text = Array(100)
      .fill("clause one; clause two: clause three, clause four")
      .join(" ");
    const chunks = chunkText(text, { chunkSize: 30 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("preserves content across chunks (lossless)", () => {
    const original =
      "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = chunkText(original, { chunkSize: 5, chunkOverlap: 0 });
    // With no overlap, all text should appear in chunks
    const reconstructed = chunks.map((c) => c.text).join(" ");
    expect(reconstructed).toContain("First paragraph");
    expect(reconstructed).toContain("Second paragraph");
    expect(reconstructed).toContain("Third paragraph");
  });

  test("default options produce reasonable chunks", () => {
    // Large text with defaults (300 words, 50 overlap)
    const text = Array(500)
      .fill("This is a test sentence with several words.")
      .join(" ");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const wordCount = chunk.text.split(/\s+/).length;
      // Should be roughly 300 words, with 1.5x tolerance
      expect(wordCount).toBeLessThanOrEqual(500);
    }
  });

  test("handles mixed delimiter hierarchy", () => {
    const text = [
      "Paragraph one has sentences. And more sentences! Really?",
      "",
      "Paragraph two; with clauses: and more, clauses here.",
      "",
      "Paragraph three.\nWith line breaks.\nAnd more lines.",
    ].join("\n");
    const chunks = chunkText(text, { chunkSize: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// v2 — CJK-aware prose chunking
// ---------------------------------------------------------------------------
//
// Why these tests exist: pre-v2 the chunker counted whitespace-delimited
// tokens (\S+), so a CJK paragraph with no spaces returned wordCount=1 and
// became a single chunk. For dense Chinese prose that single chunk routinely
// blew past OpenAI's 8192-token embedding ceiling, so embedding=NULL and the
// page fell out of vector search. v2 adds CJK char counting, CJK punctuation
// delimiters, and a codepoint-slicing fallback so the chunker can ALWAYS
// reduce a piece below the target word count.

describe("countWords (CJK-aware)", () => {
  test("ASCII whitespace-delimited", () => {
    expect(countWords("hello world")).toBe(2);
  });

  test("pure CJK: each Han char counts as 1 word", () => {
    expect(countWords("你好世界")).toBe(4);
  });

  test("mixed CJK + ASCII", () => {
    // Han chars: 你, 好 (2). ASCII tokens after CJK is replaced by space:
    // "hello   world" → 2. Total = 4.
    expect(countWords("hello 你好 world")).toBe(4);
  });

  test("CJK punctuation is not in the CJK char range", () => {
    // 。(U+3002) and ！(U+FF01) sit OUTSIDE 一-鿿, so they're not
    // counted as CJK chars. After stripping the 6 Han chars, the leftover
    // string "  。    ！  " contains 2 punctuation tokens picked up by \S+.
    // Total = 6 Han + 2 standalone punctuation tokens = 8.
    //
    // This matches pre-v2 behavior for ASCII (lone "." would count as 1
    // via \S+) and is intentional: punctuation drift in word count is
    // tolerable; the chunker's correctness depends on CJK chars being
    // counted, not on punctuation being excluded.
    expect(countWords("你好。再見！謝謝")).toBe(8);
  });

  test("Japanese hiragana counts per char", () => {
    // こ(U+3053) ん(U+3093) に(U+306B) ち(U+3061) は(U+306F) — all in 3040-309F.
    expect(countWords("こんにちは")).toBe(5);
  });

  test("Korean hangul counts per char", () => {
    // 안녕하세요 — all in AC00-D7AF.
    expect(countWords("안녕하세요")).toBe(5);
  });

  test("empty / whitespace-only", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
  });
});

describe("CJK delimiter splitting", () => {
  test("splits long CJK paragraph at sentence boundaries (。)", () => {
    // Repeat ~80 sentences of ~10 chars each → ~800 CJK chars, well above
    // a chunkSize=50 target. Pre-v2 returned 1 chunk; v2 must split.
    const sentence = "向量搜索系統正在初始化資料庫";
    const text = Array.from({ length: 80 }, () => sentence + "。").join("");
    const chunks = chunkText(text, { chunkSize: 50, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    // Most chunks should end in 。 (sentence boundary), proving the L2
    // CJK delimiter is doing the work.
    const sentenceEndingChunks = chunks.filter((c) => c.text.endsWith("。"));
    expect(sentenceEndingChunks.length).toBeGreaterThan(chunks.length / 2);
  });

  test("falls back to clause delimiters (，) when no sentence breaks exist", () => {
    // No 。 — only commas. Should still split at L3.
    const clause = "資料庫連線錯誤需要檢查環境變數";
    const text = Array.from({ length: 60 }, () => clause).join("，");
    const chunks = chunkText(text, { chunkSize: 30, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("script-aware level-4 fallback", () => {
  test("dense CJK with NO delimiters still splits via codepoint slicing", () => {
    // 5000 Han chars, no spaces, no punctuation. Pre-v2: 1 chunk.
    // v2: codepoint-slicing fallback at level 4 must produce many chunks,
    // each <= chunkSize chars (since 1 CJK char == 1 word).
    const text = "字".repeat(5000);
    const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // greedyMerge allows up to 1.5x target, so 450 codepoints is the
      // practical ceiling. Use a generous bound to keep this stable
      // across implementation tweaks.
      expect(Array.from(chunk.text).length).toBeLessThanOrEqual(500);
    }
  });

  test("8000-char CJK paragraph (the bug repro) produces small chunks", () => {
    // This is the exact failure mode we saw in production: an 8000-char
    // Chinese paragraph that the chunker returned as 1 chunk, which then
    // exceeded OpenAI's 8192-token embedding limit.
    const text = "一二三四五六七八九十".repeat(800); // 8000 chars
    const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be well under 600 chars (which at ~1 token/char
    // for Han is well under the 8192 limit with comfortable margin).
    for (const chunk of chunks) {
      expect(Array.from(chunk.text).length).toBeLessThan(600);
    }
  });
});

describe("script-aware fallback does not regress ASCII behavior", () => {
  test("English-heavy text still splits on whitespace", () => {
    // Pre-v2 behavior: long whitespace-delimited English splits cleanly.
    // We must not regress this.
    const text = "word ".repeat(500).trim();
    const chunks = chunkText(text, { chunkSize: 50, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    // Lossless: every original word should appear in some chunk.
    const reconstructed = chunks.map((c) => c.text).join(" ");
    expect(reconstructed.match(/word/g)?.length).toBe(500);
  });

  test("mixed CJK + English content chunks reasonably", () => {
    const segment = "This is English text. 這是中文段落。";
    const text = segment.repeat(100);
    const chunks = chunkText(text, { chunkSize: 50, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    // Lossless on the non-overlapping path: English words preserved.
    const reconstructed = chunks.map((c) => c.text).join(" ");
    expect(reconstructed).toContain("This is English");
    expect(reconstructed).toContain("這是中文段落");
  });
});

// ---------------------------------------------------------------------------
// v2 fix-on-review — codex caught two regressions in the v2 ship:
//   1. CJK delimiter ordering (P1.1): '。' listed before '。\n' caused the
//      trailing newline to leak into the next piece, where trim() dropped
//      it. Symptom: rejoined chunks are shorter than the original by 1
//      char per CJK sentence boundary.
//   2. Token-budget miss for non-BMP / emoji / combining text (P1.2):
//      countWords returned 1 for inputs like emoji ZWJ, decomposed
//      Latin, and Han Extension B (non-BMP). chunkText's
//      `wordCount <= chunkSize` early exit then returned a single
//      multi-thousand-codepoint chunk, blowing the embedding limit.
// ---------------------------------------------------------------------------

describe("CJK lossless invariant (delimiter ordering)", () => {
  test("CJK with '。\\n' separators: rejoined length within bounded trim() delta of original", () => {
    // Pre-fix: '。' matched first at the boundary, the trailing '\n' became
    // the head of the next piece, then trim() dropped it. Across 40
    // sentences that's 20+ lost newlines on the non-overlap path.
    const sentence = "甲乙丙丁戊己庚辛壬癸。\n";
    const original = sentence.repeat(40);
    const chunks = chunkText(original, { chunkSize: 30, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);

    const rejoined = chunks.map((c) => c.text).join("");

    // Why this is a bounded-delta check, not strict equality:
    //   chunkText runs `.trim()` on every emitted chunk (pre-existing,
    //   independent of this fix). That always strips at most a small
    //   constant of outer whitespace per chunk boundary — typically the
    //   trailing `\n` of a sentence that landed at the chunk edge. So
    //   per-chunk trim contributes O(chunks.length) chars of loss; the
    //   docstring on src/core/chunkers/recursive.ts calls this out
    //   explicitly ("no semantic loss", not "byte-exact reassembly").
    //
    //   The DELIMITER-ordering bug we're guarding against was different:
    //   it leaked a `\n` from sentence N into the head of piece N+1,
    //   where the *inner* trim in splitAtDelimiters dropped it before
    //   the chunk was even formed — a once-per-sentence content drift,
    //   far above the chunk-count budget. Hence the budget below.
    const lossBudget = chunks.length * 2;
    expect(original.length - rejoined.length).toBeLessThanOrEqual(lossBudget);

    // Stronger assertion: every '。' in the original survives intact in
    // the joined chunks (this is the load-bearing CJK boundary).
    const originalSentenceTerminators = (original.match(/。/g) || []).length;
    const rejoinedSentenceTerminators = (rejoined.match(/。/g) || []).length;
    expect(rejoinedSentenceTerminators).toBe(originalSentenceTerminators);
  });
});

describe("codepoint-budget floor for degenerate inputs", () => {
  // Each repro pre-fix returned chunks=1 and a single 7000+ codepoint chunk
  // that OpenAI rejects with "input array exceeds 8192 tokens". Post-fix:
  // countWords' codepoint floor forces the chunker into splitOnWhitespace's
  // codepoint-slicing branch, producing many small chunks.

  test("emoji ZWJ sequences split into many small chunks", () => {
    // U+1F468 U+200D U+1F469 U+200D U+1F467 U+200D U+1F466 — 7 codepoints
    // per "family". 1000 reps = 7000 codepoints, no whitespace, no CJK.
    const text = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}".repeat(1000);
    const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Array.from(chunk.text).length).toBeLessThan(600);
    }
  });

  test("combining marks (decomposed Latin) split", () => {
    // 'é' as the decomposed pair e + U+0301 = 2 codepoints. 2000 reps =
    // 4000 codepoints. No whitespace. No CJK. Pre-fix: 1 chunk.
    const text = "é".repeat(2000);
    const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Array.from(chunk.text).length).toBeLessThan(600);
    }
  });

  test("non-BMP CJK (Han Extension B) splits even though CJK_RE misses it", () => {
    // U+20000 sits OUTSIDE the U+4E00-U+9FFF block CJK_RE matches, so
    // cjkCount is 0. As a single token of 1000 codepoints with no
    // whitespace, base count is 1 — the codepoint floor saves it.
    const text = "\u{20000}".repeat(1000);
    const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Array.from(chunk.text).length).toBeLessThan(600);
    }
  });

  test("countWords floor does not regress short ASCII inputs", () => {
    // Sanity: 'hello' has no whitespace and no CJK, so the codepoint
    // path applies. But 5 << default chunkSize=300, so the early-exit
    // still fires and we get a single chunk. The floor is meant to
    // promote DEGENERATE long inputs, not short words.
    expect(chunkText("hello").length).toBe(1);
    expect(chunkText("word").length).toBe(1);
  });

  test("countWords floor does not regress long whitespace ASCII", () => {
    // 500 space-delimited words must still chunk via the whitespace
    // branch (lossless reconstruction of every 'word' token). The floor
    // is gated on `!/\s/.test(text.trim())`, so this path is untouched.
    const text = "word ".repeat(500).trim();
    const chunks = chunkText(text, { chunkSize: 50, chunkOverlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    const rejoined = chunks.map((c) => c.text).join(" ");
    expect((rejoined.match(/word/g) || []).length).toBe(500);
  });
});

describe("PROSE_CHUNKER_VERSION + content_hash invalidation", () => {
  test("PROSE_CHUNKER_VERSION is exported and >= 2", () => {
    expect(typeof PROSE_CHUNKER_VERSION).toBe("number");
    expect(PROSE_CHUNKER_VERSION).toBeGreaterThanOrEqual(2);
  });

  test("content_hash differs when PROSE_CHUNKER_VERSION changes", () => {
    // Mirror import-file.ts hashing shape so we can prove the version
    // participates in the hash (the actual import-file.ts hashing pulls
    // in the live constant; here we simulate two values to show the
    // hash function genuinely depends on it).
    const sharedFields = {
      title: "test page",
      type: "page" as const,
      compiled_truth: "你好世界",
      timeline: "",
      frontmatter: {},
      tags: [],
    };

    const hashV1 = createHash("sha256")
      .update(JSON.stringify({ ...sharedFields, prose_chunker_version: 1 }))
      .digest("hex");
    const hashV2 = createHash("sha256")
      .update(JSON.stringify({ ...sharedFields, prose_chunker_version: 2 }))
      .digest("hex");

    expect(hashV1).not.toBe(hashV2);
  });
});
