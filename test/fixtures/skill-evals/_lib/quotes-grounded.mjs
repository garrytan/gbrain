#!/usr/bin/env node
// Reads a meeting page on stdin and exits 1 when a blockquote is not a contiguous span of the transcript.
// Case, punctuation, a trailing attribution in parentheses or after a dash, and filler words are ignored.
import { readFileSync } from "node:fs";
const norm = (s) => s.toLowerCase().replace(/\b(um|uh|like|you know|i mean)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const transcript = norm(readFileSync(process.argv[2], "utf8").split("\n").map((l) => l.replace(/^\[[0-9:]+\]\s*[^:]+:\s*/, "")).join(" "));
const quotes = readFileSync(0, "utf8").split("\n").filter((l) => l.startsWith(">")).map((l) => l.replace(/^>\s*/, "").replace(/\s*(\(|—|--|–)\s*[^()]*\)?\s*$/, "").replace(/^\*\*[^*]+\*\*:?\s*/, "").replace(/^[A-Z][a-z]+( [A-Z][a-z]+)?:\s*/, "")).map(norm).filter((q) => q.split(" ").length >= 3);
const bad = quotes.filter((q) => !transcript.includes(q));
for (const q of bad) console.error("not verbatim:", q);
process.exit(bad.length ? 1 : 0);
