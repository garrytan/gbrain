//! Fact vectors: the `facts.embedding halfvec(N)` column and the pgvector arithmetic over it.
//!
//! The TypeScript member sends a vector as the literal PGLite casts (`'[a,b,...]'`, JavaScript's
//! `Array.join(',')` of the `Float32Array`). It is read as pgvector's `vector_in` reads it (each
//! element an `f32`), then cast to `halfvec` (each element rounded to the nearest `f16`, ties to
//! even), with the error texts of both. The stored row keeps the rounded values; every one is an
//! `f16`, so the record holds the 16-bit patterns as hex.

use crate::error::{INVALID_ARGUMENT, Result, StoreError};

/// pgvector's `VECTOR_MAX_DIM` (and `HALFVEC_MAX_DIM`).
const MAX_DIM: usize = 16_000;
/// The largest finite `f16`.
const HALF_MAX: f64 = 65_504.0;

fn invalid(message: String) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, message)
}

/// The elements of a vector literal, without reading them (the keyword arm reads only the count).
pub(crate) fn literal_len(literal: &str) -> usize {
    let inner = literal
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim();
    if inner.is_empty() {
        0
    } else {
        inner.split(',').count()
    }
}

/// `'<literal>'::vector`: the `f32` elements, or pgvector's error.
pub(crate) fn parse_vector(literal: &str) -> Result<Vec<f32>> {
    let syntax = || {
        invalid(format!(
            "invalid input syntax for type vector: \"{literal}\""
        ))
    };
    let inner = literal
        .trim()
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .ok_or_else(syntax)?
        .trim();
    if inner.is_empty() {
        return Err(invalid("vector must have at least 1 dimension".into()));
    }
    let mut out = Vec::new();
    for token in inner.split(',') {
        let token = token.trim();
        let x: f32 = token.parse().map_err(|_| syntax())?;
        let spelled_infinite = token
            .trim_start_matches(['-', '+'])
            .get(..3)
            .is_some_and(|s| s.eq_ignore_ascii_case("inf"));
        if x.is_infinite() && !spelled_infinite {
            return Err(invalid(format!(
                "\"{token}\" is out of range for type vector"
            )));
        }
        if x.is_nan() {
            return Err(invalid("NaN not allowed in vector".into()));
        }
        if x.is_infinite() {
            return Err(invalid("infinite value not allowed in vector".into()));
        }
        out.push(x);
        if out.len() > MAX_DIM {
            return Err(invalid(format!(
                "vector cannot have more than {MAX_DIM} dimensions"
            )));
        }
    }
    Ok(out)
}

/// `vector::halfvec(dims)`: the dimension check (when the column fixes one), then each element
/// rounded to `f16`. An element that rounds past the largest `f16` refuses with the `float4`
/// text Postgres prints for it.
pub(crate) fn to_halfvec(vector: &[f32], dims: Option<usize>) -> Result<Vec<f32>> {
    if let Some(dims) = dims
        && vector.len() != dims
    {
        return Err(invalid(format!(
            "expected {dims} dimensions, not {}",
            vector.len()
        )));
    }
    vector
        .iter()
        .map(|&x| {
            half_round(x).ok_or_else(|| {
                invalid(format!(
                    "\"{}\" is out of range for type halfvec",
                    float4_out(x)
                ))
            })
        })
        .collect()
}

/// `x` rounded to the nearest `f16` (ties to even), as an `f32`; `None` when it overflows.
fn half_round(x: f32) -> Option<f32> {
    if x == 0.0 {
        return Some(x);
    }
    let a = f64::from(x.abs());
    let ulp = if a < 2f64.powi(-14) {
        2f64.powi(-24)
    } else {
        // A normal `f32`: its binary exponent is the `f16` one.
        let exponent = ((x.to_bits() >> 23) & 0xff) as i32 - 127;
        2f64.powi(exponent - 10)
    };
    let r = (a / ulp).round_ties_even() * ulp;
    if r > HALF_MAX {
        return None;
    }
    Some((r as f32).copysign(x))
}

/// Postgres `float4out`: the shortest text naming `x`, in exponent form from `1e+06` up.
pub(crate) fn float4_out(x: f32) -> String {
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if (-4..6).contains(&exp) {
        return format!("{x}");
    }
    let sign = if exp < 0 { '-' } else { '+' };
    format!("{mantissa}e{sign}{:02}", exp.abs())
}

/// The 16-bit pattern of an `f32` that holds an `f16` value exactly.
fn half_bits(x: f32) -> u16 {
    let sign = if x.is_sign_negative() { 0x8000 } else { 0 };
    let a = x.abs();
    if a == 0.0 {
        return sign;
    }
    if a < 2f32.powi(-14) {
        return sign | (a * 2f32.powi(24)) as u16;
    }
    let bits = a.to_bits();
    let exp = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    sign | ((exp as u16) << 10) | ((bits >> 13) & 0x3ff) as u16
}

fn half_value(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = i32::from((h >> 10) & 0x1f);
    let mant = f32::from(h & 0x3ff);
    sign * if exp == 0 {
        mant * 2f32.powi(-24)
    } else {
        (1.0 + mant / 1024.0) * 2f32.powi(exp - 15)
    }
}

