//! Fact vectors: the `facts.embedding halfvec(N)` column and the pgvector arithmetic over it.
//! Only what the collapse read (`md5`) and the fact row's stored vector (`half_hex`) need is here.

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
