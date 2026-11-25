//! A Takes fence row's `resolved` cell read as PostgreSQL reads `text::timestamptz` (DateStyle
//! `ISO, MDY`, TimeZone `UTC`, the settings a brain runs with), for `writeFenceTakeResolutions`.
//!
//! The cell is free text, so Postgres's whole date/time input grammar applies. This module reads
//! the forms below exactly as Postgres does, and answers Postgres's error for the inputs it can
//! tell Postgres refuses. Any other input is [`ResolvedAtError::Unmodeled`]: the caller refuses it by
//! name rather than guess.
//!
//! - A numeric date `Y-M-D` (a 4-digit year first) or `M-D-Y` (`MDY`: month first, then day, then a
//!   2- or 4-digit year), with `-`, `/` or `.` between the parts; or `YYYYMMDD` as one number.
//! - A month name or its abbreviation with a day and a year, in the orders Postgres reads them:
//!   `March 1, 2026`, `1 March 2026`, `2026 March 1`, `01-Mar-2026`, `2026-Mar-01`, `mar-01-26`.
//! - Weekday names, `at` and `on`, and commas, which Postgres skips.
//! - A time `h:m[:s[.fraction]]`, with `am`/`pm`, an ISO `T` before it, and `24:00`.
//! - A zone `Z`, `zulu`, `UTC`, `GMT`, `UT`, one of the 145 fixed-offset abbreviations of Postgres's
//!   `Default` abbreviation set (`PST`, `EST`, `CET`, `CEST`, `BST`, `IST`, `JST`, ...; `zone_abbreviations.rs`),
//!   one of its 50 date-dependent abbreviations (`MSK`, `SGT`, ...; `zone_offset.rs`), a numeric
//!   offset `+hh`, `+hhmm`, `+hh:mm`, or a zone name of the tzdata after the date (`America/New_York`,
//!   `Etc/GMT+3`, `EST5EDT`) or, all letters, anywhere (`Japan`).
//! - `epoch`, `now`, `today`, `tomorrow` and `yesterday` on their own.
//!
//! Two-digit years are 2000-2069 and 1970-1999, as Postgres reads them. A field out of range is
//! Postgres's `date/time field value out of range`; text with no digit and no special word is its
//! `invalid input syntax`. A zone name the tzdata does not have, a zone followed by an offset
//! (`PST+1`), BC dates, infinities, Julian and ISO week dates are not read, nor a zone name or
//! date-dependent abbreviation at an instant past the zone's last listed transition (late 2037) when
//! the zone's daylight rules go on (`zone_offset.rs`).

use super::zone_abbreviations::fixed_abbreviation;
use super::zone_offset::{abbreviation_instant, dynamic_abbreviation, local_instant, named_zone};
use super::zone_transitions::ZoneRules;
use crate::env::{days_from_civil, days_in_month};

const DAY_US: i64 = 86_400_000_000;

/// The zone a resolved date is written in.
enum Zone {
    /// Seconds east of UTC.
    Fixed(i64),
    /// A date-dependent abbreviation (lower case) and the zone it names.
    Dynamic(&'static ZoneRules, String),
    /// A zone name.
    Named(&'static ZoneRules),
}

/// Why a resolved cell is not a time the store writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolvedAtError {
    /// Postgres: `invalid input syntax for type timestamp with time zone`.
    Syntax,
    /// Postgres: `date/time field value out of range`.
    Range,
    /// Postgres: `time zone displacement out of range`.
    ZoneRange,
    /// A form this module does not read; the caller refuses it by name.
    Unmodeled,
}

impl ResolvedAtError {
    /// The message Postgres raises for `text`, or the store's own for an unmodeled form.
    pub(crate) fn message(self, text: &str) -> String {
        match self {
            Self::Syntax => {
                format!("invalid input syntax for type timestamp with time zone: \"{text}\"")
            }
            Self::Range => format!("date/time field value out of range: \"{text}\""),
            Self::ZoneRange => format!("time zone displacement out of range: \"{text}\""),
            Self::Unmodeled => format!("a resolved date the store does not read: \"{text}\""),
        }
    }
}

type Parsed = std::result::Result<i64, ResolvedAtError>;
use ResolvedAtError::{Range, Syntax, Unmodeled, ZoneRange};

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(String),
    Time(String),
    Date(Vec<String>),
    Word(String),
    Offset(bool, String),
    /// A field that starts with a letter and runs on with punctuation or digits (Postgres's
    /// alphabetic `DTK_DATE`): a date such as `mar-01-2026`, or a zone name such as
    /// `america/new_york`, `etc/gmt+3` or `est5edt`.
    Name(String),
}

