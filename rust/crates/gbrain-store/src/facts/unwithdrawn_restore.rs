//! The classifier read of `gbrain repair unwithdrawn-facts` beyond its listing
//! (`src/core/engine-sql/unwithdrawn-restore.ts`): a candidate's page body by id. The restore runs
//! only inside a managed publication, which the store does not carry yet.
//!
//! Member: readPageInlineBody. It adds no keys. See rust/docs/store/facts.md, "The fence
//! projection's statements".

use crate::Store;
use crate::dream::int4;
use crate::error::Result;
use crate::mention_state::body_storage;
use crate::pages::read_page_by_id;
use serde_json::{Value, json};

impl Store {
    /// `readPageInlineBody(pageId)`: `{ id, compiled_truth, timeline, body_storage }` of page
    /// `pageId` in any state, the two body columns null for a segmented body; null for no page.
    pub fn read_page_inline_body(&self, page_id: f64) -> Result<Value> {
        let id = int4("readPageInlineBody", "pageId", page_id)?;
        let Ok(id) = u64::try_from(id) else {
            return Ok(Value::Null);
        };
        let read = self.read()?;
        let Some(page) = read_page_by_id(&*read, id)? else {
            return Ok(Value::Null);
        };
        let storage = body_storage(&*read, &page)?;
        let segmented = storage == "segmented";
        Ok(json!({
            "id": page.id,
            "compiled_truth": if segmented { None } else { page.compiled_truth.as_deref() },
            "timeline": if segmented { None } else { page.timeline.as_deref() },
            "body_storage": storage,
        }))
    }
}
