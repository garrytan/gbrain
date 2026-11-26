**A new page shows how gbrain compares with simpler setups, with the eval numbers behind each claim, and `gbrain value` links to it.**

### Added
- `docs/proof.md` lists six measured results from gbrain-evals at a pinned commit, each with its gbrain build, date, size, 95% interval and judge: four where gbrain helps (answers about your own notes, LongMemEval against plain hybrid search, permission leaks, planted false claims) and two where a simpler setup wins (an agent that greps the files on very long chat histories, and a pasted whole conversation on LoCoMo). It also lists other memory systems' published LongMemEval figures and why they aren't comparable.
- `docs/guides/what-youd-build.md` names each part of gbrain, what it does, and what a simpler setup covers instead.

### Changed
- The text form of `gbrain value` ends with a link to the comparison page. `gbrain value --json` is unchanged.
