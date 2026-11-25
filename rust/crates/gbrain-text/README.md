# gbrain-text (prototype, measure only)

A Rust port of the mention scanner (`findMentionedEntities` in `src/core/by-mention.ts`), built
to measure whether moving it out of TypeScript pays. It is not wired into gbrain and nothing on
master calls it. Garry's ruling (Nov 24, A1): the scanner moves to Rust only if shadow mode shows
it slow on a real brain.

`bench/` holds the scripts used: a deterministic 10,000-page corpus with plain-name mentions
(`gen-corpus.ts`), the gazetteer and scan-text dump (`dump-gaz.ts`), the TypeScript and Rust
benches, a parity fuzz (`fuzz.ts`) and the CPU-profile summarizers. They use absolute scratch
paths under `/var/tmp/rx`; adjust before reuse.
