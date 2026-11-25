//! A tier-only change of one row (`src/core/engine-sql/row-tier.ts`, trust/page-handlers.ts
//! `setRowTier`) and the page whose chunks render the row (trust/page-write.ts
//! `queueTierProjection`).
//!
//! - [`Store::read_row_trust_tier`]: the stored tier of a fact, take or page.
//! - [`Store::set_row_trust_tier`]: the tier set by name and `owner_decision` merged into the
//!   row's `write_origin` (`COALESCE(write_origin, '{}') || jsonb_build_object(...)`). The tier
//!   trigger runs as an UPDATE that names both columns ([`stamp`]): a raise needs the promotion
//!   the caller opens (`withTrustPromotion`), and a raise an undeclared writer makes is refused.
//! - [`Store::read_tier_projection_page`]: the fact's markdown page, the take's page or the page.
//!
//! The members add no keys; they read and write the trust fields of the fact, take and page
//! records. See rust/docs/store/trust.md, "Tier-only row changes".

use super::{OriginStamp, StampRow, TrustTable, TrustTier, stamp};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::facts::{read_fact, write_fact};
use crate::pages::{read_page_by_id, restore_page_trust_in};
use crate::takes::{read_take, write_take};
use crate::write_trust::stamp_context;
use serde_json::{Map, Value, json};

/// `COALESCE(write_origin, '{}'::jsonb) || jsonb_build_object('owner_decision', decision)`.
fn merged_origin(origin: Option<&Value>, decision: &Value) -> Value {
    let right = json!({ "owner_decision": decision });
    match origin.cloned().unwrap_or_else(|| Value::Object(Map::new())) {
        Value::Object(mut left) => {
            left.insert("owner_decision".into(), decision.clone());
            Value::Object(left)
        }
        Value::Array(mut left) => {
            left.push(right);
            Value::Array(left)
        }
        scalar => Value::Array(vec![scalar, right]),
    }
}

/// The row id, as `WHERE id = $1` reads a JS number: a negative or fractional id names no row.
fn row_id(op: &str, id: f64) -> Result<Option<u64>> {
    if !id.is_finite() || id.fract() != 0.0 || id.abs() > 9.223_372_036_854_775e18 {
        return Err(StoreError::invalid(format!(
            "{op}: an id must be a whole number, got {id}"
        )));
    }
    Ok(u64::try_from(id as i64).ok())
}

fn table(op: &str, name: &str) -> Result<TrustTable> {
    match name {
        "facts" => Ok(TrustTable::Facts),
        "takes" => Ok(TrustTable::Takes),
        "pages" => Ok(TrustTable::Pages),
        other => Err(StoreError::invalid(format!(
            "{op}: unknown table {other:?}"
        ))),
    }
}

impl Store {
    /// `readRowTrustTier(table, id)`: `{ trust_tier }` of row `id`, or null for no row.
    pub fn read_row_trust_tier(&self, table_name: &str, id: f64) -> Result<Value> {
        const OP: &str = "readRowTrustTier";
        let table = table(OP, table_name)?;
        let Some(id) = row_id(OP, id)? else {
            return Ok(Value::Null);
        };
        let read = self.read()?;
        let tier = match table {
            TrustTable::Facts => read_fact(&*read, id)?.map(|f| f.tier()),
            TrustTable::Takes => read_take(&*read, id)?.map(|t| t.trust.tier()),
            _ => read_page_by_id(&*read, id)?.map(|p| TrustTier::stored(p.trust_tier.as_deref())),
        };
        Ok(tier.map_or(Value::Null, |t| json!({ "trust_tier": t.as_str() })))
    }

