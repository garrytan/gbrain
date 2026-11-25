//! Write receipts: who wrote a row and who last changed it, as the PGLite attribution triggers
//! stamp them (src/core/persistence/attribution-schema.ts).
//!
//! - [`WriteReceipt`]: the seven `gbrain_stamp_write_attribution` columns of `facts`, `takes` and
//!   `timeline_entries`. Insert: under a principal (`gbrain.write_principal_kind` set), `write_*`
//!   and `last_*` take the actor and `last_written_at` the transaction time; with no principal
//!   the row keeps what it was given. Update: `write_*` keep the stored values when any is set;
//!   when the table's content tuple changed, `last_*` take the actor of this write (null when
//!   there is none) and the transaction time; otherwise they keep the stored values.
//! - [`RevisionReceipt`]: `pages.revision_*` (`gbrain_stamp_revision_attribution`). Insert under
//!   a principal takes the actor; an update that changes `knowledge_revision` takes the actor
//!   (null included); any other update keeps the stored values.
//! - [`VersionReceipt`]: `page_versions.write_*` and `archived_*`
//!   (`gbrain_stamp_version_attribution`). `write_*` copy the snapshotted page's revision
//!   receipt; `archived_*` take the actor when a principal is set.
//!
//! The actor comes from the open write's context (`write_trust::stamp_context`), the time from
//! `env::transaction_clock`. A `gbrain.write_request` that is not a UUID refuses every stamped
//! write (`invalid_argument`), as the triggers cast it with `::uuid` first. Keys: none; each
//! receipt is part of its row's record.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::env::{iso, transaction_clock};
use crate::error::{Result, StoreError};
use crate::write_trust::{WriteAttribution, stamp_context};

/// The open write's actor, its request id checked as the trigger's `::uuid` cast checks it.
pub(crate) fn actor() -> Result<WriteAttribution> {
    checked(&stamp_context::current()?.attribution).cloned()
}

/// `actor`, refused when its request id is not a UUID.
fn checked(actor: &WriteAttribution) -> Result<&WriteAttribution> {
    actor.refuse_request_not_uuid()?;
    Ok(actor)
}

fn now() -> Result<i64> {
    transaction_clock::transaction_now()
        .ok_or_else(|| StoreError::invalid("a row write ran outside a store write transaction"))
}

/// The seven row receipt columns. A record stored before the receipt reads every one as null.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct WriteReceipt {
    pub write_request_id: Option<String>,
    pub write_principal_kind: Option<String>,
    pub write_principal_id: Option<String>,
    pub last_write_request_id: Option<String>,
    pub last_write_principal_kind: Option<String>,
    pub last_write_principal_id: Option<String>,
    pub last_written_at_us: Option<i64>,
}

impl WriteReceipt {
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn written_by(&self) -> bool {
        self.write_request_id.is_some()
            || self.write_principal_kind.is_some()
            || self.write_principal_id.is_some()
    }

    fn last_written(&self) -> bool {
        self.last_write_request_id.is_some()
            || self.last_write_principal_kind.is_some()
            || self.last_write_principal_id.is_some()
            || self.last_written_at_us.is_some()
    }

    fn set_last(&mut self, actor: &WriteAttribution, at: i64) {
        self.last_write_request_id = actor.request_id.clone();
        self.last_write_principal_kind = actor.principal_kind.clone();
        self.last_write_principal_id = actor.principal_id.clone();
        self.last_written_at_us = Some(at);
    }

    fn take_last(&mut self, old: &Self) {
        self.last_write_request_id = old.last_write_request_id.clone();
        self.last_write_principal_kind = old.last_write_principal_kind.clone();
        self.last_write_principal_id = old.last_write_principal_id.clone();
        self.last_written_at_us = old.last_written_at_us;
    }

    /// The receipt the trigger leaves: `supplied` is the receipt the write put on the row (the
    /// stored one when it left the columns alone), `old` the stored receipt (`None` on insert),
    /// `changed` whether the table's content tuple changed.
    pub(crate) fn stamp(old: Option<&Self>, supplied: &Self, changed: bool) -> Result<Self> {
        Self::stamp_as(&actor()?, old, supplied, changed)
    }

