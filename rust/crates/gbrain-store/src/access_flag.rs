//! The sticky member-access flag: config `access.restrictions_present = '1'`.
//!
//! PGLite and Postgres set it from the trigger `pages_access_mark_restricted` (schema
//! migration v282): after a page row is inserted, or its frontmatter is updated, and the new
//! frontmatter has a top-level `readable_by` key. The store sets it from the page write hook
//! (`pages::write_page`), in the same write. Nothing here clears it.
//!
//! The trigger fires only when an UPDATE names the frontmatter column. The store sets the flag
//! on every write of a page that has `readable_by`. The flag is sticky, so the two differ only
//! after an operator unsets the flag by hand, and then the store sets it again sooner.
//!
//! The other trigger, `access_members_mark_restricted`, has its store half in
//! `access_members::insert_access_member`, in the same write as the member. See
//! `rust/docs/store/access-flag.md`.

use crate::error::Result;
use crate::keys;
use crate::kv::KvWrite;
use crate::pages::PageRecord;

/// The config key the flag lives under.
pub(crate) const RESTRICTIONS_PRESENT_KEY: &str = "access.restrictions_present";

/// Sets the flag when `record` carries a top-level `readable_by` frontmatter key and the flag is
/// not already `'1'`.
pub(crate) fn mark_restricted(tx: &mut dyn KvWrite, record: &PageRecord) -> Result<()> {
    if !record.frontmatter.contains_key("readable_by") {
        return Ok(());
    }
    let key = keys::text(keys::CONFIG, &[RESTRICTIONS_PRESENT_KEY]);
    if tx.get(&key)?.as_deref() == Some(b"1".as_slice()) {
        return Ok(());
    }
    tx.put(&key, b"1")
}
