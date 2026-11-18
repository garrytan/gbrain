//! The write trust context: the store's stand-in for the six transaction-local settings PGLite's
//! trust triggers and fence reads read with `current_setting(name, true)`.
//!
//! | Setting | Read as |
//! |---|---|
//! | `gbrain.write_trust_tier` | the writer's declared tier ([`WriteTrust::writer`]) |
//! | `gbrain.write_origin` | the write origin JSON ([`WriteTrust::origin`]) |
//! | `gbrain.write_trust_promotion` | the owner-confirmed raise ceiling ([`WriteTrust::promotion`]) |
//! | `gbrain.write_trust_backfill` | `on` turns the backfill rule on ([`WriteTrust::backfill`]) |
//! | `gbrain.write_trust_keep` | the tables whose content changes keep the tier ([`WriteTrust::keep`]) |
//! | `gbrain.write_open_facts` | the fact ids `gbrain repair open-facts` opens ([`FenceContext::opened`]) |
//!
//! The context holds the text each setting was last set to, as `set_config(name, value, true)`
//! does; a setting never set reads as `None` (SQL NULL) and one set to `''` reads as `''`. The
//! fence reads take it through [`Store::fence_context`]. The trust stamp (`trust::stamp`) takes it
//! through [`Store::write_trust`]: `Store::write` opens [`stamp_context`] with it for the write, and
//! the page writer (`pages::write_page`) stamps each page it stores with it.
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
//! name outside the six (the engine routes no other name here). TypeScript sets none of these.
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

/// The six settings, in the order the module table lists them.
pub const WRITE_TRUST_SETTINGS: [&str; 6] = [
    WRITE_TRUST_TIER,
    WRITE_ORIGIN,
    WRITE_TRUST_PROMOTION,
    WRITE_TRUST_BACKFILL,
    WRITE_TRUST_KEEP,
    WRITE_OPEN_FACTS,
];

/// The settings text of one open store (`Store::write_context`).
#[derive(Debug, Default)]
pub(crate) struct WriteContextSlot(Mutex<HashMap<&'static str, String>>);

impl WriteContextSlot {
    fn lock(&self) -> MutexGuard<'_, HashMap<&'static str, String>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The setting `name` is, or `invalid_argument` when it is none of the six.
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
    /// setting to the value at its index. All or nothing: a name outside the six, a value the trust
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
    /// was last set to, in `names` order; `None` where it was never set. A name outside the six is
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
        })
    }
}

/// The write trust context of the store write transaction that runs on this thread, as the
/// stamping writers read it: `Store::write` opens it with [`Store::write_trust`] and it ends with
/// the write, as `transaction_clock` does. A write outside one (a test that drives a writer on a
/// bare transaction) reads the empty context: an undeclared writer, stamped `unknown`.
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

    /// The open write's trust context, or the empty one outside a write.
    pub(crate) fn current() -> WriteTrust {
        CONTEXT.with(|c| c.borrow().clone().unwrap_or_default())
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
            }
        );
        s.clear_write_trust();
        let fence = s.fence_context();
        assert_eq!((fence.writer, fence.opened), (None, vec![]));
        assert_eq!(s.write_trust().unwrap(), WriteTrust::default());
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
                vec![WRITE_OPEN_FACTS, "gbrain.write_request"],
                vec!["1", "r1"],
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