/// Words of Postgres's core date token table (`datetktbl`) this module reads: a letter run that
/// is one of them stays a word when a digit or `+` follows it.
fn core_word(w: &str) -> bool {
    month(w).is_some()
        || WEEKDAYS.contains(&w)
        || [
            "am",
            "pm",
            "at",
            "on",
            "t",
            "epoch",
            "now",
            "today",
            "tomorrow",
            "yesterday",
            "infinity",
        ]
        .contains(&w)
}

const MONTHS: [(&str, u32); 24] = [
    ("jan", 1),
    ("january", 1),
    ("feb", 2),
    ("february", 2),
    ("mar", 3),
    ("march", 3),
    ("apr", 4),
    ("april", 4),
    ("may", 5),
    ("jun", 6),
    ("june", 6),
    ("jul", 7),
    ("july", 7),
    ("aug", 8),
    ("august", 8),
    ("sep", 9),
    ("sept", 9),
    ("september", 9),
    ("oct", 10),
    ("october", 10),
    ("nov", 11),
    ("november", 11),
    ("dec", 12),
    ("december", 12),
];

const WEEKDAYS: [&str; 18] = [
    "sun",
    "sunday",
    "mon",
    "monday",
    "tue",
    "tues",
    "tuesday",
    "wed",
    "wednes",
    "wednesday",
    "thu",
    "thur",
    "thurs",
    "thursday",
    "fri",
    "friday",
    "sat",
    "saturday",
];

fn month(word: &str) -> Option<u32> {
    MONTHS
        .iter()
        .find(|(name, _)| *name == word)
        .map(|(_, n)| *n)
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// PostgreSQL's `ParseDateTime` split, for the field kinds this module reads.
fn tokens(text: &str) -> std::result::Result<Vec<Tok>, ResolvedAtError> {
    if !text.is_ascii() {
        return Err(Unmodeled);
    }
    let b = text.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    let run = |i: &mut usize, keep: &dyn Fn(u8) -> bool| {
        let start = *i;
        while *i < b.len() && keep(b[*i]) {
            *i += 1;
        }
        text[start..*i].to_ascii_lowercase()
    };
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() || c == b',' {
            i += 1;
        } else if c.is_ascii_digit() {
            let head = run(&mut i, &|x: u8| x.is_ascii_digit());
            match b.get(i) {
                Some(b':') => {
                    let rest = run(&mut i, &|x: u8| {
                        x.is_ascii_digit() || x == b':' || x == b'.'
                    });
                    out.push(Tok::Time(head + &rest));
                }
                Some(&d @ (b'-' | b'/' | b'.')) => {
                    let alpha = b.get(i + 1).is_some_and(u8::is_ascii_alphabetic);
                    if !alpha && !b.get(i + 1).is_some_and(u8::is_ascii_digit) {
                        return Err(Unmodeled);
                    }
                    let rest = run(&mut i, &|x: u8| {
                        x == d || x.is_ascii_digit() || (alpha && x.is_ascii_alphabetic())
                    });
                    let whole = head + &rest;
                    out.push(Tok::Date(
                        whole.split(d as char).map(str::to_owned).collect(),
                    ));
                }
                _ => out.push(Tok::Num(head)),
            }
        } else if c.is_ascii_alphabetic() {
            let head = run(&mut i, &|x: u8| x.is_ascii_alphabetic());
            let name = match (b.get(i), b.get(i + 1)) {
                (Some(b'-' | b'/' | b'.'), Some(n)) => n.is_ascii_alphanumeric(),
                (Some(&n), _) => (n == b'+' || n.is_ascii_digit()) && !core_word(&head),
                _ => false,
            };
            if name {
                // Postgres runs the field on over these characters.
                let rest = run(&mut i, &|x: u8| {
                    x.is_ascii_alphanumeric() || b"+-/_.:".contains(&x)
                });
                out.push(Tok::Name(head + &rest));
            } else {
                out.push(Tok::Word(head));
            }
        } else if (c == b'+' || c == b'-') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
            i += 1;
            let rest = run(&mut i, &|x: u8| x.is_ascii_digit() || x == b':');
            out.push(Tok::Offset(c == b'-', rest));
        } else {
            return Err(Unmodeled);
        }
    }
    Ok(out)
}

