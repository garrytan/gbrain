//! Lock skips that stay safe when explicit transactions run optimistically (multi-user mode,
//! interface I-1; docs/designs/rust-engine/multi-user-server.md, "Appendix: skip guarantees under
//! multi-user mode").
//!
//! A store fn that skips a lock a SQL engine takes calls [`crate::Store::assert_serialized_transactions`].
//! With multi-user mode off the store's explicit transactions hold the writer, so every skip passes.
//! With it on, a skip passes only when its site is listed here with the guarantee that replaces
//! the lock and the test that proves it under `GBRAIN_RUST_MULTIUSER=1`; every other site refuses
//! `engine_capability_missing`. `test/serialized-transactions-guard.test.ts` checks each row names a
//! marked site and an existing test.

/// What replaces the skipped lock once explicit transactions run optimistically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Guarantee {
    /// Every key the transaction read through its handle is validated at commit (`occ_kv.rs`): a
    /// read that changed refuses the commit with `write_conflict` and the callback runs again.
    ReadSet,
    /// A revision compare inside the transaction (a read of the row, so validated at commit).
    Cas,
    /// The keys are held in the brain's single-flight table until commit or rollback.
    SingleFlight,
    /// Commutative counter operations with their admission check re-evaluated at commit.
    Counter,
}

/// One proven site: its id (the `assert_serialized_transactions` argument), the guarantee and the
/// test that proves it with multi-user mode on.
#[derive(Debug, Clone, Copy)]
pub struct Proven {
    pub site: &'static str,
    pub guarantee: Guarantee,
    pub test: &'static str,
}

/// The Rust-side sites proven under multi-user mode.
pub const MULTIUSER_PROVEN: &[Proven] = &[
    Proven {
        site: "lockAccessPolicy",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_access_policy_second_rule_set_refuses_write_conflict",
    },
    Proven {
        site: "readPageRevisionForShare",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::read_page_revision_for_share_refuses_when_the_page_moved",
    },
    Proven {
        site: "lockReconcileRevision",
        guarantee: Guarantee::Cas,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_reconcile_revision_compare_refuses_when_the_page_moved",
    },
    Proven {
        site: "lockDreamMapConfigRow",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_dream_map_config_row_refuses_when_the_row_changed",
    },
    Proven {
        site: "lockRegisteredSourceIds",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_registered_source_ids_refuses_when_a_source_appears",
    },
    Proven {
        site: "lockLivePagesByKey",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_live_pages_by_key_refuses_when_a_page_is_deleted",
    },
    Proven {
        site: "lockSegmentedGenerationPage",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_segmented_generation_page_refuses_when_the_page_changed",
    },
    Proven {
        site: "readPairFactRow",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::read_pair_fact_row_refuses_when_the_fact_changed",
    },
    Proven {
        site: "readReplacementTarget",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::read_replacement_target_refuses_when_the_fact_changed",
    },
    Proven {
        site: "lockFactForWithdrawal",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_fact_for_withdrawal_refuses_when_the_fact_changed",
    },
    Proven {
        site: "lockActiveAccessTokens",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_active_access_tokens_refuses_when_a_token_is_revoked",
    },
    Proven {
        site: "lockLegacyAccessTokens",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_legacy_access_tokens_refuses_when_a_token_changes",
    },
    Proven {
        site: "readOauthCodeForUpdate",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::read_oauth_code_for_update_second_exchange_refuses",
    },
    Proven {
        site: "readOauthRefreshTokenForUpdate",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::read_oauth_refresh_token_for_update_second_rotation_refuses",
    },
    Proven {
        site: "lockBodyStagingState",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_body_staging_state_refuses_when_the_staging_moved",
    },
    Proven {
        site: "listOriginClaims",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::list_origin_claims_refuses_when_another_page_claims_the_file",
    },
    Proven {
        site: "listHeldTakeRows",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::list_held_take_rows_refuses_when_the_take_changed",
    },
    Proven {
        site: "listGuardedTakeRows",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::list_guarded_take_rows_refuses_when_the_page_takes_changed",
    },
    Proven {
        site: "listHeldRows",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::list_held_rows_refuses_when_a_row_of_the_page_changed",
    },
    Proven {
        site: "listHeldTimelineRows",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::list_held_timeline_rows_refuses_when_the_timeline_changed",
    },
    Proven {
        site: "lockPersistenceCounters",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_persistence_counters_refuses_when_a_counter_was_charged",
    },
    Proven {
        site: "lockEffectRow",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_effect_row_refuses_when_the_effect_was_claimed",
    },
    Proven {
        site: "lockEffectClaimRow",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_effect_claim_row_refuses_when_the_effect_was_claimed",
    },
    Proven {
        site: "selectClaimableWrite",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::select_claimable_write_never_hands_one_request_to_two_claimants",
    },
    Proven {
        site: "selectClaimableEffect",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::select_claimable_effect_never_hands_one_effect_to_two_claimants",
    },
    Proven {
        site: "lockNoopEmbeddingWindow",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_noop_embedding_window_never_hands_one_effect_to_two_settlers",
    },
    Proven {
        site: "lockOverdueHold",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::lock_overdue_hold_refuses_when_the_request_changed",
    },
    Proven {
        site: "listGitEffectsCarryingReason",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::purge_effect_reads_refuse_when_an_effect_changed",
    },
    Proven {
        site: "listPageGitEffectsForStrip",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::purge_effect_reads_refuse_when_an_effect_changed",
    },
    Proven {
        site: "assertCycleLease",
        guarantee: Guarantee::ReadSet,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::assert_cycle_lease_refuses_when_the_lock_is_retaken",
    },
    Proven {
        site: "holdPageKeys",
        guarantee: Guarantee::SingleFlight,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::page_keys_are_held_single_flight_so_a_slug_is_created_once",
    },
    Proven {
        site: "lockPageKeys",
        guarantee: Guarantee::SingleFlight,
        test: "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs::page_keys_are_held_single_flight_so_a_slug_is_created_once",
    },
];

/// The proven row of `site`, if any.
pub fn proven(site: &str) -> Option<&'static Proven> {
    MULTIUSER_PROVEN.iter().find(|p| p.site == site)
}
