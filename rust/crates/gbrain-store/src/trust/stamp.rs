//! The trust-tier stamp: the rules of PGLite's `gbrain_stamp_trust_tier` BEFORE ROW trigger
//! (src/core/trust/schema.ts, `GUEST_FAIL_CLOSED_STAMP_TIER_FUNCTION`) as one pure function.
//!
//! The writer that stores a row of `pages`, `facts`, `takes` or `timeline_entries` calls [`stamp`]
//! with the write's trust context and the row's old and new tier, and stores the tier and origin
//! that [`stamp`] returns. [`stamp`] reads and writes nothing; the write context (PGLite's
//! `gbrain.write_trust_*` and `gbrain.write_origin` settings) belongs to the caller.
//!
//! The rules, in the trigger's order:
//! 1. A writer tier above `operator_curated` needs a promotion that covers it, or the write is
//!    refused (`trust_raise_refused`).
//! 2. INSERT stamps the writer's tier (`unknown` when there is no writer) and origin. A tier the
//!    caller supplies is ignored, except under backfill, where it is kept (and refused above
//!    `operator_curated` without a covering promotion).
//! 3. UPDATE that raises the tier keeps the raise when a promotion covers it, or under backfill
//!    when the old tier is `unknown` and the new tier is not `user_confirmed`. With no writer it is
//!    refused. Otherwise the tier goes back to the old one.
//! 4. UPDATE that changes content (unless the table is in the keep list) restamps: a writer at or
//!    above `operator_curated` stamps its own tier; a lower writer (or none, which is `unknown`)
//!    takes the lower of the old tier and its own; an explicit lowering in the same write also
//!    counts. The origin is replaced unless the write set it itself.
//!
//! Not built: the guest-source rules of the trigger (`source_writer_restricted`,
//! `guest_attribution_missing`, `guest_page_immutable` and the per-source tier ceiling). The Rust
//! store has no `guest_sources` table; see rust/docs/store/trust.md.

use crate::error::{INVALID_ARGUMENT, StoreError};
use serde_json::{Map, Value};

/// The store error code of a refused raise. It matches the TypeScript error code that
/// `persistence/publication-failure.ts` maps the trigger's `trust_raise_refused:` message to.
pub const TRUST_RAISE_REFUSED: &str = "trust_raise_refused";

/// A memory trust tier (src/core/trust/tier.ts `TRUST_TIERS`), most trusted first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TrustTier {
    UserConfirmed,
    OperatorCurated,
    ToolObserved,
    AgentWritten,
    Unknown,
    ExternalUntrusted,
}

/// Writers at or above this tier restamp a row on a content rewrite; lower writers can only lower it.
pub const OWNER_TIER_FLOOR: TrustTier = TrustTier::OperatorCurated;

impl TrustTier {
    /// Every tier, most trusted first (the order of `TRUST_TIERS`).
    pub const ALL: [TrustTier; 6] = [
        TrustTier::UserConfirmed,
        TrustTier::OperatorCurated,
        TrustTier::ToolObserved,
        TrustTier::AgentWritten,
        TrustTier::Unknown,
        TrustTier::ExternalUntrusted,
    ];

    /// `TRUST_TIER_RANK`: larger is more trusted.
    pub fn rank(self) -> u8 {
        match self {
            TrustTier::UserConfirmed => 6,
            TrustTier::OperatorCurated => 5,
            TrustTier::ToolObserved => 4,
            TrustTier::AgentWritten => 3,
            TrustTier::Unknown => 2,
            TrustTier::ExternalUntrusted => 1,
        }
    }