    /// [`WriteReceipt::stamp`] for a writer that carries its trust context itself (the facts
    /// writers take a `WriteTrust`): `actor` is that context's attribution.
    pub(crate) fn stamp_as(
        actor: &WriteAttribution,
        old: Option<&Self>,
        supplied: &Self,
        changed: bool,
    ) -> Result<Self> {
        let actor = checked(actor)?;
        let mut out = supplied.clone();
        let Some(old) = old else {
            if actor.principal_kind.is_some() {
                out.write_request_id = actor.request_id.clone();
                out.write_principal_kind = actor.principal_kind.clone();
                out.write_principal_id = actor.principal_id.clone();
                out.set_last(actor, now()?);
            }
            return Ok(out);
        };
        if old.written_by() {
            out.write_request_id = old.write_request_id.clone();
            out.write_principal_kind = old.write_principal_kind.clone();
            out.write_principal_id = old.write_principal_id.clone();
        }
        if changed {
            out.set_last(actor, now()?);
        } else if old.last_written() {
            out.take_last(old);
        }
        Ok(out)
    }

    /// The seven columns of a row; `last_written_at` is an ISO string.
    pub(crate) fn extend_json(&self, row: &mut Map<String, Value>) {
        let cols = [
            ("write_request_id", &self.write_request_id),
            ("write_principal_kind", &self.write_principal_kind),
            ("write_principal_id", &self.write_principal_id),
            ("last_write_request_id", &self.last_write_request_id),
            ("last_write_principal_kind", &self.last_write_principal_kind),
            ("last_write_principal_id", &self.last_write_principal_id),
        ];
        for (name, value) in cols {
            row.insert(name.into(), json!(value));
        }
        row.insert(
            "last_written_at".into(),
            json!(self.last_written_at_us.map(iso)),
        );
    }
}

/// One actor as three nullable columns (`pages.revision_*`, half of a version receipt).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct ActorColumns {
    pub request_id: Option<String>,
    pub principal_kind: Option<String>,
    pub principal_id: Option<String>,
}

impl ActorColumns {
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn of(actor: &WriteAttribution) -> Self {
        Self {
            request_id: actor.request_id.clone(),
            principal_kind: actor.principal_kind.clone(),
            principal_id: actor.principal_id.clone(),
        }
    }

    /// `{req, kind, pid}`, the shape the attribution reads return.
    pub(crate) fn to_json(&self) -> Value {
        json!({ "req": self.request_id, "kind": self.principal_kind, "pid": self.principal_id })
    }
}

/// `pages.revision_*`: the actor that wrote the live page revision.
pub(crate) type RevisionReceipt = ActorColumns;

/// The revision receipt `gbrain_stamp_revision_attribution` leaves on a page write: `old` is the
/// stored receipt and revision (`None` on insert), `supplied` the receipt the record carries.
pub(crate) fn stamp_revision(
    old: Option<(&RevisionReceipt, &str)>,
    supplied: &RevisionReceipt,
    new_revision: &str,
) -> Result<RevisionReceipt> {
    let actor = actor()?;
    Ok(match old {
        None if actor.principal_kind.is_some() => ActorColumns::of(&actor),
        None => supplied.clone(),
        Some((_, revision)) if revision != new_revision => ActorColumns::of(&actor),
        // No page write sets the `revision_*` columns itself, so an unchanged revision keeps the
        // stored writer, NULLs included; the record's copy can be stale (a second write in one call).
        Some((stored, _)) => stored.clone(),
    })
}

/// `page_versions.write_*` and `archived_*`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct VersionReceipt {
    #[serde(skip_serializing_if = "ActorColumns::is_empty")]
    pub written: ActorColumns,
    #[serde(skip_serializing_if = "ActorColumns::is_empty")]
    pub archived: ActorColumns,
}

impl VersionReceipt {
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// The receipt of a snapshot of a page whose revision receipt is `page_revision`: the
    /// snapshot is the page's revision as stored, so `write_*` are its writer; `archived_*` take
    /// the actor of this write when a principal is set.
    pub(crate) fn stamp(page_revision: &RevisionReceipt) -> Result<Self> {
        let actor = actor()?;
        Ok(Self {
            written: page_revision.clone(),
            archived: if actor.principal_kind.is_some() {
                ActorColumns::of(&actor)
            } else {
                ActorColumns::default()
            },
        })
    }
}

/// `IS DISTINCT FROM` for floats: NaN equals NaN, as Postgres orders it.
pub(crate) fn float_distinct<T: Into<f64> + Copy>(a: Option<T>, b: Option<T>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => {
            let (a, b) = (a.into(), b.into());
            !(a == b || (a.is_nan() && b.is_nan()))
        }
        (a, b) => a.is_some() != b.is_some(),
    }
}
