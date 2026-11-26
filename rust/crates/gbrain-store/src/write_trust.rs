//! The write trust context: the store's stand-in for the ten transaction-local settings PGLite's
//! trust triggers, write attribution triggers and fence reads read with `current_setting(name, true)`.
//!
//! | Setting | Read as |
//! |---|---|
//! | `gbrain.write_trust_tier` | the writer's declared tier ([`WriteTrust::writer`]) |
//! | `gbrain.write_origin` | the write origin JSON ([`WriteTrust::origin`]) |
//! | `gbrain.write_trust_promotion` | the owner-confirmed raise ceiling ([`WriteTrust::promotion`]) |
//! | `gbrain.write_trust_backfill` | `on` turns the backfill rule on ([`WriteTrust::backfill`]) |
//! | `gbrain.write_trust_keep` | the tables whose content changes keep the tier ([`WriteTrust::keep`]) |
//! | `gbrain.write_open_facts` | the fact ids `gbrain repair open-facts` opens ([`FenceContext::opened`]) |
//! | `gbrain.write_request` | the request the write runs for ([`WriteAttribution::request_id`]) |
//! | `gbrain.write_principal_kind` | the kind of the writing principal ([`WriteAttribution::principal_kind`]) |
//! | `gbrain.write_principal_id` | the id of the writing principal ([`WriteAttribution::principal_id`]) |
//!
//! The context holds the text each setting was last set to, as `set_config(name, value, true)`
//! does; a setting never set reads as `None` (SQL NULL) and one set to `''` reads as `''`. The
//! fence reads take it through [`Store::fence_context`]. The trust stamp (`trust::stamp`) takes it
//! through [`Store::write_trust`]: `Store::write` opens [`stamp_context`] with it for the write, and
//! the page writer (`pages::write_page`) stamps each page it stores with it. The timeline writer
//! (`timeline::put_entry`) stamps each entry's write receipt with its [`WriteTrust::attribution`],
//! as `gbrain_stamp_write_attribution` (persistence/attribution-schema.ts) does.
//!
//! Lifetime: PGLite ends the settings with the transaction (`SET LOCAL`). Each store has its own
//! context: a store bound to a transaction (`Store::begin_transaction`) starts with an empty one,
//! and the shared store never sees it. The engine's transaction sets it on its own handle and
//! clears it with [`Store::clear_write_trust`] at commit or rollback
//! (docs/designs/RUST_ENGINE_INTERFACES.md, "Write trust context").
//!
//! Stricter than PGLite, on purpose: a value the trust rules would refuse when they read it is
//! refused when it is set (`invalid_argument`), with the context unchanged: a tier or promotion
//! name that is no tier (PGLite raises `22023` in the stamp trigger, and the fence read ranks it 0),
//! a `write_origin` that is not JSON (PGLite raises at `::jsonb` in the trigger), and a setting
//! name outside the ten (the engine routes no other name here). TypeScript sets none of these. A
//! `write_request` that is not a UUID is kept as set, as `set_config` keeps it; the page, version,
//! fact, take and timeline writes refuse it, as the attribution triggers raise at their `::uuid`
//! cast ([`WriteAttribution::refuse_request_not_uuid`]).
//!
//! Keys: none. The context is per open store, in memory, never written.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;

use crate::Store;
use crate::error::{Result, StoreError};
use crate::facts::FenceContext;
use crate::trust::{TrustTable, TrustTier, WriteTrust};

