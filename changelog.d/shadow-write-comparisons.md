**Shadow mode now checks a sample of page and link writes against the Rust engine, so swap readiness criterion 5 has real evidence for those writes.**

### Added
- For a sampled `putPage`, `deletePage`, `addLink`, `addLinksBatch` or `removeLink`, shadow mode copies the rows the write touches from your brain, applies the same write to a throwaway Rust store built from that copy (never the live shadow store, never your brain), and compares the changed pages and links. A match counts as `comparable`; a difference counts as `unexplained_difference`. A write that could not be checked (the copy could not be read or loaded, the write failed on either side, it ran inside a transaction, another write landed in between, or it touched too many rows) counts as `uncomparable` and never as comparable. The sample share is the shadow's existing `sample_rate`.
- Every sampled write of any other kind (tags, chunks, timeline, facts, raw SQL and so on) is counted `capability_missing` under its family. `gbrain engine shadow status` prints the counts by family, and the swap plan names them.
- The swap plan and the status say it plainly: "a criterion 5 pass covers page and link writes only".

### Changed
- `write_comparisons.state` in `gbrain engine shadow status --json` is `capability_missing` until at least one write comparison reaches a verdict, then `measured`. Criterion 5 stays `missing` until then, and below 1,000 comparable writes it fails and says how many there are. The pass rule is unchanged.
- A sampled write outside a transaction now waits for one small read of the rows it touches before it runs. Nothing else on the write path waits for the shadow.
