**An agent can review take proposals for a person over MCP.**

<!-- behavior-change: take_proposal_review_ops -->

### Added
- `takes_proposals_list` / `takes_proposal_get` (read) and `takes_proposal_accept` / `takes_proposal_reject` (write) review the propose_takes queue over MCP. Accept takes the same optional edits as `gbrain takes propose --accept` (claim, weight, kind, holder; the take's source then says "(edited)") and writes through the coordinated takes_add path as the caller: the caller's takes-holder allow-list applies (a gateway that should accept `brain`-held proposals needs `gbrain auth rescope --token <name> --takes-holders world,brain`), and the page version records its agent label. Reject takes an optional reason.
- `take_proposals` gains `acted_via` (cli, mcp:<client>) and `decision_reason` (schema migration v332). Remote callers see only proposals in their source grant, on pages they may read, whose holder their allow-list admits.
