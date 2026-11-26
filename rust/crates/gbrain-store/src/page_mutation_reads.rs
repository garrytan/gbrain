//! The reads a page write makes before admission (`src/core/persistence/page-mutations.ts`), as the members of
//! `src/core/engine-sql/page-mutation-reads.ts` run them (rust/docs/store/page-mutation-reads.md).
//!
//! Members: readStoredPageHead, readVersionSourcePath (`readSourceLocalPath` is `memory_mutation_reads.rs`), and the
//! four reads the enforced member CLI makes before a write and when it checks the output: readStoredPageLabels,
//! readMemberPageReadable, readSlugFolderRules, readHiddenPageSlugs. Each reads the records the source, page, access
//! rule and version families already keep; nothing here writes.

use std::collections::{BTreeMap, BTreeSet};

use crate::access_rules::folder_rules;
use crate::error::Result;
use crate::facts::{PrivacyPolicy, page_hidden, page_hidden_with};
use crate::owner_only::OwnerOnlySources;
use crate::pages::{VersionRecord, all_pages, read_page};
use crate::{Store, get_json, keys};
use serde_json::{Value, json};

impl Store {
    /// `readStoredPageHead(sourceId, slug)`: `{ type, trust_tier, title, frontmatter }` of the page at the slug in the
    /// source (`SELECT type, trust_tier, title, frontmatter FROM pages WHERE source_id = $1 AND slug = $2`), a
    /// soft-deleted page too; none for no such page. A record the store never stamped reads `trust_tier` as
    /// `unknown`, the column default.
    pub fn read_stored_page_head(&self, source_id: &str, slug: &str) -> Result<Option<Value>> {
        Ok(read_page(&*self.read()?, source_id, slug)?.map(|p| {
            json!({
                "type": p.page_type,
                "trust_tier": p.trust_tier.unwrap_or_else(|| "unknown".to_owned()),
                "title": p.title,
                "frontmatter": crate::jsonb::order_map(p.frontmatter),
            })
        }))
    }

    /// `readVersionSourcePath(versionId, pageId)`: the version's `source_path` when the version belongs to the page
    /// (`SELECT source_path FROM page_versions WHERE id=$1 AND page_id=$2`); none otherwise. A negative id matches
    /// nothing.
    pub fn read_version_source_path(
        &self,
        version_id: i64,
        page_id: i64,
    ) -> Result<Option<String>> {
        if version_id < 0 || page_id < 0 {
            return Ok(None);
        }
        let key = keys::version(page_id as u64, version_id as u64);
        let row: Option<VersionRecord> = get_json(&*self.read()?, &key)?;
        Ok(row
            .filter(|v| v.id == version_id as u64 && v.page_id == page_id as u64)
            .and_then(|v| v.source_path))
    }
}

impl Store {
    /// `readStoredPageLabels(sourceId, slug)`: the columns the enforced member's label check compares
    /// (`SELECT type, frontmatter, compiled_truth, timeline, body_storage, body_bytes FROM pages WHERE source_id = $1 AND
    /// slug = $2`), as stored: no withdrawal overlay, a soft-deleted page too, none for no such page. A segmented
    /// page's two body columns are null, as in SQL; `body_storage` reads `inline` for a page that is not segmented.
    pub fn read_stored_page_labels(&self, source_id: &str, slug: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        let Some(record) = read_page(&*read, source_id, slug)? else {
            return Ok(None);
        };
        let page = record.to_page_with_columns(&*read)?;
        let column = |name: &str| page.get(name).cloned().unwrap_or(Value::Null);
        Ok(Some(json!({
            "type": column("type"),
            "frontmatter": column("frontmatter"),
            "compiled_truth": column("compiled_truth"),
            "timeline": column("timeline"),
            "body_storage": page.get("body_storage").cloned().unwrap_or_else(|| json!("inline")),
            "body_bytes": column("body_bytes"),
        })))
    }

    /// `readMemberPageReadable(sourceId, slug, policy)`: none when the source holds no row at the slug (a
    /// soft-deleted row is a row); else whether `policy` (the member's read policy with the privacy part) admits it.
    pub fn read_member_page_readable(
        &self,
        source_id: &str,
        slug: &str,
        policy: &PrivacyPolicy,
    ) -> Result<Option<bool>> {
        let read = self.read()?;
        read_page(&*read, source_id, slug)?
            .map(|page| page_hidden(&*read, &page, policy).map(|hidden| !hidden))
            .transpose()
    }

