//! `normalizeDerivationClaims`: the fold of `page-body/schema.ts` `foldSql` over `gbrain_fact_normalize`, distinct and
//! by byte.

mod memory_env;

use memory_env::brain;

fn claims(list: &[&str]) -> Vec<String> {
    list.iter().map(|c| c.to_string()).collect()
}

#[test]
fn needles_are_normalized_folded_distinct_and_by_byte() {
    let b = brain("derivation-needles");
    let got = b
        .normalize_derivation_claims(&claims(&["ab", "a b", "a  c", "A B", "", "  ", "!!"]))
        .unwrap();
    assert_eq!(got, ["a b", "a c", "ab"]);
    assert_eq!(
        b.normalize_derivation_claims(&[]).unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn the_fold_maps_final_sigma_and_drops_a_combining_dot_after_i() {
    let b = brain("derivation-fold");
    let got = b
        .normalize_derivation_claims(&claims(&["ΟΔΟΣ", "οδος", "i\u{307}x", "ix"]))
        .unwrap();
    assert_eq!(got, ["ix", "οδοσ"]);
}

#[test]
fn a_claim_with_a_nul_character_is_refused() {
    let b = brain("derivation-nul");
    let err = b
        .normalize_derivation_claims(&claims(&["a\0b"]))
        .unwrap_err();
    assert!(err.to_string().contains("NUL"));
}
