**`gbrain engine swap --plan` on a managed brain now names the two gaps managed mode still has on the Rust engine, instead of showing a plan with no gaps.**

### Changed
- The engine swap plan for a managed brain carries a `managed_known_losses` list, and the text plan prints one "known loss" line per entry. Today it names two: removing a page can stop before it commits, and a write on a rooted source no writer has claimed can stop after it claims the source, leaving it claimed with no write. PGLite and Postgres finish both writes. An unmanaged brain's plan does not carry the field.