    /// `readSlugFolderRules(sourceId, slug)`: the `<source>:<rule id>` of every rule of the source whose prefix covers
    /// the slug, by rule id (`gbrain_access_folder_rules`), whether or not a page exists there; none when no rule
    /// covers it.
    pub fn read_slug_folder_rules(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Option<Vec<String>>> {
        let rules = folder_rules(&*self.read()?, source_id, slug)?;
        Ok((!rules.is_empty()).then(|| {
            rules
                .into_iter()
                .map(|r| format!("{}:{}", r.source_id, r.rule_id))
                .collect()
        }))
    }

    /// `readHiddenPageSlugs(slugs, hiddenSources, policy)`: each of `slugs` that names a page in some source and no
    /// page `policy` admits outside `hidden_sources` (a soft-deleted row counts), in byte order.
    pub fn read_hidden_page_slugs(
        &self,
        slugs: &[String],
        hidden_sources: &[String],
        policy: &PrivacyPolicy,
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let owner_only = OwnerOnlySources::read(&*read)?;
        let mut all_hidden: BTreeMap<String, bool> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if !wanted.contains(page.slug.as_str()) {
                continue;
            }
            let hidden = hidden_sources.contains(&page.source_id)
                || page_hidden_with(&*read, &page, policy, &owner_only)?;
            *all_hidden.entry(page.slug).or_insert(true) &= hidden;
        }
        Ok(all_hidden
            .into_iter()
            .filter_map(|(slug, hidden)| hidden.then_some(slug))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use crate::pages::{CreateVersionOptions, PageInput, PutPageOptions};
    use crate::sources::SourceInput;
    use serde_json::{Map, json};

    #[test]
    fn the_three_reads_answer_as_their_sql_does() {
        let store = crate::test_support::store();
        let source: SourceInput = serde_json::from_value(
            json!({ "id": "rooted", "name": "rooted", "local_path": "/srv/rooted" }),
        )
        .unwrap();
        store.upsert_source(&source).unwrap();
        assert_eq!(
            store.read_source_local_path("rooted").unwrap().as_deref(),
            Some("/srv/rooted")
        );
        assert_eq!(store.read_source_local_path("default").unwrap(), None);
        assert_eq!(store.read_source_local_path("missing").unwrap(), None);

        let mut frontmatter = Map::new();
        frontmatter.insert("mood".into(), json!("calm"));
        let input = PageInput {
            page_type: "note".into(),
            title: "Head".into(),
            compiled_truth: "body".into(),
            frontmatter: Some(frontmatter),
            source_path: Some("notes/head.md".into()),
            ..PageInput::default()
        };
        let page = store
            .put_page("notes/head", &input, &PutPageOptions::default())
            .unwrap();
        let page_id = page["id"].as_i64().unwrap();
        let head = store
            .read_stored_page_head("default", "notes/head")
            .unwrap()
            .unwrap();
        assert_eq!(
            (&head["type"], &head["title"], &head["frontmatter"]),
            (&json!("note"), &json!("Head"), &json!({ "mood": "calm" }))
        );
        assert!(head["trust_tier"].is_string());
        assert_eq!(
            store
                .read_stored_page_head("default", "notes/missing")
                .unwrap(),
            None
        );
        assert_eq!(
            store.read_stored_page_head("rooted", "notes/head").unwrap(),
            None
        );
        store.soft_delete_page("notes/head", None).unwrap();
        assert_eq!(
            store
                .read_stored_page_head("default", "notes/head")
                .unwrap(),
            Some(head)
        );

        store.restore_page("notes/head", None).unwrap();
        let version = store
            .create_version_opts("notes/head", &CreateVersionOptions::default())
            .unwrap();
        let version_id = version["id"].as_i64().unwrap();
        assert_eq!(
            store
                .read_version_source_path(version_id, page_id)
                .unwrap()
                .as_deref(),
            Some("notes/head.md")
        );
        assert_eq!(
            store
                .read_version_source_path(version_id, page_id + 1000)
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .read_version_source_path(version_id + 1000, page_id)
                .unwrap(),
            None
        );
        assert_eq!(store.read_version_source_path(-1, page_id).unwrap(), None);
    }

    /// A page of `source` at `slug` with `frontmatter` (JSON object text).
    fn put(store: &crate::Store, source: &str, slug: &str, frontmatter: &str) {
        use crate::pages::{PageInput, PutPageOptions};
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: format!("body of {slug}"),
            frontmatter: serde_json::from_str(frontmatter).ok(),
            ..PageInput::default()
        };
        let options = PutPageOptions {
            source_id: Some(source.into()),
            ..PutPageOptions::default()
        };
        store.put_page(slug, &input, &options).unwrap();
    }

    fn member_policy(identity: &str, satisfied: &[&str]) -> crate::facts::PrivacyPolicy {
        serde_json::from_value(json!({
            "honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn",
            "identity": [identity], "privateReadableSources": [], "callerRecord": true,
            "satisfiedRuleIds": satisfied,
        }))
        .unwrap()
    }

    #[test]
    fn the_enforced_member_reads_answer_as_their_sql_does() {
        let store = crate::test_support::store();
        for id in ["vault"] {
            let source: SourceInput =
                serde_json::from_value(json!({ "id": id, "name": id })).unwrap();
            store.upsert_source(&source).unwrap();
        }
        store.put_access_policy_state("default").unwrap();
        store
            .put_access_rule(crate::access_rules::AccessRuleRecord {
                source_id: "default".into(),
                rule_id: "team-a".into(),
                prefix: "team-a/".into(),
                readable_by: vec!["group:team-a".into()],
                revision: 1,
                covers_derived: true,
                created_by: None,
            })
            .unwrap();
        put(&store, "default", "notes/open", "{}");
        put(
            &store,
            "default",
            "notes/listed",
            r#"{"readable_by":["member:tess-example"]}"#,
        );
        put(
            &store,
            "default",
            "notes/private",
            r#"{"visibility":"private"}"#,
        );
        put(
            &store,
            "default",
            "notes/gone",
            r#"{"readable_by":["member:tess-example"]}"#,
        );
        store.soft_delete_page("notes/gone", None).unwrap();
        put(&store, "default", "team-a/plan", "{}");
        put(
            &store,
            "default",
            "notes/twin",
            r#"{"readable_by":["member:bob-example"]}"#,
        );
        put(&store, "vault", "notes/twin", "{}");

        // Labels as stored: the live and the soft-deleted page, an inline body, no row elsewhere.
        let listed = store
            .read_stored_page_labels("default", "notes/listed")
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                &listed["type"],
                &listed["compiled_truth"],
                &listed["timeline"],
                &listed["body_storage"],
                &listed["body_bytes"]
            ),
            (
                &json!("note"),
                &json!("body of notes/listed"),
                &json!(""),
                &json!("inline"),
                &json!(null)
            )
        );
        assert_eq!(
            listed["frontmatter"],
            json!({ "readable_by": ["member:tess-example"] })
        );
        assert_eq!(
            store
                .read_stored_page_labels("default", "notes/gone")
                .unwrap()
                .unwrap()["compiled_truth"],
            json!("body of notes/gone")
        );
        assert_eq!(
            store
                .read_stored_page_labels("vault", "notes/listed")
                .unwrap(),
            None
        );