/// `gbrain.write_trust_tier`.
pub const WRITE_TRUST_TIER: &str = "gbrain.write_trust_tier";
/// `gbrain.write_origin`.
pub const WRITE_ORIGIN: &str = "gbrain.write_origin";
/// `gbrain.write_trust_promotion`.
pub const WRITE_TRUST_PROMOTION: &str = "gbrain.write_trust_promotion";
/// `gbrain.write_trust_backfill`.
pub const WRITE_TRUST_BACKFILL: &str = "gbrain.write_trust_backfill";
/// `gbrain.write_trust_keep`.
pub const WRITE_TRUST_KEEP: &str = "gbrain.write_trust_keep";
/// `gbrain.write_open_facts`.
pub const WRITE_OPEN_FACTS: &str = "gbrain.write_open_facts";
/// `gbrain.write_request`.
pub const WRITE_REQUEST: &str = "gbrain.write_request";
/// `gbrain.write_principal_kind`.
pub const WRITE_PRINCIPAL_KIND: &str = "gbrain.write_principal_kind";
/// `gbrain.write_principal_id`.
pub const WRITE_PRINCIPAL_ID: &str = "gbrain.write_principal_id";
/// `gbrain.guest_note`: the write request a guest note's publication names (guests/admission.ts).
pub const WRITE_GUEST_NOTE: &str = "gbrain.guest_note";

/// The ten settings, in the order the module table lists them.
pub const WRITE_TRUST_SETTINGS: [&str; 10] = [
    WRITE_TRUST_TIER,
    WRITE_ORIGIN,
    WRITE_TRUST_PROMOTION,
    WRITE_TRUST_BACKFILL,
    WRITE_TRUST_KEEP,
    WRITE_OPEN_FACTS,
    WRITE_REQUEST,
    WRITE_PRINCIPAL_KIND,
    WRITE_PRINCIPAL_ID,
    WRITE_GUEST_NOTE,
];

/// The actor of one write, as the attribution trigger reads it: each setting with `''` read as
/// unset (`NULLIF(current_setting(name, true), '')`). The request id is lower case, as a `uuid`
/// reads back; every row writer the attribution triggers cover refuses one that is not a UUID
/// ([`WriteAttribution::refuse_request_not_uuid`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WriteAttribution {
    /// `gbrain.write_request`: the persistence request, or `None` for a write with no journal request.
    pub request_id: Option<String>,
    /// `gbrain.write_principal_kind`. `None` is a write with no principal: inserts stay unattributed.
    pub principal_kind: Option<String>,
    /// `gbrain.write_principal_id`.
    pub principal_id: Option<String>,
}

impl WriteAttribution {
    /// `invalid_argument` when `gbrain.write_request` is set and is not a UUID. PGLite's three
    /// attribution triggers (`gbrain_stamp_write_attribution`, `gbrain_stamp_revision_attribution`,
    /// `gbrain_stamp_version_attribution`) cast it with `::uuid` before anything else, so every row
    /// written to `pages`, `page_versions`, `facts`, `takes` and `timeline_entries` raises: the page,
    /// version, fact, take and timeline writers call this first.
    pub(crate) fn refuse_request_not_uuid(&self) -> Result<()> {
        match self.request_id.as_deref() {
            Some(request) if !crate::env::is_uuid(request) => Err(StoreError::invalid(format!(
                "{WRITE_REQUEST} is not a UUID: {request}"
            ))),
            _ => Ok(()),
        }
    }
}