    /// The tier's stored name.
    pub fn as_str(self) -> &'static str {
        match self {
            TrustTier::UserConfirmed => "user_confirmed",
            TrustTier::OperatorCurated => "operator_curated",
            TrustTier::ToolObserved => "tool_observed",
            TrustTier::AgentWritten => "agent_written",
            TrustTier::Unknown => "unknown",
            TrustTier::ExternalUntrusted => "external_untrusted",
        }
    }

    /// The tier a stored name names, or `None` for any other text.
    pub fn parse(name: &str) -> Option<TrustTier> {
        TrustTier::ALL
            .into_iter()
            .find(|tier| tier.as_str() == name)
    }

    /// A stored tier read back (`storedTrustTier`): NULL and unrecognized text read as `unknown`.
    pub fn stored(name: Option<&str>) -> TrustTier {
        name.and_then(TrustTier::parse)
            .unwrap_or(TrustTier::Unknown)
    }

    /// A trust setting as PGLite reads it: empty or absent is no tier; any other text that names
    /// no tier is refused (`22023 gbrain trust setting names no tier`).
    pub fn from_setting(value: Option<&str>) -> crate::Result<Option<TrustTier>> {
        match value {
            None | Some("") => Ok(None),
            Some(text) => TrustTier::parse(text).map(Some).ok_or_else(|| {
                StoreError::new(INVALID_ARGUMENT, "gbrain trust setting names no tier")
            }),
        }
    }

    /// The less trusted of two tiers (`lowerOf`; the first wins a tie, which is the same tier).
    pub fn lower_of(self, other: TrustTier) -> TrustTier {
        if self.rank() <= other.rank() {
            self
        } else {
            other
        }
    }
}

/// A table whose rows carry `trust_tier` and `write_origin` (`TRUST_TABLES`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TrustTable {
    Facts,
    Takes,
    TimelineEntries,
    Pages,
}

impl TrustTable {
    pub const ALL: [TrustTable; 4] = [
        TrustTable::Facts,
        TrustTable::Takes,
        TrustTable::TimelineEntries,
        TrustTable::Pages,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TrustTable::Facts => "facts",
            TrustTable::Takes => "takes",
            TrustTable::TimelineEntries => "timeline_entries",
            TrustTable::Pages => "pages",
        }
    }

    pub fn parse(name: &str) -> Option<TrustTable> {
        TrustTable::ALL
            .into_iter()
            .find(|table| table.as_str() == name)
    }

    /// `TRUST_CONTENT_COLUMNS`: the columns whose change is a content rewrite. A page's
    /// `frontmatter` counts without [`TRUST_EPHEMERAL_FRONTMATTER_KEYS`] (see
    /// [`page_frontmatter_content`]).
    pub fn content_columns(self) -> &'static [&'static str] {
        match self {
            TrustTable::Facts => &[
                "fact",
                "entity_slug",
                "kind",
                "claim_metric",
                "claim_value",
                "claim_unit",
                "claim_period",
                "value",
                "event_type",
                "dimension",
                "context",
            ],
            TrustTable::Takes => &["claim", "kind", "holder"],
            TrustTable::TimelineEntries => &["summary", "detail", "date"],
            TrustTable::Pages => &[
                "source_id",
                "slug",
                "type",
                "page_kind",
                "title",
                "compiled_truth",
                "timeline",
                "frontmatter",
                "deleted_at",
            ],
        }
    }

    /// Parses `gbrain.write_trust_keep`: a comma list of table names. Names that are not trust
    /// tables are skipped, as PGLite's `TG_TABLE_NAME = ANY(...)` never matches them.
    pub fn keep_list(setting: Option<&str>) -> Vec<TrustTable> {
        setting
            .unwrap_or("")
            .split(',')
            .filter_map(TrustTable::parse)
            .collect()
    }
}

/// `TRUST_EPHEMERAL_FRONTMATTER_KEYS`: the hash-ephemeral keys without `trust_tier`, plus
/// `quarantine_override`. Their change is not a content change for the tier rule; the lower-only
/// `trust_tier` marker is content on purpose.
pub const TRUST_EPHEMERAL_FRONTMATTER_KEYS: &[&str] = &[
    "captured_at",
    "ingested_at",
    "quarantine",
    "content_flag",
    "embed_skip",
    "atoms_scan_hash",
    "quarantine_override",
];

/// A page's frontmatter as the content rule compares it: without the ephemeral keys.
pub fn page_frontmatter_content(frontmatter: &Map<String, Value>) -> Map<String, Value> {
    let mut content = frontmatter.clone();
    for key in TRUST_EPHEMERAL_FRONTMATTER_KEYS {
        content.shift_remove(*key);
    }
    content
}