/// `halfvec_cosine_distance`: `f32` sums, the similarity in `f64`, NaN kept, clamped to [-1, 1].
pub(crate) fn cosine_distance(a: &[f32], b: &[f32]) -> f64 {
    let (mut dot, mut na, mut nb) = (0f32, 0f32, 0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let similarity = f64::from(dot) / (f64::from(na) * f64::from(nb)).sqrt();
    if similarity.is_nan() {
        return f64::NAN;
    }
    1.0 - similarity.clamp(-1.0, 1.0)
}

/// Postgres `md5(text)`: the lower-case hex digest of the UTF-8 bytes.
pub(crate) fn md5_hex(text: &str) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let k: Vec<u32> = (0..64)
        .map(|i| ((i as f64 + 1.0).sin().abs() * 4_294_967_296.0) as u32)
        .collect();
    let mut msg = text.as_bytes().to_vec();
    let bit_len = (msg.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());
    let mut state: [u32; 4] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
    for block in msg.chunks(64) {
        let m: Vec<u32> = block
            .chunks(4)
            .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
            .collect();
        let [mut a, mut b, mut c, mut d] = state;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let rotated = a
                .wrapping_add(f)
                .wrapping_add(k[i])
                .wrapping_add(m[g])
                .rotate_left(S[i]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(rotated);
        }
        for (s, v) in state.iter_mut().zip([a, b, c, d]) {
            *s = s.wrapping_add(v);
        }
    }
    state
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `FactRecord::embedding` on disk: the `f16` patterns as hex, four digits an element.
pub(crate) mod half_hex {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<Vec<f32>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => s.serialize_str(
                &v.iter()
                    .map(|&x| format!("{:04x}", super::half_bits(x)))
                    .collect::<String>(),
            ),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<f32>>, D::Error> {
        let Some(hex) = Option::<String>::deserialize(d)? else {
            return Ok(None);
        };
        hex.as_bytes()
            .chunks(4)
            .map(|c| {
                std::str::from_utf8(c)
                    .ok()
                    .and_then(|c| u16::from_str_radix(c, 16).ok())
                    .map(super::half_value)
                    .ok_or_else(|| serde::de::Error::custom("bad halfvec hex"))
            })
            .collect::<Result<Vec<f32>, D::Error>>()
            .map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_matches_postgres() {
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex("ok"), "444bcb3a3fcf8389296c49467f27e1d6");
        assert_eq!(md5_hex("x"), "9dd4e461268c8034f5c8564e155c67a6");
        let long = "a".repeat(200);
        assert_eq!(md5_hex(&long).len(), 32);
    }

    #[test]
    fn halfvec_rounds_as_pgvector_does() {
        let v = to_halfvec(
            &[0.1, 1.0 / 3.0, 0.7, 1e-5, 6.1e-5, 3e-8, 1e-8, 65519.0],
            None,
        )
        .unwrap();
        assert_eq!(
            v.iter().map(|&x| f64::from(x)).collect::<Vec<_>>(),
            [
                0.0999755859375,
                0.333251953125,
                0.7001953125,
                0.000010013580322265625,
                0.00006097555160522461,
                5.960464477539063e-8,
                0.0,
                65504.0
            ]
        );
        for x in v {
            assert_eq!(half_value(half_bits(x)), x);
        }
        let err = |x: f32| to_halfvec(&[x], None).unwrap_err().message;
        assert_eq!(err(65520.0), "\"65520\" is out of range for type halfvec");
        assert_eq!(err(65520.5), "\"65520.5\" is out of range for type halfvec");
        assert_eq!(
            err(999_999.0),
            "\"999999\" is out of range for type halfvec"
        );
        assert_eq!(err(1e6), "\"1e+06\" is out of range for type halfvec");
        assert_eq!(
            err(1_234_567.0),
            "\"1.234567e+06\" is out of range for type halfvec"
        );
        assert_eq!(err(-1e6), "\"-1e+06\" is out of range for type halfvec");
        assert_eq!(err(3.4e38), "\"3.4e+38\" is out of range for type halfvec");
        assert_eq!(
            to_halfvec(&[1.0; 8], Some(1024)).unwrap_err().message,
            "expected 1024 dimensions, not 8"
        );
    }

    #[test]
    fn vector_literals_refuse_as_pgvector_does() {
        let err = |s: &str| parse_vector(s).unwrap_err().message;
        assert_eq!(err("[]"), "vector must have at least 1 dimension");
        assert_eq!(err("[1,NaN]"), "NaN not allowed in vector");
        assert_eq!(err("[Infinity]"), "infinite value not allowed in vector");
        assert_eq!(err("[-Infinity]"), "infinite value not allowed in vector");
        assert_eq!(err("[1e39]"), "\"1e39\" is out of range for type vector");
        assert_eq!(parse_vector("[0.5,-2]").unwrap(), [0.5, -2.0]);
        assert_eq!(literal_len("[]"), 0);
        assert_eq!(literal_len("[1,2,3]"), 3);
    }

    #[test]
    fn cosine_distance_matches_pgvector() {
        // Probed on PGLite: a stored [0.1, 1/3, 0.7] (as halfvec) against e0.
        let stored = to_halfvec(&[0.1, 1.0 / 3.0, 0.7], None).unwrap();
        let d = cosine_distance(&stored, &[1.0, 0.0, 0.0]);
        assert!((d - 0.8721332218048006).abs() < 1e-6, "{d}");
        // The query is cast to halfvec too: [0.3, 0.2, 0.1] against the same row.
        let q = to_halfvec(&[0.3, 0.2, 0.1], None).unwrap();
        let d = cosine_distance(&stored, &q);
        assert!((d - 0.43041823380960864).abs() < 1e-9, "{d}");
        assert!(cosine_distance(&[0.0, 0.0], &[1.0, 0.0]).is_nan());
        assert_eq!(cosine_distance(&[1.0, 0.0], &[1.0, 0.0]), 0.0);
    }
}
