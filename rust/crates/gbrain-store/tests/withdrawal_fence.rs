//! The withdrawal check on a malformed facts fence (`facts/withdrawal_fence.rs`): a withdrawal or a purge tombstone
//! of the source with the fingerprint or the v1 fingerprint of a claim, at the claim's visibility (either when it has
//! none), under subject `*` or the subject (any subject when none).

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::facts::purge_ledger::FactPurgeInsert;
use gbrain_store::facts::withdrawal_fence::FenceClaim;
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::json;
use sha2::{Digest, Sha256};

const SLUG: &str = "people/fence-example";
const OTHER: &str = "people/other-fence-example";

fn hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn purge(b: &Brain, source: &str, visibility: &str, subject: &str, fact_hash: String) {
    let row = FactPurgeInsert {
        source_id: source.into(),
        visibility: visibility.into(),
        subject: subject.into(),
        fact_hash,
        request_id: None,
        actor: Some("owner:local".into()),
        reason: Some("test".into()),
    };
    assert!(b.insert_fact_purge(&row).unwrap());
}

fn claim(text: &str, visibility: Option<&str>) -> FenceClaim {
    FenceClaim {
        claim: text.into(),
        visibility: visibility.map(str::to_string),
    }
}

fn has(b: &Brain, text: &str, visibility: Option<&str>, subject: Option<&str>) -> bool {
    b.has_withdrawn_fence_claim("default", &[claim(text, visibility)], subject)
        .unwrap()
}

#[test]
fn purges_match_either_fingerprint_at_the_visibility_for_the_subject() {
    let b = brain("fence-purges");
    // `gbrain_fact_fingerprint` of "Prefers email" is the sha256 of its normal form, "prefers email".
    purge(&b, "default", "world", "*", hex("prefers email"));
    // A v1 fingerprint keeps the trailing period the current normal form drops.
    purge(&b, "default", "private", SLUG, hex("has a budget."));
    purge(&b, "default", "world", OTHER, hex("plays chess"));

    assert!(has(&b, "  PREFERS   email. ", Some("world"), Some(SLUG)));
    assert!(has(&b, "Prefers email", Some("world"), None));
    assert!(has(&b, "Prefers email", None, Some(OTHER)));
    assert!(!has(&b, "Prefers email", Some("private"), Some(SLUG)));

    assert!(has(&b, "Has a budget.", Some("private"), Some(SLUG)));
    assert!(has(&b, "Has a budget.", None, None));
    assert!(!has(&b, "Has a budget", Some("private"), Some(SLUG)));
    assert!(!has(&b, "Has a budget.", Some("private"), Some(OTHER)));
    assert!(!has(&b, "Has a budget.", Some("world"), Some(SLUG)));

    assert!(has(&b, "Plays chess", Some("world"), None));
    assert!(has(&b, "Plays chess", Some("world"), Some(OTHER)));
    assert!(!has(&b, "Plays chess", Some("world"), Some(SLUG)));
    assert!(!has(&b, "Flies kites", None, None));
}

#[test]
fn withdrawals_match_either_fingerprint_at_the_visibility_for_the_subject() {
    let b = brain("fence-withdrawals");
    b.insert_fact_withdrawal("default", "world", "Lives in Lisbon", SLUG, None)
        .unwrap();
    b.insert_fact_withdrawal("default", "private", "Rides a bike", "*", None)
        .unwrap();

    assert!(has(&b, "lives in LISBON", Some("world"), Some(SLUG)));
    assert!(!has(&b, "Lives in Lisbon", Some("world"), Some(OTHER)));
    assert!(has(&b, "Lives in Lisbon", None, None));
    assert!(!has(&b, "Lives in Lisbon", Some("private"), None));
    assert!(has(&b, "Rides a bike", Some("private"), Some(OTHER)));
    assert!(has(&b, "Rides a bike", None, Some(SLUG)));
    assert!(!has(&b, "Rides a bike", Some("world"), Some(OTHER)));
}

#[test]
fn any_claim_matches_and_no_claims_or_another_source_do_not() {
    let b = brain("fence-claims");
    let input: SourceInput =
        serde_json::from_value(json!({ "id": "other-src", "name": "other-src", "config": {} }))
            .unwrap();
    b.upsert_source(&input).unwrap();
    purge(&b, "other-src", "world", "*", hex("plays chess"));
    b.insert_fact_withdrawal("default", "world", "Prefers email", "*", None)
        .unwrap();

    assert!(
        !b.has_withdrawn_fence_claim("default", &[], Some(SLUG))
            .unwrap()
    );
    assert!(!has(&b, "Plays chess", None, None));
    assert!(
        b.has_withdrawn_fence_claim("other-src", &[claim("Plays chess", Some("world"))], None)
            .unwrap()
    );
    let many = [
        claim("Flies kites", Some("world")),
        claim("Prefers email", None),
    ];
    assert!(
        b.has_withdrawn_fence_claim("default", &many, Some(SLUG))
            .unwrap()
    );
    assert!(
        !b.has_withdrawn_fence_claim("missing", &many, Some(SLUG))
            .unwrap()
    );
}

#[test]
fn a_nul_in_any_text_is_refused() {
    let b = brain("fence-nul");
    for (source, text, subject) in [
        ("de\0fault", "x", None),
        ("default", "x\0y", None),
        ("default", "x", Some("a\0b")),
    ] {
        let err = b
            .has_withdrawn_fence_claim(source, &[claim(text, None)], subject)
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }
}
