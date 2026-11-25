**Every result now says where its authority comes from, and `gbrain claims check` checks a draft's numbers against the facts pages you approved.**

<!-- behavior-change: precedence_allowed_claims_gst3827 -->

### Added
- Search, query, recall and `get_page` results carry a `precedence` field: `record`, `approved`, `curated`, `doc`, `chat` or `external`. Rule pages and facts pages marked `claims: allowed` read as `approved`, chat sources as `chat`, guest sources as `external`, everything else as `curated`. It is information only and changes no ranking or trust level.
- `gbrain sources set-precedence <id> <class>` (or `--clear`) sets a source's class.
- `gbrain claims check "<draft>"` and the MCP tool `check_claims` check each number in a draft against dated lines on your allowed-claims facts pages: supported (with the line cited), conflicts (a line says another number) or unsupported.
- New brains get `me/facts` and `company/facts` marked `claims: allowed` (brain layout version 4).

### Changed
- The `query` keyword-count line names the `since`, `until`, `lang` or `symbol_kind` filters the count applied that the `search --match keyword` listing cannot, and says that listing also holds pages the count left out.
