# Contributor Signature

---

**Original project:** GBrain by Garry Tan (@garrytan) — Y Combinator
**License:** MIT
**Review, documentation additions, optional utilities, and reflective notes:** @LabyrinthCoder — May 2026

---

## What This Fork Is

This is LabyrinthCoder's contribution branch for GBrain. It is a fork of the original project with additive improvements: assumption tracking, retrieval-confidence labeling, audit-chain utility, lightweight snapshotting, known-gap documentation, clearer onboarding, and these reflective notes.

No original files were removed. No original architecture was changed. No original naming conventions were altered. The 1,305 original GBrain files are byte-identical to upstream.

---

## What Labyrinth OS Is

Labyrinth OS is an AI constitutional enforcement substrate — a system for making AI proposals verifiable before execution. It was built independently, in a different domain, with different goals.

During the rehabilitation of GBrain, patterns emerged in Labyrinth's architecture that translated naturally: assumption tracking with dependency propagation, epistemic labeling of outputs, tamper-evident audit trails, lightweight system snapshots. These patterns were translated into GBrain's own language — native naming, native testing conventions, native style. The Labyrinth origin is acknowledged but not asserted. The utilities stand on their own.

Some Labyrinth patterns were explicitly not translated: Z3 formal verification machinery, constitutional gate architecture, agent lineage systems, heavy continuity journals, symbolic governance layers. Those belong to Labyrinth's ecosystem. GBrain has its own architecture. The goal was fit, not transplant.

---

## The Relationship

GBrain remembers. Labyrinth asks what the memory depends on.

That is the relationship between the two systems. Not hierarchy. Not merger. A complementary question — one system that organizes and retrieves knowledge, one system that asks about the assumptions beneath the knowledge.

The utilities contributed here are the overlap: the small tools that make knowledge systems more honest about what they know, how confident they are, and what they're still assuming.

---

## The Philosophy of This Pass

The earliest versions of this rehabilitation tried to overlay Labyrinth identity onto GBrain. They added sidecar folders with branded filenames, heavy continuity journals, and architecture essays at the repo root. It felt wrong because it was wrong.

The final version asked a different question: not "what does Labyrinth have?" but "what does GBrain need?" The answers were different. The result was calmer.

The work finally stopped trying to look impressive and started trying to be useful. That is the inflection point where contributions become respectable.

The assumption tracker became the center of gravity. Not because it was the largest addition — it is a single file of three hundred lines. But because it solved the most universal problem: making invisible assumptions legible. Every AI system has undocumented beliefs it depends on. Very few systems make those beliefs explicit. The tracker does.

The restraint was equally important. Drift-watch was proposed. GBrain's doctor already had drift detection across four independent signal streams. Drift-watch would have added motion without direction. So it wasn't built. The paper got the idea instead of the codebase.

That restraint — knowing what not to add — is the hardest lesson and probably the most valuable one.

---

## Acknowledgment

Garry Tan built something serious. GBrain is dense, well-architected, carefully privacy-constrained, and built to run in production. The diagnostic systems, the eval framework, the skill architecture, the privacy enforcement, the contract-first design — none of that was added by this pass. It was already there.

The contribution was small. A lantern beside the machinery, not a new machine.

If any of the utilities added here are useful, they can be merged, modified, or discarded at Garry's discretion. The license is MIT on both sides. The goal was to leave the codebase slightly more navigable, slightly more honest about its open assumptions, and slightly clearer to the next person who tries to understand it.

That's enough. That's the right kind of contribution.

---

*@LabyrinthCoder — X: [@LabyrinthCoder](https://x.com/LabyrinthCoder) — May 2026*

*"Nothing here replaces GBrain's original architecture. These notes are a lantern placed beside the machinery, not a new machine claiming to own it."*
