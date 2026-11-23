//! The `trust_tier` and `write_origin` columns of a take or timeline row, and the stamp PGLite's
//! `trust_tier_stamp` trigger gives them (trust/schema.ts), through [`stamp`] (`stamp.rs`).
//!
//! - Insert: the tier the record carries is what the caller supplied (kept only under backfill);
//!   otherwise the write's declared tier (`unknown` when none) and the context's origin.
//! - Update: no take or timeline writer sets the tier or the origin itself (PGLite's writes leave
//!   both columns out of their `SET`), so the update starts from the stored tier and origin. When a
//!   content column changed, the stamp lowers the tier to the write's and sets the context's
//!   origin; otherwise both stay.
//!
//! Keys: none; the columns are part of the row's record and omitted while the tier is `unknown`
//! with no origin.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{OriginStamp, StampRow, TrustTable, TrustTier, stamp};
use crate::error::Result;
use crate::write_trust::stamp_context;

/// `trust_tier` (`None` is `unknown`, the column default) and `write_origin` (`None` is NULL).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct RowTrust {
    pub trust_tier: Option<String>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub write_origin: Option<Value>,
}

impl RowTrust {
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// The stored tier.
    pub(crate) fn tier(&self) -> TrustTier {
        TrustTier::stored(self.trust_tier.as_deref())
    }

    /// The two columns of the row.
    pub(crate) fn extend_json(&self, row: &mut Map<String, Value>) {
        row.insert("trust_tier".into(), json!(self.tier().as_str()));
        row.insert(
            "write_origin".into(),
            json!(self.write_origin.clone().map(crate::jsonb::order)),
        );
    }
}

/// The columns the trigger would store for a row of `table` under the open write's trust
/// context: an insert carrying `supplied`, or an update of a row stored with `old` whose content
/// columns changed when `content_changed`.
pub(crate) fn stamp_row(
    table: TrustTable,
    old: Option<&RowTrust>,
    supplied: &RowTrust,
    content_changed: bool,
) -> Result<RowTrust> {
    let context = stamp_context::current()?;
    let (row, stored_origin) = match old {
        None => (
            StampRow::Insert {
                supplied: supplied.tier(),
            },
            supplied.write_origin.clone(),
        ),
        Some(old) => (
            StampRow::Update {
                old: old.tier(),
                new: old.tier(),
                content_changed,
                origin_set: false,
            },
            old.write_origin.clone(),
        ),
    };
    let stamped = stamp(&context, table, row)?;
    Ok(RowTrust {
        trust_tier: (stamped.tier != TrustTier::Unknown).then(|| stamped.tier.as_str().to_owned()),
        write_origin: match stamped.origin {
            OriginStamp::Keep => stored_origin,
            OriginStamp::Set(origin) => origin,
        },
    })
}
