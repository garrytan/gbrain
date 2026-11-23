//! `readSharedSourceRows`: the source rows the read-shared switch's shared set is built from
//! (`src/core/engine-sql/read-shared-sources.ts`, PGLite's `READ_SHARED_SOURCE_ROWS_SQL`).
//!
//! Every source not archived, in byte order of its id (`ORDER BY s.id COLLATE "C"`), as
//! `{ id, config, guest, owners, owner_member }`:
//! - `guest`: `config->>'guest' = 'true'` (a JSON `true` or the string `"true"`). The store has no
//!   `guest_sources` table, so a config flag is the only guest mark.
//! - `owners`: the members the source is bound to (`access_member_sources`). The store keeps no
//!   member-source bindings, so the list is empty.
//! - `owner_member`: the `access.owner_member` config value with its spaces trimmed (`btrim`), or
//!   null when it is not set.

use crate::cli_reads::pg_text::btrim;
use crate::config::read_config;
use crate::sources::all_sources;
use crate::{Result, Store};
use serde_json::{Value, json};

/// The config key that names the brain owner's member id (`OWNER_MEMBER_KEY`).
const OWNER_MEMBER_KEY: &str = "access.owner_member";

/// `config->>'guest' = 'true'`.
fn guest(config: &serde_json::Map<String, Value>) -> bool {
    match config.get("guest") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        _ => false,
    }
}

impl Store {
    /// `readSharedSourceRows()`: every live source with its config, guest flag, bound members
    /// and the brain owner's member id.
    pub fn read_shared_source_rows(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let owner = read_config(&*read, OWNER_MEMBER_KEY)?.map(|v| btrim(&v).to_owned());
        let mut sources = all_sources(&*read)?;
        sources.retain(|s| !s.archived);
        sources.sort_by(|a, b| a.id.as_bytes().cmp(b.id.as_bytes()));
        Ok(sources
            .iter()
            .map(|s| {
                json!({
                    "id": s.id,
                    "config": Value::Object(s.config.clone()),
                    "guest": guest(&s.config),
                    "owners": Vec::<String>::new(),
                    "owner_member": owner,
                })
            })
            .collect())
    }
}