/// The trust context of one write: PGLite's `gbrain.write_trust_tier`, `gbrain.write_origin`,
/// `gbrain.write_trust_promotion`, `gbrain.write_trust_backfill` and `gbrain.write_trust_keep`,
/// plus the write's actor from the three attribution settings.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WriteTrust {
    /// The declared tier of the writer. `None` is an undeclared writer.
    pub writer: Option<TrustTier>,
    /// The write origin JSON (`write_origin`). `None` stores NULL.
    pub origin: Option<Value>,
    /// The owner-confirmed ceiling a raise may reach.
    pub promotion: Option<TrustTier>,
    /// The backfill setting is `on`.
    pub backfill: bool,
    /// Tables whose content changes keep the stored tier.
    pub keep: Vec<TrustTable>,
    /// The actor (`gbrain.write_request`, `gbrain.write_principal_kind`,
    /// `gbrain.write_principal_id`) the timeline write receipt stamps. Not a trust input.
    pub attribution: crate::write_trust::WriteAttribution,
}

/// The row the stamp applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StampRow {
    /// A new row. `supplied` is the tier the caller put on the row (the column default is
    /// `unknown`); it is kept only under backfill.
    Insert { supplied: TrustTier },
    /// A changed row. `new` is the tier the write put on the row (`old` when it left the column
    /// alone). `content_changed` is true when a [`TrustTable::content_columns`] value differs.
    /// `origin_set` is true when the write changed `write_origin` itself.
    Update {
        old: TrustTier,
        new: TrustTier,
        content_changed: bool,
        origin_set: bool,
    },
}

/// What the writer does with `write_origin`.
#[derive(Debug, Clone, PartialEq)]
pub enum OriginStamp {
    /// Keep the value the write put on the row.
    Keep,
    /// Store this value (the context's origin; `None` is NULL).
    Set(Option<Value>),
}

/// The tier and origin to store.
#[derive(Debug, Clone, PartialEq)]
pub struct Stamped {
    pub tier: TrustTier,
    pub origin: OriginStamp,
}

fn refuse(message: &str) -> StoreError {
    StoreError::new(TRUST_RAISE_REFUSED, message)
}

/// Whether a promotion covers `tier` (PGLite `promo IS NOT NULL AND rank(tier) <= rank(promo)`).
fn covered(promotion: Option<TrustTier>, tier: TrustTier) -> bool {
    promotion.is_some_and(|promo| tier.rank() <= promo.rank())
}

/// Applies the trust-tier trigger rules to one row of `table`. See the module comment.
pub fn stamp(ctx: &WriteTrust, table: TrustTable, row: StampRow) -> crate::Result<Stamped> {
    if let Some(writer) = ctx.writer
        && writer.rank() > OWNER_TIER_FLOOR.rank()
        && !covered(ctx.promotion, writer)
    {
        return Err(refuse(
            "a write declared a tier above operator_curated without owner confirmation",
        ));
    }
    match row {
        StampRow::Insert { supplied } => {
            if ctx.backfill {
                if supplied.rank() > OWNER_TIER_FLOOR.rank() && !covered(ctx.promotion, supplied) {
                    return Err(refuse(
                        "a copied row named a tier above operator_curated without owner confirmation",
                    ));
                }
                return Ok(Stamped {
                    tier: supplied,
                    origin: OriginStamp::Keep,
                });
            }
            Ok(Stamped {
                tier: ctx.writer.unwrap_or(TrustTier::Unknown),
                origin: OriginStamp::Set(ctx.origin.clone()),
            })
        }
        StampRow::Update {
            old,
            new,
            content_changed,
            origin_set,
        } => {
            let mut tier = new;
            if new.rank() > old.rank() {
                let backfill_raise =
                    ctx.backfill && old == TrustTier::Unknown && new != TrustTier::UserConfirmed;
                if covered(ctx.promotion, new) || backfill_raise {
                    return Ok(Stamped {
                        tier: new,
                        origin: OriginStamp::Keep,
                    });
                }
                if ctx.writer.is_none() {
                    return Err(refuse("raising a tier needs owner confirmation"));
                }
                tier = old;
            }
            let mut origin = OriginStamp::Keep;
            if content_changed && !ctx.keep.contains(&table) {
                let mut effective = ctx.writer.unwrap_or(TrustTier::Unknown);
                if effective.rank() < OWNER_TIER_FLOOR.rank() {
                    effective = old.lower_of(effective);
                }
                if tier.rank() < old.rank() {
                    effective = tier.lower_of(effective);
                }
                tier = effective;
                if !origin_set {
                    origin = OriginStamp::Set(ctx.origin.clone());
                }
            }
            Ok(Stamped { tier, origin })
        }
    }
}

