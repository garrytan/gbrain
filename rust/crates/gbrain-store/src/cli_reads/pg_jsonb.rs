//! Postgres's `jsonb::text` of a JSON text, read from the text itself: `jsonb` stores a number as
//! `numeric`, which keeps the digits and the scale of the literal (`1.0`, `1.50`, `100e-2` prints
//! `1.00`, `1e2` prints `100`), where a `serde_json::Value` keeps only an `f64` (`1`, `1.5`, `1`).
//! A text scrub that matches needles in `lower(column::text)` must see the digits Postgres prints,
//! so the generation ledger keeps this text beside the value it stores (generations.rs).
//!
//! The rest is the jsonb form `pg_text::jsonb_text` also prints: object keys by (length, bytes)
//! with the last of duplicate keys kept, `", "` and `": "` separators, strings escaped as JSON.

use serde_json::Value;

/// A JSON value as `jsonb` holds it; a number is its `numeric` text.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Jsonb {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<Jsonb>),
    Object(Vec<(String, Jsonb)>),
}

impl Jsonb {
    /// `value::text` of the jsonb value.
    pub(crate) fn text(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    /// `value->key` of a jsonb object: None for a missing key or a value that is not an object.
    pub(crate) fn get(&self, key: &str) -> Option<&Jsonb> {
        match self {
            Jsonb::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn write(&self, out: &mut String) {
        match self {
            Jsonb::Null => out.push_str("null"),
            Jsonb::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Jsonb::Number(n) => out.push_str(n),
            Jsonb::String(s) => out.push_str(&Value::String(s.clone()).to_string()),
            Jsonb::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Jsonb::Object(entries) => {
                out.push('{');
                for (i, (key, item)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(&Value::String(key.clone()).to_string());
                    out.push_str(": ");
                    item.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// The jsonb value of a JSON text, or None when the text is not JSON this reader takes (the caller
/// has parsed it already, so None means a number outside `numeric_text`'s range).
pub(crate) fn parse(text: &str) -> Option<Jsonb> {
    let mut parser = Parser {
        text,
        bytes: text.as_bytes(),
        at: 0,
    };
    let value = parser.value()?;
    parser.space();
    (parser.at == parser.bytes.len()).then_some(value)
}

/// The `numeric` text Postgres prints for a JSON number literal: every digit of the literal, the
/// point moved by the exponent, `max(0, fraction digits - exponent)` fraction digits, no leading
/// zeros, and no sign on zero. None for text that is not a JSON number or an exponent past 10^6.
pub(crate) fn numeric_text(literal: &str) -> Option<String> {
    let (negative, rest) = match literal.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, literal),
    };
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(at) => (&rest[..at], rest[at + 1..].parse::<i64>().ok()?),
        None => (rest, 0),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits_only = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    if int.is_empty() || !digits_only(int) || !digits_only(frac) || exponent.abs() > 1_000_000 {
        return None;
    }
    let digits = format!("{int}{frac}");
    let point = int.len() as i64 + exponent;
    let scale = (frac.len() as i64 - exponent).max(0) as usize;
    let (whole, fraction) = if point <= 0 {
        (
            "0".to_string(),
            format!("{}{digits}", "0".repeat(point.unsigned_abs() as usize)),
        )
    } else if point as usize >= digits.len() {
        (
            format!("{digits}{}", "0".repeat(point as usize - digits.len())),
            String::new(),
        )
    } else {
        (
            digits[..point as usize].to_string(),
            digits[point as usize..].to_string(),
        )
    };
    debug_assert_eq!(fraction.len(), scale);
    let whole = match whole.trim_start_matches('0') {
        "" => "0",
        trimmed => trimmed,
    };
    let zero = digits.bytes().all(|c| c == b'0');
    let mut out = String::with_capacity(whole.len() + scale + 2);
    if negative && !zero {
        out.push('-');
    }
    out.push_str(whole);
    if scale > 0 {
        out.push('.');
        out.push_str(&fraction);
    }
    Some(out)
}

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn space(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn word(&mut self, word: &str, value: Jsonb) -> Option<Jsonb> {
        self.text[self.at..].starts_with(word).then(|| {
            self.at += word.len();
            value
        })
    }

    fn value(&mut self) -> Option<Jsonb> {
        self.space();
        match *self.bytes.get(self.at)? {
            b'n' => self.word("null", Jsonb::Null),
            b't' => self.word("true", Jsonb::Bool(true)),
            b'f' => self.word("false", Jsonb::Bool(false)),
            b'"' => self.string().map(Jsonb::String),
            b'[' => self.array(),
            b'{' => self.object(),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn string(&mut self) -> Option<String> {
        let start = self.at;
        self.at += 1;
        loop {
            match *self.bytes.get(self.at)? {
                b'\\' => self.at += 2,
                b'"' => {
                    self.at += 1;
                    break;
                }
                _ => self.at += 1,
            }
        }
        serde_json::from_str(self.text.get(start..self.at)?).ok()
    }

    fn number(&mut self) -> Option<Jsonb> {
        let start = self.at;
        while matches!(
            self.bytes.get(self.at),
            Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
        ) {
            self.at += 1;
        }
        numeric_text(&self.text[start..self.at]).map(Jsonb::Number)
    }

    /// After `open`: `]` or `}` closes an empty list at once; otherwise each element, then `,` or the close.
    fn elements(
        &mut self,
        close: u8,
        mut element: impl FnMut(&mut Self) -> Option<()>,
    ) -> Option<()> {
        self.at += 1;
        self.space();
        if self.bytes.get(self.at) == Some(&close) {
            self.at += 1;
            return Some(());
        }
        loop {
            element(self)?;
            self.space();
            match *self.bytes.get(self.at)? {
                b',' => self.at += 1,
                c if c == close => {
                    self.at += 1;
                    return Some(());
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self) -> Option<Jsonb> {
        let mut items = Vec::new();
        self.elements(b']', |p| {
            items.push(p.value()?);
            Some(())
        })?;
        Some(Jsonb::Array(items))
    }

    fn object(&mut self) -> Option<Jsonb> {
        let mut entries: Vec<(String, Jsonb)> = Vec::new();
        self.elements(b'}', |p| {
            p.space();
            if p.bytes.get(p.at) != Some(&b'"') {
                return None;
            }
            let key = p.string()?;
            p.space();
            if p.bytes.get(p.at) != Some(&b':') {
                return None;
            }
            p.at += 1;
            let value = p.value()?;
            // jsonb keeps the last value of a duplicate key.
            match entries.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = value,
                None => entries.push((key, value)),
            }
            Some(())
        })?;
        entries.sort_by(|a, b| {
            a.0.len()
                .cmp(&b.0.len())
                .then_with(|| a.0.as_bytes().cmp(b.0.as_bytes()))
        });
        Some(Jsonb::Object(entries))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_postgres_numeric_prints_them() {
        // Each pair is a JSON literal and `literal::jsonb::text` on Postgres 16 and PGLite.
        for (literal, text) in [
            ("1", "1"),
            ("1.0", "1.0"),
            ("1.50", "1.50"),
            ("1e2", "100"),
            ("1.0e2", "100"),
            ("100e-2", "1.00"),
            ("-0", "0"),
            ("-0.0", "0.0"),
            ("1e+21", "1000000000000000000000"),
            ("1.5e-7", "0.00000015"),
            ("0.5e1", "5"),
            ("007", "7"),
            ("-12.340", "-12.340"),
            (
                "123456789012345678901234567890",
                "123456789012345678901234567890",
            ),
        ] {
            assert_eq!(numeric_text(literal).as_deref(), Some(text), "{literal}");
        }
        assert_eq!(numeric_text("1e2000000"), None);
        assert_eq!(numeric_text(".5"), None);
    }

    #[test]
    fn text_orders_keys_keeps_the_last_duplicate_and_the_number_digits() {
        let text =
            r#" {"bb": [1.0, {"z": null}], "a": 1, "a": "x\n\u0001", "c": true, "b": 1.50} "#;
        assert_eq!(
            parse(text).unwrap().text(),
            r#"{"a": "x\n\u0001", "b": 1.50, "c": true, "bb": [1.0, {"z": null}]}"#
        );
        assert_eq!(parse("null").unwrap(), Jsonb::Null);
        assert_eq!(
            parse(r#"{"fence":{"n":100e-2}}"#)
                .unwrap()
                .get("fence")
                .unwrap()
                .text(),
            r#"{"n": 1.00}"#
        );
        assert_eq!(parse("[] x"), None);
        assert_eq!(parse("{}").unwrap().text(), "{}");
    }
}
