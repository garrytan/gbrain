# CoE Lite v1 contract reference

## Top-level records

The v1 registry exposes the following strict records:

| Contract | Purpose |
| --- | --- |
| `source` | Stable bibliographic or logical source identity. |
| `source_snapshot` | Immutable bytes acquired from a source at a point in time. |
| `normalized_document` | Normalized structure plus mappings back to raw locations. |
| `evidence_item` | Citable, immutable evidence with an exact locator. |
| `claim` | Typed assertion with explicit origin and lifecycle. |
| `claim_evidence_edge` | Typed support or refutation relationship. |
| `verification_run` | Reproducible result from a named verifier and policy. |
| `retrieval_run` | Candidate and selection trace for one retrieval decision. |
| `answer` | Answer text decomposed into individually cited answer claims. |
| `contradiction` | Explicit relationship and resolution state between two claims. |
| `lifecycle_event` | Append-only audit event for a modeled aggregate. |
| `policy` | Fail-closed verification and release rules. |

The TypeScript/Zod definitions enforce semantic relationships that JSON Schema cannot express
portably, such as valid spans, selection consistency, lifecycle transitions, and the complete
support required for a released answer. JSON Schema consumers validate structure, formats,
enums, and unknown-field rejection; authoritative ingestion must also run the executable parser.

## Identity and canonicalization

`coe-c14n-json-v1` applies these rules before hashing:

1. Accept only JSON values and plain objects.
2. Normalize strings and object keys to Unicode NFC.
3. Normalize CRLF and CR line endings to LF.
4. Sort normalized object keys by UTF-16 code-unit order.
5. Preserve array order.
6. Reject non-finite numbers, unsupported values, and keys that collide after normalization.
7. Serialize negative zero as zero.

An identifier is `<type-prefix>_<sha256>`, where the hash covers the profile name and the
identity payload. Integrity hashes use `sha256:<hex>`: content hashes cover exact artifact bytes,
evidence text hashes cover the exact UTF-8 bytes of `normalized_text`, and structured verifier
input/output hashes cover their canonical JSON. Identity payloads must exclude mutable lifecycle
fields.

## Origins, support, and measurements

Claims distinguish direct source material, derived inference, derived recommendation, authored
content, system-generated content, and quarantined legacy imports. A legacy import cannot enter a
trusted status until it has passed the normal verification path.

Evidence edges distinguish `supports`, `refutes`, `contextualizes`, and `mentions`, independently
from the support level (`direct`, `partial`, `indirect`, or `insufficient`). Exact decimal values
and verifier metrics are strings; producers must not silently introduce binary floating-point
rounding.

There is deliberately no generic `confidence` field. Decisions must name the measurement being
reported, its verifier, its policy, and its interpretation. Unknown fields — including a field
named `confidence` — are rejected.

## Stable errors

The executable parser emits a stable error code from this set:

- `invalid_json`
- `unsupported_schema_version`
- `unknown_field`
- `invalid_contract`
- `invalid_transition`
- `scope_widening`
- `hash_mismatch`
- `id_mismatch`
- `policy_violation`
- `release_blocked`

Messages and issue paths provide diagnostics but are not compatibility keys.

## Scope propagation

Every evidence-bearing or user-visible record carries an access scope and at least one source
anchor. Named readers are explicit grants. When a derived record is created, its brain and owner
remain unchanged, its visibility cannot become broader, and source and named-reader lists can only
be narrowed by subset. Deliberate re-ACL is a separate authorized operation. A derivation-time
violation is `scope_widening` and must fail closed.

## Events and transitions

Allowed claim, snapshot, and evidence transitions are closed adjacency maps in
`src/coe/contracts/transitions.ts`. Self-transitions and unlisted transitions are invalid.
Lifecycle events are append-only facts; they do not authorize a transition by themselves.
