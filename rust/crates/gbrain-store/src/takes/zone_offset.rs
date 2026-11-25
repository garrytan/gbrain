//! The instant PostgreSQL gives a local date and time written with a zone name (`Europe/Moscow`,
//! `America/New_York`, `Japan`; `DetermineTimeZoneOffset`) or with one of the 50 date-dependent
//! abbreviations of its `Default` abbreviation set (`MSK`, `SGT`, ...), which the set defines by a
//! zone name (`MSK Europe/Moscow`; `DetermineTimeZoneAbbrevOffset`), both in
//! `src/backend/utils/adt/datetime.c`. A zone name reads step 1; an abbreviation reads both:
//!
//! 1. It reads the local time in the zone (`DetermineTimeZoneOffsetInternal`, with
//!    `pg_next_dst_boundary` from `src/timezone/localtime.c`): the local time type in effect a day
//!    before the local time taken as UTC, and the type after the next transition. If both readings
//!    land on one side of that transition it takes that side; a local time the transition skips
//!    takes the type before it, and one it repeats takes the type after it.
//! 2. If the zone ever used the abbreviation (`pg_interpret_timezone_abbrev`), the offset is the one
//!    the abbreviation had at the last transition to it at or before the instant of step 1, or else
//!    at the first transition to it after that instant. Otherwise it is the offset of step 1.
//!
//! The zones come from `zone_transitions.rs`, generated from PGLite's tzdata. A zone whose rules go
//! on past its last listed transition (`open_ended`) is not read past that transition: Postgres
//! extends the table from the rule on load, and this module does not.

use super::resolved_at::ResolvedAtError;
use super::zone_transitions::{DYNAMIC_ZONE_ABBREVIATIONS, ZONE_NAMES, ZONES, ZoneRules};

const DAY_S: i64 = 86_400;

/// The zone a date-dependent abbreviation (in lower case) names.
pub(super) fn dynamic_abbreviation(word: &str) -> Option<&'static ZoneRules> {
    DYNAMIC_ZONE_ABBREVIATIONS
        .binary_search_by(|(name, _)| (*name).cmp(word))
        .ok()
        .map(|i| &ZONES[DYNAMIC_ZONE_ABBREVIATIONS[i].1])
}

/// The zone a zone name (in lower case; Postgres finds the file ignoring case) loads.
pub(super) fn named_zone(name: &str) -> Option<&'static ZoneRules> {
    ZONE_NAMES
        .binary_search_by(|(n, _)| (*n).cmp(name))
        .ok()
        .map(|i| &ZONES[ZONE_NAMES[i].1])
}

/// The local time type Postgres uses before a zone's first transition, or in a zone with none:
/// the lowest-numbered standard-time type, else the first type.
fn first_standard(zone: &ZoneRules) -> usize {
    zone.types.iter().position(|t| !t.1).unwrap_or(0)
}

fn utoff(zone: &ZoneRules, kind: usize) -> i64 {
    zone.types[kind].0
}

/// `DetermineTimeZoneOffsetInternal`: the UTC instant, in seconds, of `local` (the local date and
/// time as seconds since the epoch, taken as UTC) in `zone`.
pub(super) fn local_instant(zone: &ZoneRules, local: i64) -> Result<i64, ResolvedAtError> {
    let Some(&last) = zone.at.last() else {
        return Ok(local - utoff(zone, first_standard(zone)));
    };
    let probe = local - DAY_S;
    if zone.open_ended && probe > last {
        return Err(ResolvedAtError::Unmodeled);
    }
    if probe >= last {
        return Ok(local - utoff(zone, usize::from(zone.kind[zone.kind.len() - 1])));
    }
    let (before, boundary, after) = if probe < zone.at[0] {
        (first_standard(zone), zone.at[0], usize::from(zone.kind[0]))
    } else {
        // The first transition after the probe; the one at index 0 is at or before it.
        let i = zone.at.partition_point(|&t| t <= probe);
        (
            usize::from(zone.kind[i - 1]),
            zone.at[i],
            usize::from(zone.kind[i]),
        )
    };
    let before_time = local - utoff(zone, before);
    let after_time = local - utoff(zone, after);
    Ok(if before_time < boundary && after_time < boundary {
        before_time
    } else if before_time >= boundary && after_time >= boundary {
        after_time
    } else if before_time > after_time {
        // A local time the transition skips: the reading before it.
        before_time
    } else {
        // A local time the transition repeats: the reading after it.
        after_time
    })
}

/// `DetermineTimeZoneAbbrevOffset`: the UTC instant, in seconds, of `local` (seconds since the
/// epoch, taken as UTC) written with the date-dependent abbreviation `word` (lower case) of `zone`.
pub(super) fn abbreviation_instant(
    zone: &ZoneRules,
    word: &str,
    local: i64,
) -> Result<i64, ResolvedAtError> {
    let instant = local_instant(zone, local)?;
    if !zone.types.iter().any(|t| t.2.eq_ignore_ascii_case(word)) {
        return Ok(instant);
    }
    if zone.open_ended && zone.at.last().is_some_and(|&last| instant >= last) {
        return Err(ResolvedAtError::Unmodeled);
    }
    let named = |i: &usize| {
        zone.types[usize::from(zone.kind[*i])]
            .2
            .eq_ignore_ascii_case(word)
    };
    let cutoff = zone.at.partition_point(|&t| t <= instant);
    let found = (0..cutoff)
        .rev()
        .find(named)
        .or_else(|| (cutoff..zone.at.len()).find(named));
    Ok(match found {
        Some(i) => local - utoff(zone, usize::from(zone.kind[i])),
        None => instant,
    })
}