    /// `setRowTrustTier(table, id, tier, decision)`: sets row `id` to `tier` and merges `decision`
    /// (JSON text) into its `write_origin` under `owner_decision`; returns `[id]`, or `[]` for no
    /// row. Every argument is cast first.
    pub fn set_row_trust_tier(
        &self,
        table_name: &str,
        id: f64,
        tier: &str,
        decision: &str,
    ) -> Result<Vec<u64>> {
        const OP: &str = "setRowTrustTier";
        let table = table(OP, table_name)?;
        crate::links::no_nul(OP, &[("tier", tier), ("decision", decision)])?;
        let Some(new_tier) = TrustTier::parse(tier) else {
            return Err(StoreError::invalid(format!(
                "{OP}: {tier:?} is not a trust tier"
            )));
        };
        let decision: Value = serde_json::from_str(decision)
            .map_err(|e| StoreError::invalid(format!("{OP}: decision is not JSON text: {e}")))?;
        let Some(id) = row_id(OP, id)? else {
            return Ok(Vec::new());
        };
        let trust = &self.write_trust()?;
        self.write(|tx| match table {
            TrustTable::Facts => {
                let Some(old) = read_fact(&*tx, id)? else {
                    return Ok(Vec::new());
                };
                let mut new = old.clone();
                new.trust_tier = new_tier.as_str().to_owned();
                new.write_origin = Some(merged_origin(old.write_origin.as_ref(), &decision));
                write_fact(tx, trust, Some(&old), &new)?;
                Ok(vec![id])
            }
            TrustTable::Takes => {
                let Some(mut take) = read_take(&*tx, id)? else {
                    return Ok(Vec::new());
                };
                let context = stamp_context::current()?;
                context.attribution.refuse_request_not_uuid()?;
                let origin = merged_origin(take.trust.write_origin.as_ref(), &decision);
                let stamped = stamp(
                    &context,
                    TrustTable::Takes,
                    StampRow::Update {
                        old: take.trust.tier(),
                        new: new_tier,
                        content_changed: false,
                        origin_set: true,
                    },
                )?;
                take.trust.trust_tier =
                    (stamped.tier != TrustTier::Unknown).then(|| stamped.tier.as_str().to_owned());
                take.trust.write_origin = match stamped.origin {
                    OriginStamp::Keep => Some(origin),
                    OriginStamp::Set(set) => set,
                };
                write_take(tx, &take)?;
                Ok(vec![id])
            }
            _ => {
                let Some(page) = read_page_by_id(&*tx, id)? else {
                    return Ok(Vec::new());
                };
                let origin = merged_origin(page.write_origin.as_ref(), &decision);
                restore_page_trust_in(tx, id, new_tier, Some(origin))?;
                Ok(vec![id])
            }
        })
    }

    /// `readTierProjectionPage(table, id)`: `{ source_id, slug }` of the page whose chunks render
    /// row `id`: a fact's markdown page (none when it has no `source_markdown_slug`), a take's page,
    /// or the page itself, in any state; null for none.
    pub fn read_tier_projection_page(&self, table_name: &str, id: f64) -> Result<Value> {
        const OP: &str = "readTierProjectionPage";
        let table = table(OP, table_name)?;
        let Some(id) = row_id(OP, id)? else {
            return Ok(Value::Null);
        };
        let read = self.read()?;
        let page = |page_id: u64| -> Result<Value> {
            Ok(read_page_by_id(&*read, page_id)?.map_or(
                Value::Null,
                |p| json!({ "source_id": p.source_id, "slug": p.slug }),
            ))
        };
        match table {
            TrustTable::Facts => Ok(read_fact(&*read, id)?
                .and_then(|f| {
                    f.source_markdown_slug
                        .clone()
                        .map(|slug| (f.source_id.clone(), slug))
                })
                .map_or(
                    Value::Null,
                    |(source_id, slug)| json!({ "source_id": source_id, "slug": slug }),
                )),
            TrustTable::Takes => match read_take(&*read, id)? {
                Some(take) => page(take.page_id),
                None => Ok(Value::Null),
            },
            _ => page(id),
        }
    }
}
