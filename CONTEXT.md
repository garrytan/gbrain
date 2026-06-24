# GBrain Documentation Consolidation

This context captures the language used for upstream GBrain documentation
consolidation work. It is a glossary only; implementation decisions belong in
issues, pull requests, or ADRs.

## Language

**Documentation Authority Model**:
A rule for deciding which documentation surface owns a kind of truth: entrypoints
route readers, current-state architecture references define live project
semantics, generated maps are derived, and historical records are labeled by
status.
_Avoid_: documentation truth, docs reality, canonical docs without naming the
owning surface

**Documentation Evolution Update**:
A documentation change that brings a still-relevant document forward with the
current shape of GBrain, without implying that the previous wording was careless
or invalid when written.
_Avoid_: outdated docs as a blanket label, stale docs as a blanket label

**Documentation Contradiction**:
A documentation conflict where a statement disagrees with current source-backed
behavior or with the Documentation Authority Model.
_Avoid_: drift when the issue is a direct conflict

**Incomplete Current Documentation**:
A current documentation surface that remains broadly correct but omits important
behavior, fields, modes, or boundaries that now exist in GBrain.
_Avoid_: wrong docs

**Documentation Consolidation Pass**:
A focused documentation effort that combines resolving contradictions, evolving
still-relevant docs with the current GBrain shape, filling current omissions,
and labeling historical records where their status is unclear.
_Avoid_: stale-docs cleanup, docs rewrite, outdated-docs sweep

**Install Documentation Surface**:
The set of documentation entrypoints, references, tutorials, and client-specific
pages that explain how to install or connect GBrain. Each surface may have a
different reader role, so the consolidation must make authority explicit rather
than duplicate every detail everywhere.
_Avoid_: install docs when the reader role or authority level matters

**Install Surface Fragmentation**:
A documentation risk where installation steps or snippets are repeated across
many surfaces, making it unclear which one owns the current behavior.
_Avoid_: scattered snippets

**Hybrid Install Consolidation**:
An install-docs cleanup that preserves reader-specific entrypoints while
removing or centralizing duplicated details when fragmentation creates real
confusion.
_Avoid_: link-only cleanup, full install rewrite

**Operational Documentation**:
Documentation that a reader depends on to install, configure, connect, upgrade,
or use GBrain successfully. Operational Documentation must be centralized enough
that readers do not need to discover required steps across unrelated repository
pages.
_Avoid_: broad docs when the reader needs executable setup or usage guidance

**Core Operational Usage**:
The central operating knowledge a user or agent needs to install, configure,
connect, verify, upgrade, and use GBrain's main supported shapes. This includes
personal brain and company brain setup, brain/source routing, deployment
topologies, search-mode choice, provider configuration, health checks, MCP
connection, sync/import flows, and normal upgrade/migration guidance.
_Avoid_: basic usage, quick start when the flow includes topology or operating
model choices

**Operational Branching**:
The documentation pattern where core topology and setup choices are presented as
a decision tree, with each branch carrying the minimum correct operational path
for that choice and links to deeper references.
_Avoid_: one-size-fits-all install flow, scattered topology notes

**Topology Option Set**:
The visible set of supported operating shapes a reader can choose from before
following a branch, such as solo personal brain, personal brain with multiple
sources, company brain, thin client, remote host, or split-engine worktree
setup.
_Avoid_: hidden variants, single default path that buries alternatives

**Shared Group Brain**:
A shared brain used by a group such as a family, household, team, or company.
The group context changes examples and privacy expectations, but the core
operational choices are shared: one trusted agent can serve multiple people, or
multiple clients can connect with auth-scoped access.
_Avoid_: treating family brain and company brain as unrelated topology families

**Single-Agent Shared Mode**:
A Shared Group Brain mode where one trusted agent or interface serves multiple
people and enforces per-person behavior by convention, routing, or workspace
structure.
_Avoid_: assuming every shared brain requires per-user OAuth

**Auth-Scoped Shared Mode**:
A Shared Group Brain mode where multiple clients or users connect with explicit
auth scopes, source permissions, and server-side access boundaries.
_Avoid_: treating convention-only scoping as equivalent to auth-scoped access

**Operating Model**:
The user/group ownership shape of a GBrain setup, such as personal brain,
personal brain with multiple sources, or Shared Group Brain.
_Avoid_: using deployment topology when the decision is about who uses or owns
the brain

**Deployment Topology**:
The installation and connection shape of a GBrain setup, such as local brain,
remote host with thin clients, split-engine worktree setup, or mounted brains.
Deployment Topology is orthogonal to Operating Model.
_Avoid_: using personal/shared as if it fully determines deployment shape

**Human Operational Center**:
The single central documentation surface for human-facing installation and Core
Operational Usage. The README may route to it, but required human operational
facts should not require hunting through scattered references.
_Avoid_: parallel getting-started docs with overlapping operational authority

**Agent Operational Center**:
The single central documentation surface for agent-executed installation and
Core Operational Usage. It should mirror the same operating-model and topology
branches as the Human Operational Center while adding mandatory agent safety
gates.
_Avoid_: spreading required agent protocol across unrelated entrypoints

**Machine-Readable Documentation Entry Points**:
Generated documentation files intended for LLM and coding-agent ingestion:
`llms.txt` as the curated map and `llms-full.txt` as the same map with selected
core docs inlined.
_Avoid_: treating generated LLM maps as hand-edited authority

**Coding Agent Documentation Callout**:
A prominent entrypoint block that tells coding agents exactly which
machine-readable files and agent operational docs to read before acting.
_Avoid_: agent install commands that are not backed by the current GBrain repo

**Release Evolution Ledger**:
The versioned record of shipped GBrain behavior used to trace how a feature
evolved across releases and to identify documentation that stopped tracking
that evolution. It informs current documentation updates, but does not replace
current operational or architecture authority.
_Avoid_: treating changelog history as the current operational guide

**Current Version Callout**:
A prominent README entrypoint that surfaces the current GBrain version and
routes readers to the latest release notes, upgrade guidance, and current
operational docs.
_Avoid_: burying current-version state inside release internals

**Production Operational Path**:
The operational branch for running GBrain as a production knowledge-base layer
for agents or teams, including topology, safety boundaries, credentials,
backup strategy, mode selection, and common failure modes.
_Avoid_: separate OPERATING.md when it would duplicate the Human Operational
Center

**Brain Repo Layout**:
The on-disk markdown structure GBrain syncs as the human-editable system of
record, including schema-pack and recommended-schema expectations. Obsidian
vaults are one import style, not the canonical name for every GBrain layout.
_Avoid_: vault as the generic canonical term

**Mode Selection Guide**:
A decision aid for when to use retrieval, synthesis, and maintenance surfaces
such as `gbrain search`, `gbrain think`, and `gbrain dream` or autopilot.
_Avoid_: search vs chat vs dream when chat is not the public command surface

**Production Checklist**:
A concise operational checklist for non-obvious production setup concerns such
as provider base URLs, key management, backups, MCP exposure, OAuth scopes, and
failure-mode verification.
_Avoid_: burying production gotchas in unrelated references

**Security-Driven Topology**:
A topology choice where the user may be solo but still needs a more complex
setup because of agent isolation, remote execution, credential boundaries,
network exposure, or implementation constraints.
_Avoid_: assuming solo always means simplest local install

**Reference Documentation**:
Documentation that explains architecture, design background, examples, or
specialized details. Reference Documentation can be broad and distributed, but
it must not be the only place where required operational setup facts live.
_Avoid_: operational guide when the document is contextual or explanatory