/// A year field: four digits as written, two digits as Postgres widens them.
fn year(s: &str) -> std::result::Result<i64, ResolvedAtError> {
    let n: i64 = s.parse().map_err(|_| Unmodeled)?;
    match s.len() {
        2 => Ok(if n < 70 { 2000 + n } else { 1900 + n }),
        4 if n >= 1 => Ok(n),
        _ => Err(Unmodeled),
    }
}

/// A month or day field of one or two digits.
fn small(s: &str) -> std::result::Result<i64, ResolvedAtError> {
    if !digits(s) || s.len() > 2 {
        return Err(Unmodeled);
    }
    s.parse().map_err(|_| Unmodeled)
}

/// `(year, month, day)` of a date field split on its delimiter.
fn date_field(parts: &[String]) -> std::result::Result<(i64, i64, i64), ResolvedAtError> {
    let named: Vec<usize> = (0..parts.len()).filter(|&i| !digits(&parts[i])).collect();
    match (parts.len(), named.as_slice()) {
        (3, []) if parts[0].len() > 2 => {
            if parts[0].len() != 4 {
                return Err(Unmodeled);
            }
            Ok((year(&parts[0])?, small(&parts[1])?, small(&parts[2])?))
        }
        (3, []) => Ok((year(&parts[2])?, small(&parts[0])?, small(&parts[1])?)),
        (2, []) => Err(Syntax),
        (3, [k]) => {
            let m = i64::from(month(&parts[*k]).ok_or(Unmodeled)?);
            match k {
                // 01-Mar-2026, 1-mar-26
                1 if parts[0].len() <= 2 => Ok((year(&parts[2])?, m, small(&parts[0])?)),
                // 2026-Mar-01
                1 if parts[0].len() == 4 => Ok((year(&parts[0])?, m, small(&parts[2])?)),
                // Mar-01-2026, mar-01-26
                0 => Ok((year(&parts[2])?, m, small(&parts[1])?)),
                _ => Err(Unmodeled),
            }
        }
        _ => Err(Unmodeled),
    }
}

/// `(hour, minute, second, microsecond)` of a time field.
fn time_field(s: &str) -> std::result::Result<(i64, i64, i64, i64), ResolvedAtError> {
    let parts: Vec<&str> = s.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return Err(Unmodeled);
    }
    let h = small(parts[0])?;
    let mi = small(parts[1])?;
    let (sec, us) = match parts.get(2) {
        None => (0, 0),
        Some(field) => {
            let (whole, frac) = field.split_once('.').unwrap_or((field, ""));
            let sec = small(whole)?;
            if !frac.is_empty() && !digits(frac) {
                return Err(Unmodeled);
            }
            // `rint(strtod("0.<frac>") * 1e6)`, as Postgres rounds a fraction to microseconds.
            let us = if frac.is_empty() {
                0
            } else {
                let f: f64 = format!("0.{frac}").parse().map_err(|_| Unmodeled)?;
                (f * 1_000_000.0).round_ties_even() as i64
            };
            (sec, us)
        }
    };
    if h > 24 || mi > 59 || sec > 60 {
        return Err(Range);
    }
    if h == 24 && (mi, sec, us) != (0, 0, 0) {
        return Err(Range);
    }
    Ok((h, mi, sec, us))
}