/// The settings text of one open store (`Store::write_context`).
#[derive(Debug, Default)]
pub(crate) struct WriteContextSlot(Mutex<HashMap<&'static str, String>>);

impl WriteContextSlot {
    fn lock(&self) -> MutexGuard<'_, HashMap<&'static str, String>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The setting `name` is, or `invalid_argument` when it is none of the ten.
fn setting(name: &str) -> Result<&'static str> {
    WRITE_TRUST_SETTINGS
        .into_iter()
        .find(|known| *known == name)
        .ok_or_else(|| {
            StoreError::invalid(format!(
                "{name} is not a write trust setting (expected one of {})",
                WRITE_TRUST_SETTINGS.join(", ")
            ))
        })
}

/// Checks that `value` is one the trust rules read without error (the module's "Stricter than
/// PGLite" list).
fn check(name: &'static str, value: &str) -> Result<()> {
    match name {
        WRITE_TRUST_TIER | WRITE_TRUST_PROMOTION => {
            TrustTier::from_setting(Some(value)).map(|_| ())
        }
        WRITE_ORIGIN if !value.is_empty() => serde_json::from_str::<Value>(value)
            .map(|_| ())
            .map_err(|e| StoreError::invalid(format!("{WRITE_ORIGIN} is not JSON: {e}"))),
        _ => Ok(()),
    }
}

/// `f.id::text = ANY(string_to_array(setting, ','))`: the ids whose text is a list piece. A piece
/// that is not the canonical text of an id (`007`, ` 7`, `x`) matches no row, as the text
/// comparison does.
fn opened_ids(setting: Option<&str>) -> Vec<u64> {
    setting
        .unwrap_or("")
        .split(',')
        .filter_map(|piece| {
            piece
                .parse::<u64>()
                .ok()
                .filter(|id| id.to_string() == piece)
        })
        .collect()
}

impl Store {
    /// `applyTransactionSettings(names, values)` for the write trust settings: sets each named
    /// setting to the value at its index. All or nothing: a name outside the ten, a value the trust
    /// rules refuse, or lists of different lengths is `invalid_argument` and changes nothing.
    pub fn apply_write_trust(&self, names: &[String], values: &[String]) -> Result<()> {
        if names.len() != values.len() {
            return Err(StoreError::invalid(format!(
                "applyWriteTrust: {} names and {} values",
                names.len(),
                values.len()
            )));
        }
        let mut checked = Vec::with_capacity(names.len());
        for (name, value) in names.iter().zip(values) {
            let name = setting(name)?;
            check(name, value)?;
            checked.push((name, value.clone()));
        }
        let mut slot = self.write_context.lock();
        for (name, value) in checked {
            slot.insert(name, value);
        }
        Ok(())
    }

    /// `readTransactionSettings(names)` for the write trust settings: the text each named setting
    /// was last set to, in `names` order; `None` where it was never set. A name outside the ten is
    /// `invalid_argument`.
    pub fn read_write_trust(&self, names: &[String]) -> Result<Vec<Option<String>>> {
        let names = names
            .iter()
            .map(|name| setting(name))
            .collect::<Result<Vec<_>>>()?;
        let slot = self.write_context.lock();
        Ok(names
            .into_iter()
            .map(|name| slot.get(name).cloned())
            .collect())
    }

    /// Ends the context, as the end of a PGLite transaction ends its `SET LOCAL` settings: every
    /// setting reads as never set again.
    pub fn clear_write_trust(&self) {
        self.write_context.lock().clear();
    }

    /// What the fence reads take from the context: the writer's declared tier and the opened ids.
    pub fn fence_context(&self) -> FenceContext {
        let slot = self.write_context.lock();
        FenceContext {
            writer: slot
                .get(WRITE_TRUST_TIER)
                .filter(|tier| !tier.is_empty())
                .cloned(),
            opened: opened_ids(slot.get(WRITE_OPEN_FACTS).map(String::as_str)),
        }
    }

    /// The context as the trust stamp reads it (`trust::stamp`). Values were checked when set.
    pub(crate) fn write_trust(&self) -> Result<WriteTrust> {
        let slot = self.write_context.lock();
        let text = |name: &str| slot.get(name).map(String::as_str);
        Ok(WriteTrust {
            writer: TrustTier::from_setting(text(WRITE_TRUST_TIER))?,
            origin: match text(WRITE_ORIGIN) {
                None | Some("") => None,
                Some(origin) => Some(serde_json::from_str(origin).map_err(|e| {
                    StoreError::invalid(format!("{WRITE_ORIGIN} is not JSON: {e}"))
                })?),
            },
            promotion: TrustTier::from_setting(text(WRITE_TRUST_PROMOTION))?,
            backfill: text(WRITE_TRUST_BACKFILL) == Some("on"),
            keep: TrustTable::keep_list(text(WRITE_TRUST_KEEP)),
            attribution: attribution(&text),
            // `COALESCE(NULLIF(current_setting('gbrain.guest_note', true), '') = current_setting('gbrain.write_request', true), false)`.
            guest_note_is_request: text(WRITE_GUEST_NOTE)
                .is_some_and(|note| !note.is_empty() && text(WRITE_REQUEST) == Some(note)),
        })
    }
}

/// The three attribution settings as the trigger reads them (`NULLIF(.., '')`).
fn attribution<'a>(text: &impl Fn(&str) -> Option<&'a str>) -> WriteAttribution {
    let set = |name: &str| text(name).filter(|v| !v.is_empty()).map(str::to_string);
    WriteAttribution {
        request_id: set(WRITE_REQUEST).map(|id| id.to_ascii_lowercase()),
        principal_kind: set(WRITE_PRINCIPAL_KIND),
        principal_id: set(WRITE_PRINCIPAL_ID),
    }
}

