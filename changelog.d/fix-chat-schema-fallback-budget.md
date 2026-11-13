**Chat schema fallback checks the remaining budget before retrying.**

### Fixed
- When a provider rejects the schema, GBrain settles the first attempt before admitting a retry without a schema.
- A request refused before generation with no reported usage leaves the cap untouched. The retry still has to fit the remaining budget.