/// Seconds east of UTC of a numeric offset field.
fn offset_field(west: bool, s: &str) -> std::result::Result<i64, ResolvedAtError> {
    let (h, m) = match s.split_once(':') {
        Some((h, m)) if h.len() <= 2 && m.len() == 2 && digits(h) && digits(m) => (h, m),
        Some(_) => return Err(Unmodeled),
        None if digits(s) && s.len() <= 2 => (s, "00"),
        None if digits(s) && s.len() == 4 => (&s[..2], &s[2..]),
        None => return Err(Unmodeled),
    };
    let (h, m): (i64, i64) = (
        h.parse().map_err(|_| Unmodeled)?,
        m.parse().map_err(|_| Unmodeled)?,
    );
    if m > 59 {
        return Err(Unmodeled);
    }
    if h > 15 {
        return Err(ZoneRange);
    }
    let secs = h * 3600 + m * 60;
    Ok(if west { -secs } else { secs })
}

/// The microseconds since the epoch Postgres stores for `text::timestamptz`, with `now_us` the
/// transaction time (`now`, `today`, `tomorrow`, `yesterday`).
pub(crate) fn parse(text: &str, now_us: i64) -> Parsed {
    let toks = tokens(text.trim())?;
    let has_digit = text.bytes().any(|b| b.is_ascii_digit());
    let special = |w: &str| ["epoch", "now", "today", "tomorrow", "yesterday"].contains(&w);
    if let [Tok::Word(w)] = toks.as_slice()
        && special(w)
    {
        let midnight = now_us.div_euclid(DAY_US) * DAY_US;
        return Ok(match w.as_str() {
            "epoch" => 0,
            "now" => now_us,
            "today" => midnight,
            "tomorrow" => midnight + DAY_US,
            _ => midnight - DAY_US,
        });
    }
    if !has_digit {
        let any_special = toks
            .iter()
            .any(|t| matches!(t, Tok::Word(w) if special(w) || w == "infinity"));
        return Err(if any_special { Unmodeled } else { Syntax });
    }
    let mut date: Option<(i64, i64, i64)> = None;
    let mut named_month: Option<i64> = None;
    // The order of a month name's date fields: `N` a number, `M` the month name.
    let mut shape = String::new();
    let mut nums: Vec<String> = Vec::new();
    let mut time: Option<(i64, i64, i64, i64)> = None;
    let mut pm: Option<bool> = None;
    let mut zone: Option<Zone> = None;
    let mut iso_t = false;
    for tok in &toks {
        if iso_t && !matches!(tok, Tok::Time(_)) {
            return Err(Unmodeled);
        }
        iso_t = false;
        match tok {
            Tok::Date(parts) => {
                if date.is_some() || named_month.is_some() || !nums.is_empty() {
                    return Err(Unmodeled);
                }
                date = Some(date_field(parts)?);
            }
            // After a date, Postgres reads the field as a zone name.
            Tok::Name(name) if date.is_some() => {
                if zone.is_some() {
                    return Err(Unmodeled);
                }
                zone = Some(Zone::Named(named_zone(name).ok_or(Unmodeled)?));
            }
            // Before one, as a date: a month name and numbers with one kind of delimiter.
            Tok::Name(name) => {
                let Some(d) = name.bytes().find(|x| !x.is_ascii_alphanumeric()) else {
                    return Err(Unmodeled);
                };
                if !matches!(d, b'-' | b'/' | b'.')
                    || !name.bytes().all(|x| x == d || x.is_ascii_alphanumeric())
                    || named_month.is_some()
                    || !nums.is_empty()
                {
                    return Err(Unmodeled);
                }
                let parts: Vec<String> = name.split(d as char).map(str::to_owned).collect();
                date = Some(date_field(&parts)?);
            }
            Tok::Num(n)
                if n.len() == 8 && date.is_none() && named_month.is_none() && nums.is_empty() =>
            {
                date = Some((year(&n[..4])?, small(&n[4..6])?, small(&n[6..])?));
            }
            Tok::Num(n) => {
                if date.is_some() || time.is_some() || !(n.len() <= 2 || n.len() == 4) {
                    return Err(Unmodeled);
                }
                shape.push('N');
                nums.push(n.clone());
            }
            Tok::Time(t) => {
                if time.is_some() {
                    return Err(Unmodeled);
                }
                time = Some(time_field(t)?);
            }
            Tok::Word(w) => match w.as_str() {
                "t" => iso_t = true,
                "at" | "on" => {}
                "am" | "pm" if pm.is_none() => pm = Some(w == "pm"),
                "z" | "zulu" | "utc" | "gmt" | "ut" if zone.is_none() => {
                    zone = Some(Zone::Fixed(0))
                }
                w if zone.is_none() && fixed_abbreviation(w).is_some() => {
                    zone = fixed_abbreviation(w).map(Zone::Fixed)
                }
                w if zone.is_none() && dynamic_abbreviation(w).is_some() => {
                    zone = dynamic_abbreviation(w).map(|z| Zone::Dynamic(z, w.to_owned()))
                }
                w if WEEKDAYS.contains(&w) => {}
                w => match month(w) {
                    Some(m) if named_month.is_none() && date.is_none() && time.is_none() => {
                        named_month = Some(i64::from(m));
                        shape.push('M');
                    }
                    // Postgres tries a word it does not know as a zone name.
                    _ => match named_zone(w) {
                        Some(z) if zone.is_none() => zone = Some(Zone::Named(z)),
                        _ => return Err(Unmodeled),
                    },
                },
            },
            Tok::Offset(west, s) => {
                if zone.is_some() {
                    return Err(Unmodeled);
                }
                zone = Some(Zone::Fixed(offset_field(*west, s)?));
            }
        }
    }
    if iso_t {
        return Err(Unmodeled);
    }
    if let Some(m) = named_month {
        date = Some(match shape.as_str() {
            // March 1, 2026; Mar 1, 26
            "MNN" => (year(&nums[1])?, m, small(&nums[0])?),
            // 2026 March 1
            "NMN" if nums[0].len() == 4 => (year(&nums[0])?, m, small(&nums[1])?),
            // 1 March 2026; 1 March 26
            "NMN" => (year(&nums[1])?, m, small(&nums[0])?),
            _ => return Err(Unmodeled),
        });
    } else if !nums.is_empty() {
        return Err(Unmodeled);
    }
    let Some((y, mo, d)) = date else {
        return Err(Unmodeled);
    };
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo).ok_or(Range)? {
        return Err(Range);
    }
    let (mut h, mi, s, us) = time.unwrap_or((0, 0, 0, 0));
    if let Some(pm) = pm {
        if time.is_none() {
            return Err(Unmodeled);
        }
        if h > 12 {
            return Err(Range);
        }
        if pm && h < 12 {
            h += 12;
        } else if !pm && h == 12 {
            h = 0;
        }
    }
    let local = days_from_civil(y, mo, d) * (DAY_US / 1_000_000) + (h * 60 + mi) * 60 + s;
    let instant = match zone {
        None => local,
        Some(Zone::Fixed(east)) => local - east,
        Some(Zone::Dynamic(rules, word)) => abbreviation_instant(rules, &word, local)?,
        Some(Zone::Named(rules)) => local_instant(rules, local)?,
    };
    Ok(instant * 1_000_000 + us)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> String {
        match parse(text, 0) {
            Ok(us) => crate::env::iso(us),
            Err(e) => format!("{e:?}"),
        }
    }

    #[test]
    fn the_forms_postgres_reads_give_its_instant() {
        // Each expectation is what `SELECT '<text>'::timestamptz` gave on PostgreSQL 16 (TimeZone UTC, DateStyle ISO, MDY).
        for (text, want) in [
            ("March 1, 2026", "2026-03-01T00:00:00.000000Z"),
            ("2026/03/01", "2026-03-01T00:00:00.000000Z"),
            ("03/01/2026", "2026-03-01T00:00:00.000000Z"),
            ("3/1/26", "2026-03-01T00:00:00.000000Z"),
            ("1/3/2026", "2026-01-03T00:00:00.000000Z"),
            ("1 March 2026", "2026-03-01T00:00:00.000000Z"),
            ("1 March 26", "2026-03-01T00:00:00.000000Z"),
            ("2026 March 1", "2026-03-01T00:00:00.000000Z"),
            ("Sunday, March 1, 2026", "2026-03-01T00:00:00.000000Z"),
            ("Mar 1, 26", "2026-03-01T00:00:00.000000Z"),
            ("01-Mar-2026", "2026-03-01T00:00:00.000000Z"),
            ("1-mar-26", "2026-03-01T00:00:00.000000Z"),
            ("2026-Mar-01", "2026-03-01T00:00:00.000000Z"),
            ("2026/Mar/01", "2026-03-01T00:00:00.000000Z"),
            ("mar-01-2026", "2026-03-01T00:00:00.000000Z"),
            ("2026.03.01", "2026-03-01T00:00:00.000000Z"),
            ("20260301", "2026-03-01T00:00:00.000000Z"),
            ("2026-3-1", "2026-03-01T00:00:00.000000Z"),
            ("Mar 1 2026 10:30", "2026-03-01T10:30:00.000000Z"),
            ("2026-03-01 10:5", "2026-03-01T10:05:00.000000Z"),
            ("2026-03-01 10:00:60", "2026-03-01T10:01:00.000000Z"),
            ("2026-03-01 10:00:00+02", "2026-03-01T08:00:00.000000Z"),
            ("2026-03-01 +02", "2026-02-28T22:00:00.000000Z"),
            ("2026-03-01 10:00+0530", "2026-03-01T04:30:00.000000Z"),
            ("2026-03-01 10:00 -15:00", "2026-03-02T01:00:00.000000Z"),
            ("2026-03-01T10:00Z", "2026-03-01T10:00:00.000000Z"),
            ("2026-03-01T10:00:00.5+01:00", "2026-03-01T09:00:00.500000Z"),
            ("Mar 1 2026 T10:00", "2026-03-01T10:00:00.000000Z"),
            ("2026-03-01 10:00 UTC", "2026-03-01T10:00:00.000000Z"),
            ("2026-03-01 at 10:00", "2026-03-01T10:00:00.000000Z"),
            ("2026-03-01 0:00 am", "2026-03-01T00:00:00.000000Z"),
            ("2026-03-01 12:00 am", "2026-03-01T00:00:00.000000Z"),
            ("2026-03-01 10:00 pm", "2026-03-01T22:00:00.000000Z"),
            ("2026-03-01 24:00", "2026-03-02T00:00:00.000000Z"),
            ("2026-03-01 10:00:00.1234567", "2026-03-01T10:00:00.123457Z"),
            ("2026-03-01 10:00:00.1234565", "2026-03-01T10:00:00.123456Z"),
            ("2026-03-01 10:00:00.", "2026-03-01T10:00:00.000000Z"),
            ("0026-03-01", "0026-03-01T00:00:00.000000Z"),
            ("2026-03-01 10:00 PST", "2026-03-01T18:00:00.000000Z"),
            ("2026-03-01 10:00 pst", "2026-03-01T18:00:00.000000Z"),
            ("2026-03-01 10:00 CEST", "2026-03-01T08:00:00.000000Z"),
            ("PST 2026-03-01 10:00", "2026-03-01T18:00:00.000000Z"),
            ("2026-03-01 PST", "2026-03-01T08:00:00.000000Z"),
            ("2026-03-01 10:00 IST", "2026-03-01T08:00:00.000000Z"),
            ("March 1 2026 10:00 BST", "2026-03-01T09:00:00.000000Z"),
        ] {
            assert_eq!(at(text), want, "{text}");
        }
    }

    #[test]
    fn the_inputs_postgres_refuses_get_its_error_and_the_rest_are_unmodeled() {
        for (text, want) in [
            ("2026/13/01", "Range"),
            ("13/01/2026", "Range"),
            ("26-03-01", "Range"),
            ("Feb 30 2026", "Range"),
            ("2026-02-30", "Range"),
            ("2026-03-01 25:00", "Range"),
            ("2026-03-01 10:00:61", "Range"),
            ("2026-03-01 13:00 pm", "Range"),
            ("2026-03-01 10:00 +16:00", "ZoneRange"),
            ("2026-03", "Syntax"),
            ("03/01", "Syntax"),
            ("soon", "Syntax"),
            ("2050-07-01 10:00 CLT", "Unmodeled"),
            ("2038-02-01 10:00 EASST", "Unmodeled"),
            ("2026-03-01 10:00 PST+1", "Unmodeled"),
            ("2026-03-01 10:00 Europe/Moscow+1", "Unmodeled"),
            ("2026-03-01 10:00 Mars/Olympus_Mons", "Unmodeled"),
            ("America/New_York 2026-03-01 10:00", "Unmodeled"),
            ("2050-07-01 10:00 America/New_York", "Unmodeled"),
            ("1 Mar 2026 10pm", "Unmodeled"),
            ("March 1", "Unmodeled"),
            ("1 2026 March", "Unmodeled"),
            ("infinity", "Unmodeled"),
            ("1.5", "Syntax"),
            ("2026-03-01 10:00 ñ", "Unmodeled"),
        ] {
            assert_eq!(at(text), want, "{text}");
        }
    }

    #[test]
    fn a_date_dependent_abbreviation_reads_its_zone_at_the_date() {
        // What PostgreSQL 16 gave (TimeZone UTC, DateStyle ISO, MDY; tzdata 2026a, the same transitions
        // for these zones as PGLite's). `MSK` meant +04 from 2011 to 2014; in July 1985 Moscow kept
        // `MSD`, so `MSK` reads its last earlier meaning, +03. `SGT` is no abbreviation of
        // Asia/Singapore's tzdata, so it reads the zone's offset at the date (+07:30 in 1980).
        for (text, want) in [
            ("2026-03-01 10:00 MSK", "2026-03-01T07:00:00.000000Z"),
            ("2026-03-01 10:00 msk", "2026-03-01T07:00:00.000000Z"),
            ("2012-03-01 10:00 MSK", "2012-03-01T06:00:00.000000Z"),
            ("2014-10-26 00:30 MSK", "2014-10-25T20:30:00.000000Z"),
            ("2014-10-26 01:30 MSK", "2014-10-25T22:30:00.000000Z"),
            ("1985-07-01 12:00 MSK", "1985-07-01T09:00:00.000000Z"),
            ("2026-03-01 10:00 SGT", "2026-03-01T02:00:00.000000Z"),
            ("1980-03-01 10:00 SGT", "1980-03-01T02:30:00.000000Z"),
            ("2026-07-01 10:00 CLT", "2026-07-01T14:00:00.000000Z"),
            ("2026-01-15 10:00 EASST", "2026-01-15T15:00:00.000000Z"),
            ("2026-01-15 10:00 LHDT", "2026-01-14T23:00:00.000000Z"),
            ("2026-03-01 10:00 PYT", "2026-03-01T13:00:00.000000Z"),
            ("March 1, 2026 MSK", "2026-02-28T21:00:00.000000Z"),
            ("2026-03-01 MSK", "2026-02-28T21:00:00.000000Z"),
            ("2026-03-01 10:00 pm Novt", "2026-03-01T15:00:00.000000Z"),
            ("1900-01-01 00:00 VET", "1900-01-01T04:27:40.000000Z"),
        ] {
            assert_eq!(at(text), want, "{text}");
        }
    }

    #[test]
    fn a_zone_name_after_the_date_reads_the_zone_at_the_date() {
        // What PostgreSQL 16 gave, as above. A local time the spring change skips takes the offset
        // before it; one the autumn change repeats takes the offset after it.
        for (text, want) in [
            (
                "2026-03-01 10:00 America/New_York",
                "2026-03-01T15:00:00.000000Z",
            ),
            (
                "2026-03-01 10:00 america/new_york",
                "2026-03-01T15:00:00.000000Z",
            ),
            (
                "2026-07-01 10:00 America/New_York",
                "2026-07-01T14:00:00.000000Z",
            ),
            (
                "2026-03-08 02:30 America/New_York",
                "2026-03-08T07:30:00.000000Z",
            ),
            (
                "2026-11-01 01:30 America/New_York",
                "2026-11-01T06:30:00.000000Z",
            ),
            (
                "2026-03-01 10:00 Europe/Moscow",
                "2026-03-01T07:00:00.000000Z",
            ),
            (
                "2012-03-01 10:00 Europe/Moscow",
                "2012-03-01T06:00:00.000000Z",
            ),
            ("2026-03-01 10:00 EST5EDT", "2026-03-01T15:00:00.000000Z"),
            ("2026-03-01 10:00 Etc/GMT+3", "2026-03-01T13:00:00.000000Z"),
            ("2026-03-01 10:00 Japan", "2026-03-01T01:00:00.000000Z"),
            ("Japan 2026-03-01 10:00", "2026-03-01T01:00:00.000000Z"),
            ("2026-03-01 10:00 US/Pacific", "2026-03-01T18:00:00.000000Z"),
            (
                "2026-03-01 10:00 Asia/Kolkata",
                "2026-03-01T04:30:00.000000Z",
            ),
            (
                "2026-03-01 10:00 America/Port-au-Prince",
                "2026-03-01T15:00:00.000000Z",
            ),
            (
                "2026-07-01 10:00 Australia/Lord_Howe",
                "2026-06-30T23:30:00.000000Z",
            ),
            ("2026-03-01 Europe/London", "2026-03-01T00:00:00.000000Z"),
            (
                "2026-03-01T10:00 Europe/Paris",
                "2026-03-01T09:00:00.000000Z",
            ),
        ] {
            assert_eq!(at(text), want, "{text}");
        }
    }

    #[test]
    fn the_special_words_read_the_transaction_time() {
        let now = 1_772_359_200_000_000; // 2026-03-01T10:00:00Z
        assert_eq!(
            crate::env::iso(parse("today", now).unwrap()),
            "2026-03-01T00:00:00.000000Z"
        );
        assert_eq!(
            crate::env::iso(parse("Tomorrow", now).unwrap()),
            "2026-03-02T00:00:00.000000Z"
        );
        assert_eq!(
            crate::env::iso(parse("yesterday", now).unwrap()),
            "2026-02-28T00:00:00.000000Z"
        );
        assert_eq!(parse("now", now), Ok(now));
        assert_eq!(parse("epoch", now), Ok(0));
        assert_eq!(parse("today 10:00", now), Err(Unmodeled));
    }
}
