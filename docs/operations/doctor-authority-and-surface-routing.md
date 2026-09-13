# Doctor Authority and Surface Routing

Every health report must identify its runtime, database and effective source
scope before interpreting differences between surfaces.

## Required evidence

- Surface and command: local CLI, stdio MCP or authenticated HTTP endpoint.
- Resolved executable or wrapper and runtime version/commit.
- Database identity without credentials, schema version and active schema pack.
- Effective source grant and whether the report is brain-wide or filtered.
- Doctor status, warning names, scores and elapsed time.
- Active-query and transaction state after diagnostics finish.

## Comparing surfaces

A trusted local brain-wide Doctor sees more than a scoped remote caller. Remote
checks and counts obey visibility constraints; different totals are expected
when source grants differ. Do not widen grants to make reports agree, and do
not invent report fields that the current runtime does not emit.

When results differ, compare runtime versions, database identity, schema pack,
source scope and observation time. Repair a stale or misrouted runtime when the
evidence supports it. Evaluate knowledge-quality warnings separately rather
than suppressing them because another surface reports a different score.

The configured host wrapper is the starting point for local diagnostics.
Reestablish live service, tunnel, database, worker and scheduler topology before
changing it. A public hostname or an old deployment note does not establish the
current hosting provider.

## Operational records

Keep exact topology, process observations, backup hashes, validation receipts
and rollback commands in the operator's protected infrastructure archive.
Public code and documentation should contain generic implementation details,
not private identifiers, credentials or diagnostic data. Record source scope
and freshness so another operator can reproduce the comparison.
