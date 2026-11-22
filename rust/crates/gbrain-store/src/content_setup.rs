//! The source read of content-root setup (`setupSharedBrainContent`, src/core/shared-skills/setup.ts; SQL in
//! src/core/engine-sql/content-setup.ts): the active source the setup is for. The setup's other read on this path, a
//! fresh database, is the brain's `created` flag. See rust/docs/store/content-setup.md.

use crate::Result;
use crate::Store;
use crate::sources::read_source;
use serde_json::{Value, json};

impl Store {
    /// `readContentSetupSource(sourceId)`: `{ id, incarnation, local_path }` of the source when it
    /// exists and is not archived, else null.
    pub fn read_content_setup_source(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        Ok(match read_source(&*read, source_id)? {
            Some(s) if !s.archived => json!({
                "id": s.id, "incarnation": s.incarnation, "local_path": s.local_path,
            }),
            _ => Value::Null,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::store;
    use serde_json::Value;

    #[test]
    fn the_setup_source_is_the_live_unarchived_source_or_null() {
        let store = store();
        let source = store.read_content_setup_source("default").unwrap();
        assert_eq!(source["id"], "default");
        assert_eq!(source["local_path"], Value::Null);
        assert!(
            source["incarnation"]
                .as_str()
                .is_some_and(|s| s.len() == 36)
        );
        assert_eq!(
            store.read_content_setup_source("missing").unwrap(),
            Value::Null
        );
        assert_eq!(
            store.read_content_setup_source("a\0b").unwrap(),
            Value::Null
        );
    }
}
