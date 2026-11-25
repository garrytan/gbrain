**Shadow mode now checks a sample of page and link writes against the Rust engine, so swap readiness criterion 5 has real evidence for those writes.**

### Added
- For a sampled `putPage`, `deletePage`, `addLink`, `addLinksBatch` or `removeLink`, shadow mode copies the rows the write touches from your brain, applies the same write to a throwaway Rust store built from that copy (never the live shadow store, never your brain), and compares the changed pages and links. A match counts as `comparable`; a difference counts as `unexplained_difference`. A write that could not be checked (the copy could not be read or loaded, the write failed on either side, it ran inside a transaction, another write landed in between, or it touched too many rows) counts as `uncomparable` and never as comparable. The sample share is a new write sample rate, 0.05 by default and separate from the read rate (`gbrain engine shadow start --write-sample-rate <0..1>`).
- Every sampled write of any other kind (tags, chunks, timeline, facts, raw SQL and so on) is counted `capability_missing` under its family. `gbrain engine shadow status` prints the counts by family, and the swap plan names them.
- The swap plan and the status say it plainly: "a criterion 5 pass covers page and link writes only".

### Changed
- `write_comparisons.state` in `gbrain engine shadow status --json` is `capability_missing` until at least one write comparison reaches a verdict, then `measured`. Criterion 5 stays `missing` until then, and below 1,000 comparable writes it fails and says how many there are. The pass rule is unchanged.
- A sampled write outside a transaction now waits, at most 2 seconds, for one small read of the rows it touches before it runs; a slow read lets the write go ahead and counts the sample as `uncomparable`. Nothing else on the write path waits for the shadow.
- Writes inside a transaction are `uncomparable`. `put_page` and import run their page write inside a transaction, so today only link operations outside a transaction (`add_link`, `remove_link`, a by-mention extract batch) can count as `comparable`.

### Not done yet
- Comparing a `putPage` that ran inside a transaction (every `put_page` and import) is a follow-up. Until it lands, criterion 5 has little to count on a brain whose writes are mostly pages, and it fails closed.