/// PGLite's `gbrain_snapshot_version_trust`: a new `page_versions` row takes the page's tier and
/// origin. A tier the caller supplies is kept only under backfill.
pub fn snapshot_version(
    ctx: &WriteTrust,
    page_tier: TrustTier,
    page_origin: Option<&Value>,
    supplied: Option<(TrustTier, Option<&Value>)>,
) -> (TrustTier, Option<Value>) {
    match supplied {
        Some((tier, origin)) if ctx.backfill => (tier, origin.cloned()),
        _ => (page_tier, page_origin.cloned()),
    }
}

#[cfg(test)]
mod tests {
    //! Each test copies a case of test/trust-tier-schema.test.ts ("trust tier trigger").
    use super::TrustTier::*;
    use super::*;
    use serde_json::json;

    fn trust(tier: TrustTier, channel: &str) -> WriteTrust {
        WriteTrust {
            writer: Some(tier),
            origin: Some(json!({ "channel": channel })),
            ..WriteTrust::default()
        }
    }

    fn undeclared() -> WriteTrust {
        WriteTrust::default()
    }

    fn insert(ctx: &WriteTrust, supplied: TrustTier) -> crate::Result<Stamped> {
        stamp(ctx, TrustTable::Pages, StampRow::Insert { supplied })
    }

    /// A content rewrite that leaves the tier column alone.
    fn rewrite(ctx: &WriteTrust, table: TrustTable, old: TrustTier) -> crate::Result<Stamped> {
        stamp(
            ctx,
            table,
            StampRow::Update {
                old,
                new: old,
                content_changed: true,
                origin_set: false,
            },
        )
    }

    /// A write that sets the tier column and nothing else.
    fn set_tier(
        ctx: &WriteTrust,
        table: TrustTable,
        old: TrustTier,
        new: TrustTier,
    ) -> crate::Result<Stamped> {
        stamp(
            ctx,
            table,
            StampRow::Update {
                old,
                new,
                content_changed: false,
                origin_set: false,
            },
        )
    }

    fn tier(result: crate::Result<Stamped>) -> TrustTier {
        result.expect("stamp").tier
    }

    fn refused(result: crate::Result<Stamped>) -> String {
        let error = result.expect_err("refused");
        assert_eq!(error.code, TRUST_RAISE_REFUSED);
        error.message
    }

    fn with_promotion(mut ctx: WriteTrust, ceiling: TrustTier) -> WriteTrust {
        ctx.promotion = Some(ceiling);
        ctx
    }

    fn backfill() -> WriteTrust {
        WriteTrust {
            backfill: true,
            ..WriteTrust::default()
        }
    }

    #[test]
    fn insert_cannot_spoof_a_tier() {
        // No writer -> unknown, whatever the row named.
        assert_eq!(
            insert(&undeclared(), UserConfirmed).unwrap(),
            Stamped {
                tier: Unknown,
                origin: OriginStamp::Set(None)
            }
        );
        // A writer -> its tier and origin.
        assert_eq!(
            insert(&trust(AgentWritten, "mcp:put_page"), OperatorCurated).unwrap(),
            Stamped {
                tier: AgentWritten,
                origin: OriginStamp::Set(Some(json!({ "channel": "mcp:put_page" })))
            }
        );
    }

    #[test]
    fn a_writer_tier_above_operator_curated_needs_a_covering_promotion() {
        let message = refused(insert(&trust(UserConfirmed, "test"), Unknown));
        assert_eq!(
            message,
            "a write declared a tier above operator_curated without owner confirmation"
        );
        let confirmed = with_promotion(
            trust(UserConfirmed, "cli:remember --confirm"),
            UserConfirmed,
        );
        assert_eq!(tier(insert(&confirmed, Unknown)), UserConfirmed);
        // A promotion below the writer does not cover it, on an update too.
        let short = with_promotion(trust(UserConfirmed, "test"), OperatorCurated);
        refused(rewrite(&short, TrustTable::Facts, Unknown));
        // operator_curated itself needs no promotion.
        assert_eq!(
            tier(insert(&trust(OperatorCurated, "sync"), Unknown)),
            OperatorCurated
        );
    }

