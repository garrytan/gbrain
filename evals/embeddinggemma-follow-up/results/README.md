# EmbeddingGemma real-model results

This is the frozen A/B/C result from the initial bounded prototype at upstream
base `f95338f94d3c679b5d0cb1182de052cce4b8e44f`. The readable [report](report.json)
contains the selected model, frozen corpus/query/label hashes, configuration,
first-repeat per-query Top 5 results, aggregate metrics, language slices,
latencies, and limitations. [The full evidence bundle](evidence.json.gz)
preserves the original sanitized harness output byte-for-byte after gzip
decompression, including vectors, exact wire inputs and repeated rankings.
The later source proposal and operator documentation are tracked in
[system issue #200](https://github.com/xorets/ubuntu-server-system/issues/200);
they do not change these historical results or establish that the feature has
shipped or received maintainer approval.

The raw evidence SHA-256 is
`7712f60e7a627e6d6b8000d17c58e4b6dc94161a3f46be25508e445c1aa46dc0`.
The compressed artifact uses gzip with mtime zero and no filename header.

## Results

On the first repeat, A and B each returned a relevant document at Top 1 for
14/15 queries (93.3%); C returned one for 15/15 (100%). Each arm retrieved all
labeled relevant documents by Top 3 and Top 5. C versus B gained the designed
`q-green-lane-title` Top-1 query and had no regressions. B versus A had no
Top-1 gains or regressions. All three repeats had stable rankings.

The English slice was A/B 10/11 and C 11/11 at Top 1. The Spanish and Chinese
slices were 2/2 for every arm, with only two queries per language. Those small
slices do not support a language-generalization claim. This tiny synthetic
corpus is mostly saturated and includes a designed title-only distinction; no
production quality threshold or acceptance decision was set.

The selected model was initially unloaded. A separate 2598.194 ms primer ran
before the fixed A, B, C arm sequence. All arms were warm; background consumer
load was uncontrolled. A indexed raw documents in 773.26456 ms total (median
27.18 ms), while C indexed titled documents in 722.614613 ms total (median
28.56 ms). B explicitly reused A's immutable raw-document index, so its index
duration is not zero and is not an independent measurement. Query medians and
p95s were A 17.2739/18.6463 ms, B 17.8219/19.6023 ms, and C
18.8853/20.5405 ms. These warm, fixed-order timings do not support a cold-start
or speed conclusion.

Harness-collected runtime fields record the selected model as initially
unloaded, then loaded with 673028505 bytes in VRAM after the primer and after
the run. Separately, the coordinator observed Bun 1.4.2, Ollama 0.35.1, Vulkan
AMD Radeon 680M RADV REMBRANDT, and 673028505 selected-model GPU-resident bytes
afterward. No service configuration was changed. The report distinguishes
harness fields from these external observations.

No labels, prompts or corpus content were tuned after the run. The harness
reports no token usage or cost, so this experiment makes no cost-savings claim
or comparison against a stronger implementation. The result is evidence for
the pending upstream decision, not production acceptance. Issue #159 remains
open, and production migration remains under #99. No full CI pass is claimed.

## Reproduction and integrity

The frozen [dataset](../dataset.json) is CC0-1.0 licensed; see the adjacent
[license](../LICENSE). To rerun the experiment, use the command documented in
the [evaluation README](../README.md) with local Ollama and a new output
directory. It refuses a non-loopback endpoint and writes only sanitized
evidence. The committed bundle omits endpoint addresses, credentials, request
headers, other-model inventory and private paths.

Verify the committed artifacts from this directory:

```bash
sha256sum -c SHA256SUMS
gzip -dc evidence.json.gz | sha256sum
```

The second command must print the raw evidence SHA-256 above. The frozen
dataset hash is recorded in `report.json`; its committed file is also covered
by `SHA256SUMS`.

## Experiment process

The staged Luna/high workflow implemented recipe #175, corpus #176, gateway
#177, wrappers #178 and harness #179, with coordinator review and serial
merging. Independent Standards and Specification reviews at experiment commit
`3eeee1968a6c3f552125ff7244ee80c48bd264e7` found no findings within the
bounded prototype. Review-driven rework covered nullable guards and blank-title
fallback; fixture typing, cross-language equivalence and a title-only pair
before corpus freeze; SDK seam typing; and evaluation payload, warm-state and
unique-query reporting.

A pilot blank-title discrimination result was initially attributed to upstream
and later corrected. Separate initial formatter, gateway and wrapper
behavioral reversals were valid. This records the bounded prototype stage;
later source-proposal behavior and refresh documentation are tracked in system
issue #200. Maintainer direction, upstream contribution acceptance, release
and production migration remain pending.