        // The rules that cover a slug, with or without a page; none under no rule or another source.
        let rules = |source: &str, slug: &str| store.read_slug_folder_rules(source, slug).unwrap();
        assert_eq!(
            rules("default", "team-a/new"),
            Some(vec!["default:team-a".to_string()])
        );
        assert_eq!(
            rules("default", "team-a/plan"),
            Some(vec!["default:team-a".to_string()])
        );
        assert_eq!(
            (
                rules("default", "notes/new"),
                rules("default", "team-a"),
                rules("vault", "team-a/new")
            ),
            (None, None, None)
        );

        // A member's read: none for no row, the soft-deleted row judged like a live one, a rule it must satisfy.
        let tess = member_policy("member:tess-example", &[]);
        let readable = |slug: &str, policy: &crate::facts::PrivacyPolicy| {
            store
                .read_member_page_readable("default", slug, policy)
                .unwrap()
        };
        assert_eq!(
            [
                "notes/open",
                "notes/listed",
                "notes/private",
                "notes/gone",
                "team-a/plan",
                "notes/none"
            ]
            .map(|s| readable(s, &tess)),
            [
                Some(true),
                Some(true),
                Some(false),
                Some(true),
                Some(false),
                None
            ]
        );
        let grouped = member_policy("member:tess-example", &["default:team-a"]);
        assert_eq!(readable("team-a/plan", &grouped), Some(true));
        assert_eq!(
            readable("notes/listed", &member_policy("member:bob-example", &[])),
            Some(false)
        );

        // The hidden slugs: a slug is hidden only when every page of it is, a hidden source hides its pages.
        let hidden = |slugs: &[&str], sources: &[&str], policy: &crate::facts::PrivacyPolicy| {
            let slugs: Vec<String> = slugs.iter().map(|s| s.to_string()).collect();
            let sources: Vec<String> = sources.iter().map(|s| s.to_string()).collect();
            store
                .read_hidden_page_slugs(&slugs, &sources, policy)
                .unwrap()
        };
        let all = [
            "notes/open",
            "notes/listed",
            "notes/private",
            "notes/gone",
            "team-a/plan",
            "notes/none",
            "notes/twin",
        ];
        assert_eq!(hidden(&all, &[], &tess), ["notes/private", "team-a/plan"]);
        assert_eq!(
            hidden(&["notes/twin", "notes/listed"], &["vault"], &tess),
            ["notes/twin"]
        );
        assert_eq!(hidden(&all, &[], &grouped), ["notes/private"]);
        assert!(hidden(&[], &["vault"], &tess).is_empty());
    }
}
