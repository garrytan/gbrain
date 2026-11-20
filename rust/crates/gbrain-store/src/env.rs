//! The two things the store takes from outside itself: the time and fresh identifiers. Tests and
//! the simulation pass seeded ones so a seed replays exactly.

use std::time::{SystemTime, UNIX_EPOCH};

pub trait Env: Send + Sync {
    /// Microseconds since the Unix epoch, UTC.
    fn now_micros(&self) -> i64;
    /// A fresh random UUID (version 4 text form).
    fn new_uuid(&self) -> String;
}

/// The wall clock and the operating system's random source.
pub struct SystemEnv;

impl Env for SystemEnv {
    fn now_micros(&self) -> i64 {
        let since = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        i64::try_from(since.as_micros()).unwrap_or(i64::MAX)
    }

    fn new_uuid(&self) -> String {
        let mut bytes = [0u8; 16];
        // The operating system's random source failing is not recoverable here; the binding turns
        // the panic into `internal_error`.
        getrandom::fill(&mut bytes).expect("operating system random source");
        uuid_from_bytes(bytes)
    }
}

/// A version 4 UUID from 16 random bytes.
pub fn uuid_from_bytes(mut b: [u8; 16]) -> String {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..16].concat()
    )
}

/// True for the lowercase or uppercase 8-4-4-4-12 hexadecimal form.
pub fn is_uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    let sizes = [8, 4, 4, 4, 12];
    parts.len() == 5
        && parts
            .iter()
            .zip(sizes)
            .all(|(p, n)| p.len() == n && p.bytes().all(|c| c.is_ascii_hexdigit()))
}

/// `2026-08-10T12:00:00.000123Z`, microsecond precision, as Postgres `to_char` projects it.
pub fn iso(micros: i64) -> String {
    let secs = micros.div_euclid(1_000_000);
    let frac = micros.rem_euclid(1_000_000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{frac:06}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Parses the output of `iso` (and the millisecond form `Date#toISOString` gives). Returns `None`
/// for any other shape.
pub fn parse_iso(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20 || *b.last()? != b'Z' {
        return None;
    }
    let num = |a: usize, z: usize| text.get(a..z)?.parse::<i64>().ok();
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hh, mm, ss) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let frac = if b[19] == b'.' {
        let digits = text.get(20..b.len() - 1)?;
        if digits.is_empty() || digits.len() > 6 || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        digits.parse::<i64>().ok()? * 10i64.pow(6 - digits.len() as u32)
    } else if b.len() == 20 {
        0
    } else {
        return None;
    };
    let days = days_from_civil(y, m, d);
    Some(((days * 86_400 + hh * 3600 + mm * 60 + ss) * 1_000_000) + frac)
}

/// The time Postgres's `now()` gives inside the store write transaction that runs on this thread:
/// read from the store's `Env` once, the first time a write asks, and the same for the rest of the
/// transaction, as `now()` is the transaction's start time. `Store::write` opens it; a hook that
/// stamps a row (`persistence::queue_page_projection`) reads it with `transaction_now`, so the
/// page write paths do not carry an `Env` for it. A transaction that never asks reads no time.
pub(crate) mod transaction_clock {
    use super::Env;
    use std::cell::RefCell;
    use std::sync::Arc;

    /// The open transaction's environment and, once read, its time.
    type Clock = Option<(Arc<dyn Env>, Option<i64>)>;

    thread_local! {
        static CLOCK: RefCell<Clock> = const { RefCell::new(None) };
    }

    /// Restores the clock of the enclosing scope when the write transaction ends.
    pub(crate) struct Scope(Clock);

    impl Drop for Scope {
        fn drop(&mut self) {
            let outer = self.0.take();
            CLOCK.with(|c| *c.borrow_mut() = outer);
        }
    }

    pub(crate) fn open(env: Arc<dyn Env>) -> Scope {
        Scope(CLOCK.with(|c| c.borrow_mut().replace((env, None))))
    }

    /// `now()` of the open write transaction, or `None` outside one.
    pub(crate) fn transaction_now() -> Option<i64> {
        CLOCK.with(|c| {
            let mut c = c.borrow_mut();
            let (env, now) = c.as_mut()?;
            Some(*now.get_or_insert_with(|| env.now_micros()))
        })
    }
}

// Howard Hinnant's civil calendar algorithms.
pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trips_and_matches_known_instants() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000000Z");
        assert_eq!(iso(1_786_363_200_000_123), "2026-08-10T12:00:00.000123Z");
        for micros in [0, 1, 951_782_400_000_000, 1_786_363_200_000_123, -1] {
            assert_eq!(parse_iso(&iso(micros)), Some(micros));
        }
        assert_eq!(
            parse_iso("2026-08-10T12:00:00.000Z"),
            Some(1_786_363_200_000_000)
        );
        assert_eq!(parse_iso("2026-08-10"), None);
    }

    #[test]
    fn uuids_have_the_v4_shape() {
        let id = SystemEnv.new_uuid();
        assert!(is_uuid(&id), "{id}");
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(!is_uuid("not-a-uuid"));
    }
}