    #[test]
    fn content_rewrite_owner_restamps_and_lower_writers_take_the_minimum() {
        let page = TrustTable::Pages;
        let owner = rewrite(&trust(OperatorCurated, "sync"), page, Unknown).unwrap();
        assert_eq!(
            owner,
            Stamped {
                tier: OperatorCurated,
                origin: OriginStamp::Set(Some(json!({ "channel": "sync" })))
            }
        );
        assert_eq!(
            tier(rewrite(
                &trust(AgentWritten, "mcp:put_page"),
                page,
                OperatorCurated
            )),
            AgentWritten
        );
        assert_eq!(
            tier(rewrite(
                &trust(AgentWritten, "test"),
                page,
                ExternalUntrusted
            )),
            ExternalUntrusted
        );
        // An undeclared writer counts as unknown.
        assert_eq!(tier(rewrite(&undeclared(), page, OperatorCurated)), Unknown);
        // An owner writer restamps down as well as up.
        assert_eq!(
            tier(rewrite(
                &trust(OperatorCurated, "sync"),
                page,
                UserConfirmed
            )),
            OperatorCurated
        );
    }

    #[test]
    fn unchanged_content_keeps_the_tier_without_error() {
        let sync = trust(OperatorCurated, "sync");
        let same = stamp(
            &sync,
            TrustTable::Pages,
            StampRow::Update {
                old: Unknown,
                new: Unknown,
                content_changed: false,
                origin_set: false,
            },
        )
        .unwrap();
        assert_eq!(
            same,
            Stamped {
                tier: Unknown,
                origin: OriginStamp::Keep
            }
        );
        // A writer that sets a higher tier without a promotion keeps the old tier, without error.
        assert_eq!(
            tier(set_tier(&sync, TrustTable::Pages, Unknown, OperatorCurated)),
            Unknown
        );
    }

    #[test]
    fn ephemeral_frontmatter_is_not_content() {
        let mut old = Map::new();
        old.insert("captured_at".into(), json!("2026-01-01"));
        old.insert("topic".into(), json!("x"));
        let mut new = old.clone();
        new.insert("captured_at".into(), json!("2026-02-02"));
        new.insert("quarantine".into(), json!(true));
        new.insert("quarantine_override".into(), json!("ok"));
        assert_eq!(
            page_frontmatter_content(&old),
            page_frontmatter_content(&new)
        );
        // The lower-only trust_tier marker is content.
        new.insert("trust_tier".into(), json!("agent_written"));
        assert_ne!(
            page_frontmatter_content(&old),
            page_frontmatter_content(&new)
        );
    }

    #[test]
    fn a_direct_raise_is_refused_on_every_table_promotion_allows_it_and_lowering_is_allowed() {
        let page = TrustTable::Pages;
        let message = refused(set_tier(&undeclared(), page, AgentWritten, UserConfirmed));
        assert_eq!(message, "raising a tier needs owner confirmation");
        let promoted = with_promotion(undeclared(), OperatorCurated);
        assert_eq!(
            set_tier(&promoted, page, AgentWritten, OperatorCurated).unwrap(),
            Stamped {
                tier: OperatorCurated,
                origin: OriginStamp::Keep
            }
        );
        refused(set_tier(&promoted, page, OperatorCurated, UserConfirmed));
        assert_eq!(
            tier(set_tier(
                &undeclared(),
                page,
                OperatorCurated,
                ExternalUntrusted
            )),
            ExternalUntrusted
        );
        for table in [
            TrustTable::Facts,
            TrustTable::Takes,
            TrustTable::TimelineEntries,
        ] {
            assert_eq!(
                tier(stamp(
                    &undeclared(),
                    table,
                    StampRow::Insert { supplied: Unknown }
                )),
                Unknown
            );
            refused(set_tier(&undeclared(), table, Unknown, ToolObserved));
        }
    }

    #[test]
    fn lifecycle_columns_keep_a_confirmed_tier_and_content_columns_do_not() {
        let confirmed = with_promotion(trust(UserConfirmed, "test"), UserConfirmed);
        let fact = tier(stamp(
            &confirmed,
            TrustTable::Facts,
            StampRow::Insert { supplied: Unknown },
        ));
        assert_eq!(fact, UserConfirmed);
        let sync = trust(OperatorCurated, "sync");
        let lifecycle = set_tier(&sync, TrustTable::Facts, fact, fact).unwrap();
        assert_eq!(lifecycle.tier, UserConfirmed);
        assert_eq!(
            tier(rewrite(&sync, TrustTable::Facts, fact)),
            OperatorCurated
        );
        assert!(TrustTable::Facts.content_columns().contains(&"context"));
        assert!(!TrustTable::Facts.content_columns().contains(&"expired_at"));
    }

