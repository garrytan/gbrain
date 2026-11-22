//! Dream verdicts: the PGLite semantics of getDreamVerdict, putDreamVerdict, sweepDreamVerdicts.

mod memory_env;

use gbrain_store::dream::{DREAM_VERDICT_TTL_SECONDS, DreamVerdictInput};
use gbrain_store::env::iso;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use memory_env::{T0, brain};
use serde_json::json;

fn verdict(v: serde_json::Value) -> DreamVerdictInput {
    serde_json::from_value(v).unwrap()
}

fn full() -> DreamVerdictInput {
    verdict(json!({
        "worth_processing": true, "reasons": ["a", "b"], "score": 0.82, "content_type": "meeting",
        "segments": [{"quote": "q", "note": "n"}], "entities": ["people/alice-example"],
        "model": "triage-m1", "triage_version": 1
    }))
}

#[test]
fn a_put_reads_back_and_a_re_put_replaces_every_field() {
    let b = brain("dream-rt");
    assert_eq!(b.get_dream_verdict("a.md", "h1").unwrap(), None);
    b.put_dream_verdict("a.md", "h1", &full()).unwrap();
    let hit = b.get_dream_verdict("a.md", "h1").unwrap().unwrap();
    assert_eq!(
        hit,
        json!({
            "worth_processing": true, "reasons": ["a", "b"], "judged_at": iso(T0), "score": 0.82,
            "content_type": "meeting", "segments": [{"note": "n", "quote": "q"}],
            "entities": ["people/alice-example"], "model": "triage-m1", "triage_version": 1
        })
    );
    // jsonb key order: shorter keys first.
    let keys: Vec<&String> = hit["segments"][0].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["note", "quote"]);

    b.clock.advance(5_000_000);
    b.put_dream_verdict(
        "a.md",
        "h1",
        &verdict(json!({"worth_processing": false, "model": "m2", "triage_version": 2})),
    )
    .unwrap();
    assert_eq!(
        b.get_dream_verdict("a.md", "h1").unwrap().unwrap(),
        json!({
            "worth_processing": false, "reasons": [], "judged_at": iso(T0 + 5_000_000), "score": null,
            "content_type": null, "segments": [], "entities": [], "model": "m2", "triage_version": 2
        })
    );
    assert_eq!(b.get_dream_verdict("a.md", "h2").unwrap(), None);
    assert_eq!(b.get_dream_verdict("b.md", "h1").unwrap(), None);
}

#[test]
fn a_verdict_expires_after_thirty_days_and_the_sweep_deletes_only_expired_rows() {
    let b = brain("dream-ttl");
    b.put_dream_verdict("old.md", "h", &full()).unwrap();
    b.clock.advance(86_400_000_000);
    b.put_dream_verdict("new.md", "h", &full()).unwrap();
    assert_eq!(b.sweep_dream_verdicts().unwrap(), 0);

    let ttl = DREAM_VERDICT_TTL_SECONDS * 1_000_000;
    b.clock.set(T0 + ttl - 1);
    assert!(b.get_dream_verdict("old.md", "h").unwrap().is_some());
    // expires_at <= now is a miss, and the sweep's predicate is the same.
    b.clock.set(T0 + ttl);
    assert_eq!(b.get_dream_verdict("old.md", "h").unwrap(), None);
    assert!(b.get_dream_verdict("new.md", "h").unwrap().is_some());
    assert_eq!(b.sweep_dream_verdicts().unwrap(), 1);
    assert_eq!(b.sweep_dream_verdicts().unwrap(), 0);
    // A re-put of an expired verdict makes it live again for a fresh TTL.
    b.put_dream_verdict("old.md", "h", &full()).unwrap();
    assert!(b.get_dream_verdict("old.md", "h").unwrap().is_some());
}

#[test]
fn inputs_postgres_refuses_are_refused_and_change_nothing() {
    let b = brain("dream-refuse");
    let e = b
        .put_dream_verdict("a.md", "h", &verdict(json!({"reasons": []})))
        .unwrap_err();
    assert_eq!(e.code, CONSTRAINT_VIOLATION);
    for bad in [
        json!({"worth_processing": true, "triage_version": 1.5}),
        json!({"worth_processing": true, "triage_version": 3e10}),
        json!({"worth_processing": true, "reasons": ["a\u{0}b"]}),
        json!({"worth_processing": true, "segments": [{"q\u{0}": 1}]}),
        json!({"worth_processing": true, "model": "m\u{0}"}),
    ] {
        let e = b
            .put_dream_verdict("a.md", "h", &verdict(bad.clone()))
            .unwrap_err();
        assert_eq!(e.code, INVALID_ARGUMENT, "{bad}");
    }
    let e = b.put_dream_verdict("a\u{0}.md", "h", &full()).unwrap_err();
    assert_eq!(e.code, INVALID_ARGUMENT);
    assert_eq!(b.get_dream_verdict("a.md", "h").unwrap(), None);
}