/// The write trust context of the store write transaction that runs on this thread, as the
/// stamping writers read it: `Store::write` opens it with [`Store::write_trust`] and it ends with
/// the write, as `transaction_clock` does. A page write outside one refuses
/// (`invalid_argument`, "a page write ran outside a store write transaction"), as the projection
/// queue's clock read does: the stamp never guesses a writer.
pub(crate) mod stamp_context {
    use crate::trust::WriteTrust;
    use std::cell::RefCell;

    thread_local! {
        static CONTEXT: RefCell<Option<WriteTrust>> = const { RefCell::new(None) };
    }

    /// Restores the context of the enclosing scope when the write transaction ends.
    pub(crate) struct Scope(Option<WriteTrust>);

    impl Drop for Scope {
        fn drop(&mut self) {
            let outer = self.0.take();
            CONTEXT.with(|c| *c.borrow_mut() = outer);
        }
    }

    pub(crate) fn open(trust: WriteTrust) -> Scope {
        Scope(CONTEXT.with(|c| c.borrow_mut().replace(trust)))
    }

    /// The open write's trust context. Outside a store write it refuses.
    pub(crate) fn current() -> crate::Result<WriteTrust> {
        CONTEXT.with(|c| c.borrow().clone()).ok_or_else(|| {
            crate::error::StoreError::invalid("a page write ran outside a store write transaction")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::INVALID_ARGUMENT;
    use crate::test_support::store;
    use serde_json::json;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_request_that_is_not_a_uuid_refuses_and_a_uuid_or_none_passes() {
        let with = |request: Option<&str>| WriteAttribution {
            request_id: request.map(str::to_string),
            ..WriteAttribution::default()
        };
        let refused = with(Some("req-1")).refuse_request_not_uuid().unwrap_err();
        assert_eq!(refused.code, INVALID_ARGUMENT);
        assert_eq!(refused.message, "gbrain.write_request is not a UUID: req-1");
        with(Some("7c1e2a9e-5b3f-4d0a-9e61-0000000000a1"))
            .refuse_request_not_uuid()
            .unwrap();
        with(None).refuse_request_not_uuid().unwrap();
    }

    #[test]
    fn the_stamp_context_refuses_outside_a_write_and_restores_the_outer_scope() {
        let outside = stamp_context::current().unwrap_err();
        assert_eq!(outside.code, INVALID_ARGUMENT);
        assert!(
            outside
                .message
                .contains("outside a store write transaction")
        );
        let outer = WriteTrust {
            writer: Some(crate::trust::TrustTier::AgentWritten),
            ..WriteTrust::default()
        };
        let scope = stamp_context::open(outer.clone());
        assert_eq!(stamp_context::current().unwrap().writer, outer.writer);
        {
            let _inner = stamp_context::open(WriteTrust::default());
            assert_eq!(stamp_context::current().unwrap().writer, None);
        }
        assert_eq!(stamp_context::current().unwrap().writer, outer.writer);
        drop(scope);
        assert!(stamp_context::current().is_err());
    }

    #[test]
    fn a_second_transaction_waits_for_the_writer_and_starts_with_an_empty_context() {
        use std::sync::mpsc;
        use std::time::Duration;

        let s = store();
        let tier = strings(&[WRITE_TRUST_TIER]);
        let tx1 = s.begin_transaction(false).unwrap();
        tx1.apply_write_trust(&tier, &strings(&["agent_written"]))
            .unwrap();
        std::thread::scope(|scope| {
            let (began, began_rx) = mpsc::channel();
            let (go_on, go_on_rx) = mpsc::channel::<()>();
            let (shared, names) = (&s, &tier);
            let second = scope.spawn(move || {
                let tx2 = shared.begin_transaction(false).unwrap();
                began.send(tx2.read_write_trust(names).unwrap()).unwrap();
                go_on_rx.recv().unwrap();
                tx2.apply_write_trust(names, &strings(&["operator_curated"]))
                    .unwrap();
                let own = tx2.read_write_trust(names).unwrap();
                tx2.commit_transaction().unwrap();
                own
            });
            // The store has one writer: the second transaction cannot begin while the first is open.
            assert!(
                began_rx.recv_timeout(Duration::from_millis(200)).is_err(),
                "a second write transaction began while the first was open"
            );
            assert_eq!(s.read_write_trust(&tier).unwrap(), vec![None]);
            assert_eq!(
                tx1.read_write_trust(&tier).unwrap(),
                vec![Some("agent_written".to_string())]
            );
            tx1.commit_transaction().unwrap();
            assert_eq!(
                began_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
                vec![None]
            );
            go_on.send(()).unwrap();
            assert_eq!(
                second.join().unwrap(),
                vec![Some("operator_curated".to_string())]
            );
        });
        assert_eq!(s.read_write_trust(&tier).unwrap(), vec![None]);
    }

    #[test]
    fn a_setting_never_set_reads_as_null_and_one_set_empty_reads_as_empty() {
        let s = store();
        let names = strings(&[WRITE_TRUST_TIER, WRITE_OPEN_FACTS]);
        assert_eq!(s.read_write_trust(&names).unwrap(), vec![None, None]);
        s.apply_write_trust(&strings(&[WRITE_TRUST_TIER]), &strings(&[""]))
            .unwrap();
        assert_eq!(
            s.read_write_trust(&names).unwrap(),
            vec![Some(String::new()), None]
        );
        s.clear_write_trust();
        assert_eq!(s.read_write_trust(&names).unwrap(), vec![None, None]);
    }

    #[test]
    fn values_read_back_as_set_and_feed_the_fence_context_and_the_stamp() {
        let s = store();
        let origin = r#"{ "channel": "mcp:put_page" }"#;
        s.apply_write_trust(
            &strings(&WRITE_TRUST_SETTINGS),
            &strings(&[
                "agent_written",
                origin,
                "operator_curated",
                "on",
                "facts,nope,takes",
                "7,007, 8,x,9",
                "0B9C4F0E-1A2B-4C3D-8E4F-5A6B7C8D9E01",
                "application",
                "host:test",
            ]),
        )
        .unwrap();
        assert_eq!(
            s.read_write_trust(&strings(&[WRITE_ORIGIN, WRITE_OPEN_FACTS]))
                .unwrap(),
            vec![Some(origin.to_string()), Some("7,007, 8,x,9".to_string())]
        );
        let fence = s.fence_context();
        assert_eq!(fence.writer.as_deref(), Some("agent_written"));
        assert_eq!(fence.opened, vec![7, 9]);
        assert_eq!(
            s.write_trust().unwrap(),
            WriteTrust {
                writer: Some(TrustTier::AgentWritten),
                origin: Some(json!({ "channel": "mcp:put_page" })),
                promotion: Some(TrustTier::OperatorCurated),
                backfill: true,
                keep: vec![TrustTable::Facts, TrustTable::Takes],
                attribution: WriteAttribution {
                    request_id: Some("0b9c4f0e-1a2b-4c3d-8e4f-5a6b7c8d9e01".into()),
                    principal_kind: Some("application".into()),
                    principal_id: Some("host:test".into()),
                },
            }
        );
        assert_eq!(
            s.read_write_trust(&strings(&[WRITE_REQUEST])).unwrap(),
            vec![Some("0B9C4F0E-1A2B-4C3D-8E4F-5A6B7C8D9E01".to_string())]
        );
        s.clear_write_trust();
        let fence = s.fence_context();
        assert_eq!((fence.writer, fence.opened), (None, vec![]));
        assert_eq!(s.write_trust().unwrap(), WriteTrust::default());
    }

    #[test]
    fn a_request_that_is_not_a_uuid_is_kept_as_set() {
        let s = store();
        s.apply_write_trust(&strings(&[WRITE_REQUEST]), &strings(&["req-1"]))
            .unwrap();
        assert_eq!(
            s.read_write_trust(&strings(&[WRITE_REQUEST])).unwrap(),
            vec![Some("req-1".to_string())]
        );
        assert_eq!(
            s.write_trust().unwrap().attribution.request_id.as_deref(),
            Some("req-1")
        );
    }

    #[test]
    fn an_empty_attribution_setting_reads_as_unset() {
        let s = store();
        s.apply_write_trust(
            &strings(&[WRITE_REQUEST, WRITE_PRINCIPAL_KIND, WRITE_PRINCIPAL_ID]),
            &strings(&["", "", "host:orphan"]),
        )
        .unwrap();
        assert_eq!(
            s.write_trust().unwrap().attribution,
            WriteAttribution {
                request_id: None,
                principal_kind: None,
                principal_id: Some("host:orphan".into()),
            }
        );
    }

    #[test]
    fn an_empty_tier_is_an_undeclared_writer_and_an_empty_open_list_opens_nothing() {
        let s = store();
        s.apply_write_trust(
            &strings(&[WRITE_TRUST_TIER, WRITE_OPEN_FACTS]),
            &strings(&["", ""]),
        )
        .unwrap();
        let fence = s.fence_context();
        assert_eq!((fence.writer, fence.opened), (None, vec![]));
        assert_eq!(s.write_trust().unwrap().writer, None);
    }

    #[test]
    fn a_refused_apply_changes_nothing() {
        let s = store();
        s.apply_write_trust(&strings(&[WRITE_TRUST_TIER]), &strings(&["tool_observed"]))
            .unwrap();
        for (names, values) in [
            (vec![WRITE_OPEN_FACTS, WRITE_TRUST_TIER], vec!["1", "root"]),
            (
                vec![WRITE_OPEN_FACTS, WRITE_TRUST_PROMOTION],
                vec!["1", "boss"],
            ),
            (vec![WRITE_OPEN_FACTS, WRITE_ORIGIN], vec!["1", "{not json"]),
            (
                vec![WRITE_OPEN_FACTS, "gbrain.write_sources"],
                vec!["1", "[]"],
            ),
            (vec![WRITE_OPEN_FACTS], vec![]),
        ] {
            let err = s
                .apply_write_trust(&strings(&names), &strings(&values))
                .unwrap_err();
            assert_eq!(err.code, INVALID_ARGUMENT, "{names:?}");
        }
        assert_eq!(
            s.read_write_trust(&strings(&[WRITE_TRUST_TIER, WRITE_OPEN_FACTS]))
                .unwrap(),
            vec![Some("tool_observed".to_string()), None]
        );
        let err = s
            .read_write_trust(&strings(&["gbrain.write_sources"]))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }
}
