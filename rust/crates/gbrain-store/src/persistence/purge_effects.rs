//! The Git effect statements of a purge: `listGitEffectsCarryingReason`,
//! `listPageGitEffectsForStrip` and `setPurgeEffectData` (src/core/engine-sql/facts-purge.ts;
//! rust/docs/store/persistence.md, "Purge effect statements"). A fact purge redacts the Git
//! effects whose commit message quotes the claim (src/core/facts/purge-reasons.ts
//! `redactGitEffectReasons`); a page purge strips the commit lines of the slug's Git effects
//! (`stripPageGitNotes`).
//!
//! Both reads join `persistence_effects` to `persistence_requests` and answer the request's client
//! `request_id`; an effect whose request record is gone is not listed, as the inner join drops it.
//! `FOR UPDATE OF e` changes nothing here: the purge runs in a store transaction, which holds the
//! writer until it ends. The rows come in effect id order (the claim-order index).

use super::effects::{EffectRecord, all_effects, effect_by_id, write_effect};
use super::request_by_id;
use crate::Store;
use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One locked Git effect, as both reads answer it (`PurgeGitEffectRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PurgeGitEffectRow {
    /// `e.id::text`.
    pub id: String,
    pub state: String,
    /// `r.request_id::text`: the request's client id, not the journal id.
    pub request_id: String,
    pub data: Value,
}

/// `listGitEffectsCarryingReason`'s arguments: the claim's lowered text, its JSON-escaped form and
/// its folded reason form (`$2`, `$3`, `$4`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GitEffectsCarryingArgs {
    pub source_id: String,
    pub needle: String,
    pub escaped: String,
    pub folded_json: String,
}

/// `listPageGitEffectsForStrip`'s arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PageGitEffectsArgs {
    pub source_id: String,
    pub slug: String,
}

/// `setPurgeEffectData`'s arguments: the effect id as text (`$1::bigint`) and the new data as
/// JSON text (`$2::text::jsonb`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PurgeEffectDataArgs {
    pub effect_id: String,
    pub data: String,
}

const SET_DATA: &str = "setPurgeEffectData";

/// The source's Git effects in id order, each with its request, as the join answers them.
fn git_effects_of(read: &dyn KvRead, source_id: &str) -> Result<Vec<(EffectRecord, String)>> {
    let mut out = Vec::new();
    for effect in all_effects(read)? {
        if effect.kind != "git" || effect.source_id.as_deref() != Some(source_id) {
            continue;
        }
        if let Some(request) = request_by_id(read, &effect.request_id)? {
            out.push((effect, request.request_id));
        }
    }
    Ok(out)
}

fn row(effect: EffectRecord, request_id: String) -> PurgeGitEffectRow {
    PurgeGitEffectRow {
        id: effect.id.to_string(),
        state: effect.state,
        request_id,
        data: effect.data,
    }
}

/// `data->>'key'`: a string as itself, any other non-null value as its jsonb text, null as NULL.
fn field_text(data: &Value, key: &str) -> Option<String> {
    match data.get(key)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// `$1::bigint` of a text id: surrounding whitespace is allowed, anything else that is not a
/// 64-bit integer refuses as the cast does.
fn bigint_text(text: &str) -> Result<i64> {
    text.trim().parse().map_err(|_| {
        StoreError::invalid(format!(
            "{SET_DATA}: invalid input syntax for type bigint: \"{text}\""
        ))
    })
}

fn has_nul(value: &Value) -> bool {
    match value {
        Value::String(s) => s.contains('\0'),
        Value::Array(items) => items.iter().any(has_nul),
        Value::Object(map) => map.iter().any(|(k, v)| k.contains('\0') || has_nul(v)),
        _ => false,
    }
}

impl Store {
    /// `listGitEffectsCarryingReason`: the source's Git effects whose data, as jsonb text and
    /// lowered, contains any of the three needles (`strpos(lower(e.data::text), $n) > 0`).
    pub fn list_git_effects_carrying_reason(
        &self,
        a: &GitEffectsCarryingArgs,
    ) -> Result<Vec<PurgeGitEffectRow>> {
        let read = self.read()?;
        let needles = [&a.needle, &a.escaped, &a.folded_json];
        Ok(git_effects_of(&*read, &a.source_id)?
            .into_iter()
            .filter(|(effect, _)| {
                let text = pg_lower(&jsonb_text(&effect.data));
                needles.iter().any(|n| text.contains(n.as_str()))
            })
            .map(|(effect, request)| row(effect, request))
            .collect())
    }

    /// `listPageGitEffectsForStrip`: the source's Git effects of the slug (`data->>'slug'`) whose
    /// data holds a `commit_line`, `commit_trailers` or `commit_trailer` key (a JSON null value
    /// counts: `data->'k' IS NOT NULL` is true for it).
    pub fn list_page_git_effects_for_strip(
        &self,
        a: &PageGitEffectsArgs,
    ) -> Result<Vec<PurgeGitEffectRow>> {
        let read = self.read()?;
        Ok(git_effects_of(&*read, &a.source_id)?
            .into_iter()
            .filter(|(effect, _)| {
                field_text(&effect.data, "slug").as_deref() == Some(a.slug.as_str())
                    && ["commit_line", "commit_trailers", "commit_trailer"]
                        .iter()
                        .any(|k| effect.data.get(*k).is_some())
            })
            .map(|(effect, request)| row(effect, request))
            .collect())
    }

    /// `setPurgeEffectData`: replaces one effect's data. No other column changes; an id no effect
    /// holds changes nothing.
    pub fn set_purge_effect_data(&self, a: &PurgeEffectDataArgs) -> Result<()> {
        let id = bigint_text(&a.effect_id)?;
        let data: Value = serde_json::from_str(&a.data).map_err(|e| {
            StoreError::invalid(format!(
                "{SET_DATA}: invalid input syntax for type json: {e}"
            ))
        })?;
        if has_nul(&data) {
            return Err(StoreError::invalid(format!(
                "{SET_DATA}: unsupported Unicode escape sequence (\\u0000 cannot be converted to text)"
            )));
        }
        let data = crate::jsonb::order(data);
        self.write(|tx| {
            if let Some(mut effect) = effect_by_id(&*tx, id)? {
                effect.data = data.clone();
                write_effect(tx, &effect)?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_text_reads_as_the_arrow_operator_does() {
        let data = serde_json::json!({ "slug": "notes/a", "n": 1, "z": null });
        assert_eq!(field_text(&data, "slug").as_deref(), Some("notes/a"));
        assert_eq!(field_text(&data, "n").as_deref(), Some("1"));
        assert_eq!(field_text(&data, "z"), None);
        assert_eq!(field_text(&data, "absent"), None);
    }

    #[test]
    fn an_effect_id_casts_as_bigint_does() {
        assert_eq!(bigint_text(" 12 ").unwrap(), 12);
        assert!(bigint_text("x").is_err());
        assert!(bigint_text("99999999999999999999").is_err());
    }

    #[test]
    fn a_nul_anywhere_in_the_data_is_found() {
        assert!(has_nul(&serde_json::json!({ "a": ["x\u{0}"] })));
        assert!(!has_nul(&serde_json::json!({ "a": ["x"] })));
    }
}
