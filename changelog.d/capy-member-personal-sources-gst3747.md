---
important: security
---
**One member's personal sources now stay away from other members' keys, and the `--as` preview shows that view.**

### Fixed
- A key bound to a member other than the owner that has no source list (for example a token from `gbrain auth create --member`) no longer reads another member's personal source, a source bound with `gbrain access member source add`, whether or not that source is federated, the `default` source included. It keeps its own member's personal sources and every shared source. Naming another member's personal source is refused with `permission_denied`, as for a source outside the grant. A local stdio server bound to a member follows the same rule, including one pinned with `GBRAIN_SOURCE` or `.gbrain-source`. The owner and every key bound to the owner lose nothing, and a key whose source list names a personal source keeps reading it. `gbrain access check --token` reports the new read set.
- `gbrain <read> --as <member>` now applies personal-source bindings the same way: `get`, `search`, `query`, `find` and `--source __all__` leave out other members' personal sources, naming one is refused with `permission_denied`, and `fetch` of one of its pages answers like a missing page. Writes under `--as` keep their usual source checks. The owner's preview is unchanged.
- Under `--as <member>`, `gbrain get` on a page the member cannot read (a folder rule or `readable_by`) now gives exactly the not-found answer a missing slug gives, text and JSON. Before, its hint named the source the page lives in. The plain local CLI keeps that hint.

<!-- behavior-change: member_keys_personal_sources_gst3747 -->
