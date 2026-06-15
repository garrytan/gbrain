# Centralize operational documentation

GBrain may keep broad reference, architecture, tutorial, and client-specific
documentation, but installation, connection, upgrade, and Core Operational Usage
paths must be centralized and correct enough that readers do not need to
reconstruct an operational flow from scattered specialized pages. Specialized
docs may expand details, but they must not be the only place where required
setup or usage facts exist.

Core operational documentation should present operating model and deployment
topology as separate axes. Personal versus shared group usage explains who owns
and uses the brain; local, remote/thin-client, split-engine, and mounted-brain
topologies explain how that brain is installed, exposed, and connected.

The README should route readers into the correct operational center rather than
owning detailed setup. `docs/INSTALL.md` is the Human Operational Center.
`INSTALL_FOR_AGENTS.md` is the Agent Operational Center. Agent entrypoints may
carry critical safety gates, but required agent setup flow should not be spread
across unrelated docs.

Machine-readable documentation entrypoints should be promoted as part of the
same operational routing surface. GBrain already has generated `llms.txt` and
`llms-full.txt`; documentation should expose those and the agent operational
center before inventing or advertising an installable docs skill that is not yet
published by the repo.

`CHANGELOG.md` should have a central role as the Release Evolution Ledger. It
helps explain how current behavior evolved across versions and flags docs that
stopped tracking that evolution, but it does not replace current operational
centers or current-state architecture references.

Production-oriented operator needs should be absorbed into the same operational
centers rather than creating another overlapping authority surface. A production
path, brain repo layout, mode selection guide, safety boundaries, common failure
modes, and production checklist belong in the Human Operational Center with
agent-specific gates mirrored in the Agent Operational Center.
