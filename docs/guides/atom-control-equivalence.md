# Atom provenance after a facts-backstop opt-out

The `source_control_equivalence_v1` atom frontmatter proof describes only an absent `facts_backstop` field becoming boolean `false` on its source page. It preserves the atom's original source_hash, extracted_at/by, quote and offset, and the original successful extraction checkpoint. This is deterministic equivalence verification, not a new extraction or semantic quality score.

The reader accepts only a strict bounded proof, retained inline source-version snapshot, exact source incarnation/page identity/current revision and full hash. All old/current body, timeline, title, type, tags and frontmatter values must agree apart from that one control field. Old scalar frontmatter key order must reproduce the exact original full hash using the official formula, and that full hash must match a successful managed-atoms checkpoint plus complete, nonpartial, zero-failure scan disposition. A quote is rechecked at its original offsets; an original absence of quote stays absent.

Doctor reports `equivalent_control_changes` separately. Its drift thresholds, original hashes, total atom denominator and historical audit events stay intact. Page discovery and scoped/global backlog use the same proof before LIMIT, including managed extraction. Stale-atom retirement also respects valid equivalence. Transcript hash optimization, normal re-extraction and completion records are unchanged.

Every consuming SQL statement rechecks carrier atom/source revisions, incarnation, the complete old-version semantic image, checkpoint JSON and scan state. A body edit, different metadata change, source replacement, history redaction/move/removal, partial/failing extraction or malformed proof invalidates equivalence. Missing or failed database evidence never grants an exemption. Signal-aware readers stop on cancellation; at most 128 proof carriers are considered, and over-cap sets receive no exemption.

There is no automatic inference or default proof installation. The operator must read and independently verify the exact source versions and atom canonical preimages before a normal CAS edit adds the proof. Such an edit retains its normal write authorization, journal, canonical projection and derivative costs; this mechanism does not grant a provider-free write path. Do not use it to relabel body edits, hide failed extraction or rewrite an original source_hash. There is no schema change, new permission, global hash change or checkpoint synthesis.

Ledger pins include timezone-independent exact withdrawal/purge instants. A withdrawal timestamp can change canonical expiry text; changing an existing ledger timestamp invalidates a prepared bridge even if the raw page revision is unchanged.

The carrier metadata is bounded to 16 KiB in its selecting SQL. The canonical snapshot statement itself binds source/page identity, revision, content hash, inline storage and combined 64 KiB body/timeline plus 16 KiB frontmatter; a concurrent large edit cannot return content between a preliminary size probe and validation. Unsupported snapshot SQL shapes fail closed.

**Say to your agent:** *"Check whether adding facts_backstop: false changed only control metadata, and preserve the original atom provenance."* The agent must verify the evidence described above before an authorized CAS edit; there is no automatic repair command for installing proofs.

The final consumption statement also pins the current source path, which can change without a content revision. Relevant withdrawal/purge evidence is limited to 32 rows with bounded scalar fields; overflow grants no equivalence and does not delete ledger history.
