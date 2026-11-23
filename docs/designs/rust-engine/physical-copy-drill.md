# Physical-copy drill: a Rust brain above the 8 GiB archive cap

Verdict: **PASS**

| What | Value |
| --- | --- |
| Method | `quiesced_physical_copy` (the runbook in `docs/guides/in-agent-setup.md`, "Large brains on the Rust engine"): stop the brain, `cp` FORMAT and records.redb into a new home, `gbrain backup verify-store`, open the copy in isolation |
| Brain | isolated, built by `scripts/rust/large-store-fixture.ts` through the addon (2,000 small pages with 1,536-dimension embeddings, then ~8 MiB pages); never a real brain, never touched by a shadow |
| records.redb bytes | 11307847680 (10.53 GiB; cap 8589934592) |
| Bytes copied (records.redb + FORMAT) | 11307847854 |
| Pages, chunks, embedded chunks | 2670, 2000, 2000 (equal on the source and the copy) |
| Quiescence | the brain's engine was disconnected before the copy; no `.gbrain-owner.sock` in the directory |
| `backup create` at the real cap | refused `backup_too_large`: This Rust brain needs about 10.53 GiB in a backup archive (11308896430 bytes), over the archive's 8.00 GiB cap. Nothing was written. |
| Copy duration | 79.2 s |
| verify-store | 296.5 s library, 45.1 s CLI; verdict ok; 10 record kinds digested; keyword index complete; generation 4671 |
| sha256 records.redb, source = copy = source after | 18d57f2706b6c8f0472b3c943dc980ebca204dc8c065d30ae79e657c47b23681 |
| Isolated reopen | 32.1 s: counts equal, a 1,536-dimension embedding read back exactly, an 8 MiB page body read back whole |
| Build duration | 263.9 s |
| Platform | linux-x64, Bun 1.4.4, 8 CPUs, 31 GiB RAM |
| gbrain version, addon sha256 | 0.60.764.0, 0932f1c3a18940d4fd0a57bd2252d5ee8a197d44532e589eaa72e572c23c739e |
| Free space before | 242753961984 bytes |

Steps and durations:

- build the brain: 263.9 s (records.redb 11307847680 bytes)
- backup create at the real cap: 0 s (This Rust brain needs about 10.53 GiB in a backup archive (11308896430 bytes), over the archive's 8.00 GiB cap. Nothing )
- sha256 of the stopped source: 12.6 s
- physical copy (cp FORMAT records.redb): 79.2 s
- verify-store of the copy (library): 296.5 s (verdict ok, 62839 keys, generation 4671)
- verify-store of the copy (CLI, --json): 45.1 s (exit 0)
- sha256 of the copy: 17.5 s
- isolated reopen: counts, an embedding, a page body: 32.1 s
- sha256 of the source again: 93.3 s

Run history (the drill was run on this VM until it passed at a size well over the cap; the fixture is deleted):
- Run 1: the process was killed by the machine's memory limit while another job held memory; nothing was recovered from it. The script then synced between batches.
- Run 2 (target 9 GiB): PASS, but redb compacts on close, so records.redb ended at 8,606,715,904 bytes (8.02 GiB), only just over the cap. Not used as the proof.
- Run 3 (target 10.6 GiB, the run above): PASS at 10.53 GiB.
The library verify-store call (296.5 s) ran first, on the copy just written; the CLI call (45.1 s) ran second on the same copy. The cause of the difference was not measured.