    #[test]
    fn backfill_moves_only_unknown_rows_and_never_to_user_confirmed() {
        let page = TrustTable::Pages;
        refused(set_tier(&backfill(), page, Unknown, UserConfirmed));
        assert_eq!(
            tier(set_tier(&backfill(), page, Unknown, ToolObserved)),
            ToolObserved
        );
        refused(set_tier(&backfill(), page, AgentWritten, OperatorCurated));
        // A backfill INSERT keeps the copied tier and origin, up to operator_curated.
        assert_eq!(
            insert(&backfill(), OperatorCurated).unwrap(),
            Stamped {
                tier: OperatorCurated,
                origin: OriginStamp::Keep
            }
        );
        let message = refused(insert(&backfill(), UserConfirmed));
        assert_eq!(
            message,
            "a copied row named a tier above operator_curated without owner confirmation"
        );
        assert_eq!(
            tier(insert(
                &with_promotion(backfill(), UserConfirmed),
                UserConfirmed
            )),
            UserConfirmed
        );
    }

    #[test]
    fn page_versions_snapshot_the_page_tier_and_ignore_a_supplied_value() {
        let origin = json!({ "channel": "sync" });
        let supplied = json!({ "channel": "spoof" });
        assert_eq!(
            snapshot_version(
                &undeclared(),
                OperatorCurated,
                Some(&origin),
                Some((UserConfirmed, Some(&supplied)))
            ),
            (OperatorCurated, Some(origin.clone()))
        );
        assert_eq!(
            snapshot_version(
                &backfill(),
                OperatorCurated,
                Some(&origin),
                Some((ToolObserved, None))
            ),
            (ToolObserved, None)
        );
        assert_eq!(
            snapshot_version(&backfill(), Unknown, None, None),
            (Unknown, None)
        );
    }

    #[test]
    fn the_keep_list_and_a_write_that_sets_its_own_origin() {
        let mut sync = trust(AgentWritten, "sync");
        sync.keep = TrustTable::keep_list(Some("takes,facts,nope"));
        assert_eq!(sync.keep, vec![TrustTable::Takes, TrustTable::Facts]);
        assert_eq!(
            tier(rewrite(&sync, TrustTable::Facts, OperatorCurated)),
            OperatorCurated
        );
        assert_eq!(
            tier(rewrite(&sync, TrustTable::Pages, OperatorCurated)),
            AgentWritten
        );
        let own_origin = stamp(
            &sync,
            TrustTable::Pages,
            StampRow::Update {
                old: Unknown,
                new: Unknown,
                content_changed: true,
                origin_set: true,
            },
        )
        .unwrap();
        assert_eq!(own_origin.origin, OriginStamp::Keep);
    }

    #[test]
    fn a_setting_that_names_no_tier_is_refused() {
        assert_eq!(TrustTier::from_setting(None).unwrap(), None);
        assert_eq!(TrustTier::from_setting(Some("")).unwrap(), None);
        assert_eq!(
            TrustTier::from_setting(Some("tool_observed")).unwrap(),
            Some(ToolObserved)
        );
        let error = TrustTier::from_setting(Some("root")).unwrap_err();
        assert_eq!(error.code, INVALID_ARGUMENT);
        assert_eq!(TrustTier::stored(Some("damaged")), Unknown);
        assert_eq!(TrustTier::stored(None), Unknown);
    }

    #[test]
    fn ranks_and_names_match_the_typescript_tier_table() {
        let names: Vec<&str> = TrustTier::ALL.iter().map(|tier| tier.as_str()).collect();
        assert_eq!(
            names,
            [
                "user_confirmed",
                "operator_curated",
                "tool_observed",
                "agent_written",
                "unknown",
                "external_untrusted"
            ]
        );
        let ranks: Vec<u8> = TrustTier::ALL.iter().map(|tier| tier.rank()).collect();
        assert_eq!(ranks, [6, 5, 4, 3, 2, 1]);
    }
}
