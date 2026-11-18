//! A port of PostgreSQL's `english_stem` text search dictionary (`ts_lexize('english_stem', word)`),
//! PostgreSQL 18: `dict_snowball.c` around the generated Snowball 2.2.0 `stem_UTF_8_english.c`
//! (with the runtime in `utilities.c` and `api.c`) and the `english.stop` stopword list.
//! Derived from PostgreSQL 18.6; licence and notice: third-party/postgresql/NOTICE.md
//! Also derived from Snowball 2.2.0; licence and notice: third-party/snowball/NOTICE.md
//!
//! `dsnowball_lexize` for a UTF-8 database:
//!
//! 1. The word is lowercased with `str_tolower` (one `towlower` call per character, no final-sigma or
//!    other context rules). The parity database (PGLite) is UTF-8 with the `C` collation and the
//!    `C.UTF-8` ctype, and its libc lowercases non-ASCII letters (`CAFÉ` becomes `café`, `İ` becomes
//!    `i`). Its tables are older than Rust's, so [`NOT_LOWERCASED`] lists the code points Rust
//!    lowercases but that libc leaves alone.
//! 2. A word longer than 1000 bytes (measured before lowercasing) is returned lowercased and not
//!    stemmed, and the stopword check does not run for it.
//! 3. An empty word or a stopword (checked on the lowercased word, before stemming) yields no
//!    lexeme.
//! 4. Otherwise the Snowball stemmer runs on the UTF-8 bytes. When it leaves an empty string (for
//!    example the word `'`), the lowercased word is returned unchanged.
//!
//! The stemmer below is a line-by-line port of the generated C, including its byte-level handling of
//! UTF-8 (`get_utf8`, `skip_utf8`, the `*_grouping_U` helpers) and its binary search over the
//! `among` tables (`find_among`, `find_among_b`).
//!
//! Nothing in this crate calls these functions yet, so the items carry `allow(dead_code)`.
#![allow(dead_code)]

/// `english.stop` from PostgreSQL 18 (`src/backend/snowball/stopwords/english.stop`).
const ENGLISH_STOPWORDS: [&str; 127] = [
    "i",
    "me",
    "my",
    "myself",
    "we",
    "our",
    "ours",
    "ourselves",
    "you",
    "your",
    "yours",
    "yourself",
    "yourselves",
    "he",
    "him",
    "his",
    "himself",
    "she",
    "her",
    "hers",
    "herself",
    "it",
    "its",
    "itself",
    "they",
    "them",
    "their",
    "theirs",
    "themselves",
    "what",
    "which",
    "who",
    "whom",
    "this",
    "that",
    "these",
    "those",
    "am",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "having",
    "do",
    "does",
    "did",
    "doing",
    "a",
    "an",
    "the",
    "and",
    "but",
    "if",
    "or",
    "because",
    "as",
    "until",
    "while",
    "of",
    "at",
    "by",
    "for",
    "with",
    "about",
    "against",
    "between",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "to",
    "from",
    "up",
    "down",
    "in",
    "out",
    "on",
    "off",
    "over",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "any",
    "both",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "s",
    "t",
    "can",
    "will",
    "just",
    "don",
    "should",
    "now",
];

/// Code points that Rust's `char::to_lowercase` maps but the libc in the parity database does not
/// (newer Unicode additions and the circled capital letters). Inclusive ranges, sorted.
const NOT_LOWERCASED: &[(u32, u32)] = &[
    (0x1C89, 0x1C89),
    (0x24B6, 0x24CF),
    (0x2C2F, 0x2C2F),
    (0xA7C0, 0xA7C0),
    (0xA7C7, 0xA7C7),
    (0xA7C9, 0xA7C9),
    (0xA7CB, 0xA7CC),
    (0xA7CE, 0xA7CE),
    (0xA7D0, 0xA7D0),
    (0xA7D2, 0xA7D2),
    (0xA7D4, 0xA7D4),
    (0xA7D6, 0xA7D6),
    (0xA7D8, 0xA7D8),
    (0xA7DA, 0xA7DA),
    (0xA7DC, 0xA7DD),
    (0xA7E2, 0xA7E2),
    (0xA7F5, 0xA7F5),
    (0xAB6C, 0xAB6D),
    (0x10570, 0x1057A),
    (0x1057C, 0x1058A),
    (0x1058C, 0x10592),
    (0x10594, 0x10595),
    (0x10D50, 0x10D65),
    (0x16EA0, 0x16EB8),
    (0x1DF40, 0x1DF40),
    (0x1DF48, 0x1DF48),
    (0x1DF4A, 0x1DF4A),
    (0x1DF4D, 0x1DF4D),
    (0x1DF51, 0x1DF51),
    (0x1DF68, 0x1DF68),
    (0x1DF6A, 0x1DF6A),
    (0x1DF6C, 0x1DF6C),
    (0x1DF6E, 0x1DF6E),
    (0x1DF72, 0x1DF72),
    (0x1DF74, 0x1DF74),
    (0x1DF76, 0x1DF76),
    (0x1DF78, 0x1DF78),
    (0x1DF7A, 0x1DF7A),
    (0x1DF7C, 0x1DF7C),
    (0x1DF7E, 0x1DF7E),
];

/// Strings longer than this many bytes skip the stemmer and the stopword check.
const MAX_STEM_INPUT_BYTES: usize = 1000;

/// What `ts_lexize('english_stem', word)` returns: `None` for a stopword (or the empty string),
/// else the lexeme.
pub(crate) fn english_stem(word: &str) -> Option<String> {
    let lowered = pg_lower(word);
    if word.len() > MAX_STEM_INPUT_BYTES {
        return Some(lowered);
    }
    if lowered.is_empty() || is_english_stopword(&lowered) {
        return None;
    }
    let mut env = Env::new(lowered.as_bytes());
    env.stem();
    if env.p.is_empty() {
        return Some(lowered);
    }
    // The stemmer only deletes ASCII suffixes, swaps ASCII letters and cuts at character
    // boundaries, so valid UTF-8 stays valid UTF-8.
    Some(String::from_utf8_lossy(&env.p).into_owned())
}

/// Whether `lowercased` is in PostgreSQL's English stopword list. The word must already be
/// lowercased (the list holds lowercase words and PostgreSQL compares the lowercased input).
pub(crate) fn is_english_stopword(lowercased: &str) -> bool {
    ENGLISH_STOPWORDS.contains(&lowercased)
}

/// `str_tolower` for a UTF-8 database with the C.UTF-8 ctype: `towlower` per character.
pub(crate) fn pg_lower(word: &str) -> String {
    if word.is_ascii() {
        return word.to_ascii_lowercase();
    }
    word.chars().map(pg_lower_char).collect()
}

fn pg_lower_char(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let cp = c as u32;
    if NOT_LOWERCASED
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
    {
        return c;
    }
    // `İ` lowercases to `i` plus a combining dot in Unicode; libc `towlower` gives plain `i`.
    c.to_lowercase().next().unwrap_or(c)
}

/// One entry of a Snowball `among` table.
struct Among {
    s: &'static [u8],
    substring_i: i32,
    result: i32,
}

const G_AEO: &[u8] = &[17, 64];
const G_V: &[u8] = &[17, 65, 16, 1];
const G_V_WXY: &[u8] = &[1, 17, 65, 208, 1];
const G_VALID_LI: &[u8] = &[55, 141, 2];

/// Snowball's `SN_env`: the buffer `p` (length `l`), cursor `c`, backward limit `lb`, the slice
/// `[bra, ket)` and the integer variables (`I[0]` = p2, `I[1]` = p1, `I[2]` = "has `Y`" flag).
struct Env {
    p: Vec<u8>,
    c: i32,
    l: i32,
    lb: i32,
    bra: i32,
    ket: i32,
    i: [i32; 3],
}

/// `skip_utf8`: skip `n` characters forwards from `c`; `None` on failure.
fn skip_utf8(p: &[u8], mut c: i32, limit: i32, n: i32) -> Option<i32> {
    if n < 0 {
        return None;
    }
    for _ in 0..n {
        if c >= limit {
            return None;
        }
        let b = p[c as usize];
        c += 1;
        if b >= 0xC0 {
            while c < limit {
                let b = p[c as usize];
                if !(0x80..0xC0).contains(&b) {
                    break;
                }
                c += 1;
            }
        }
    }
    Some(c)
}

/// `skip_b_utf8`: skip `n` characters backwards from `c`; `None` on failure.
fn skip_b_utf8(p: &[u8], mut c: i32, limit: i32, n: i32) -> Option<i32> {
    if n < 0 {
        return None;
    }
    for _ in 0..n {
        if c <= limit {
            return None;
        }
        c -= 1;
        let b = p[c as usize];
        if b >= 0x80 {
            while c > limit {
                let b = p[c as usize];
                if b >= 0xC0 {
                    break;
                }
                c -= 1;
            }
        }
    }
    Some(c)
}

/// `get_utf8`: the code point at `c` and its byte width, or `None` at the end.
fn get_utf8(p: &[u8], mut c: i32, l: i32) -> Option<(i32, i32)> {
    if c >= l {
        return None;
    }
    let b0 = i32::from(p[c as usize]);
    c += 1;
    if b0 < 0xC0 || c == l {
        return Some((b0, 1));
    }
    let b1 = i32::from(p[c as usize]) & 0x3F;
    c += 1;
    if b0 < 0xE0 || c == l {
        return Some((((b0 & 0x1F) << 6) | b1, 2));
    }
    let b2 = i32::from(p[c as usize]) & 0x3F;
    c += 1;
    if b0 < 0xF0 || c == l {
        return Some((((b0 & 0xF) << 12) | (b1 << 6) | b2, 3));
    }
    let b3 = i32::from(p[c as usize]) & 0x3F;
    Some((((b0 & 0x7) << 18) | (b1 << 12) | (b2 << 6) | b3, 4))
}

/// `get_b_utf8`: the code point ending at `c` and its byte width, or `None` at the start.
fn get_b_utf8(p: &[u8], mut c: i32, lb: i32) -> Option<(i32, i32)> {
    if c <= lb {
        return None;
    }
    c -= 1;
    let mut b = i32::from(p[c as usize]);
    if b < 0x80 || c == lb {
        return Some((b, 1));
    }
    let mut a = b & 0x3F;
    c -= 1;
    b = i32::from(p[c as usize]);
    if b >= 0xC0 || c == lb {
        return Some((((b & 0x1F) << 6) | a, 2));
    }
    a |= (b & 0x3F) << 6;
    c -= 1;
    b = i32::from(p[c as usize]);
    if b >= 0xE0 || c == lb {
        return Some((((b & 0xF) << 12) | a, 3));
    }
    c -= 1;
    Some((
        (i32::from(p[c as usize]) & 0x7) << 18 | (b & 0x3F) << 12 | a,
        4,
    ))
}

/// Whether `ch` is in the grouping bit set `s` (covering `min..=max`).
fn in_set(s: &[u8], min: i32, max: i32, ch: i32) -> bool {
    if ch > max {
        return false;
    }
    let ch = ch - min;
    if ch < 0 {
        return false;
    }
    s[(ch >> 3) as usize] & (1 << (ch & 7)) != 0
}

impl Env {
    fn new(word: &[u8]) -> Self {
        Env {
            p: word.to_vec(),
            c: 0,
            l: word.len() as i32,
            lb: 0,
            bra: 0,
            ket: 0,
            i: [0; 3],
        }
    }

    fn at(&self, index: i32) -> u8 {
        self.p[index as usize]
    }

    /// `in_grouping_U`: -1 at the end, the width of the first character outside the set, or 0.
    fn in_grouping_u(&mut self, s: &[u8], min: i32, max: i32, repeat: bool) -> i32 {
        loop {
            let Some((ch, w)) = get_utf8(&self.p, self.c, self.l) else {
                return -1;
            };
            if !in_set(s, min, max, ch) {
                return w;
            }
            self.c += w;
            if !repeat {
                return 0;
            }
        }
    }

    /// `in_grouping_b_U`: the backward counterpart of `in_grouping_u`.
    fn in_grouping_b_u(&mut self, s: &[u8], min: i32, max: i32, repeat: bool) -> i32 {
        loop {
            let Some((ch, w)) = get_b_utf8(&self.p, self.c, self.lb) else {
                return -1;
            };
            if !in_set(s, min, max, ch) {
                return w;
            }
            self.c -= w;
            if !repeat {
                return 0;
            }
        }
    }

    /// `out_grouping_U`: -1 at the end, the width of the first character inside the set, or 0.
    fn out_grouping_u(&mut self, s: &[u8], min: i32, max: i32, repeat: bool) -> i32 {
        loop {
            let Some((ch, w)) = get_utf8(&self.p, self.c, self.l) else {
                return -1;
            };
            if in_set(s, min, max, ch) {
                return w;
            }
            self.c += w;
            if !repeat {
                return 0;
            }
        }
    }

    /// `out_grouping_b_U`: the backward counterpart of `out_grouping_u`.
    fn out_grouping_b_u(&mut self, s: &[u8], min: i32, max: i32, repeat: bool) -> i32 {
        loop {
            let Some((ch, w)) = get_b_utf8(&self.p, self.c, self.lb) else {
                return -1;
            };
            if in_set(s, min, max, ch) {
                return w;
            }
            self.c -= w;
            if !repeat {
                return 0;
            }
        }
    }

    /// `find_among`: longest-match search forwards from `c`. Returns the `result` or 0.
    fn find_among(&mut self, v: &[Among]) -> i32 {
        let mut i = 0i32;
        let mut j = v.len() as i32;
        let c = self.c;
        let l = self.l;
        let mut common_i = 0i32;
        let mut common_j = 0i32;
        let mut first_key_inspected = false;
        loop {
            let k = i + ((j - i) >> 1);
            let mut diff = 0i32;
            let mut common = common_i.min(common_j);
            let w = &v[k as usize];
            let mut i2 = common;
            while (i2 as usize) < w.s.len() {
                if c + common == l {
                    diff = -1;
                    break;
                }
                diff = i32::from(self.at(c + common)) - i32::from(w.s[i2 as usize]);
                if diff != 0 {
                    break;
                }
                common += 1;
                i2 += 1;
            }
            if diff < 0 {
                j = k;
                common_j = common;
            } else {
                i = k;
                common_i = common;
            }
            if j - i <= 1 {
                if i > 0 || j == i || first_key_inspected {
                    break;
                }
                first_key_inspected = true;
            }
        }
        loop {
            let w = &v[i as usize];
            if common_i >= w.s.len() as i32 {
                self.c = c + w.s.len() as i32;
                return w.result;
            }
            i = w.substring_i;
            if i < 0 {
                return 0;
            }
        }
    }

    /// `find_among_b`: longest-match search backwards from `c`. Returns the `result` or 0.
    fn find_among_b(&mut self, v: &[Among]) -> i32 {
        let mut i = 0i32;
        let mut j = v.len() as i32;
        let c = self.c;
        let lb = self.lb;
        let mut common_i = 0i32;
        let mut common_j = 0i32;
        let mut first_key_inspected = false;
        loop {
            let k = i + ((j - i) >> 1);
            let mut diff = 0i32;
            let mut common = common_i.min(common_j);
            let w = &v[k as usize];
            let mut i2 = w.s.len() as i32 - 1 - common;
            while i2 >= 0 {
                if c - common == lb {
                    diff = -1;
                    break;
                }
                diff = i32::from(self.at(c - 1 - common)) - i32::from(w.s[i2 as usize]);
                if diff != 0 {
                    break;
                }
                common += 1;
                i2 -= 1;
            }
            if diff < 0 {
                j = k;
                common_j = common;
            } else {
                i = k;
                common_i = common;
            }
            if j - i <= 1 {
                if i > 0 || j == i || first_key_inspected {
                    break;
                }
                first_key_inspected = true;
            }
        }
        loop {
            let w = &v[i as usize];
            if common_i >= w.s.len() as i32 {
                self.c = c - w.s.len() as i32;
                return w.result;
            }
            i = w.substring_i;
            if i < 0 {
                return 0;
            }
        }
    }

    /// `replace_s`: replace `[c_bra, c_ket)` with `s`, fixing `l` and `c`. Returns the adjustment.
    fn replace_s(&mut self, c_bra: i32, c_ket: i32, s: &[u8]) -> i32 {
        let adjustment = s.len() as i32 - (c_ket - c_bra);
        self.p
            .splice(c_bra as usize..c_ket as usize, s.iter().copied());
        if adjustment != 0 {
            self.l += adjustment;
            if self.c >= c_ket {
                self.c += adjustment;
            } else if self.c > c_bra {
                self.c = c_bra;
            }
        }
        adjustment
    }

    fn slice_check(&self) -> bool {
        self.bra < 0 || self.bra > self.ket || self.ket > self.l || self.l > self.p.len() as i32
    }

    /// `slice_from_s`: -1 on a faulty slice, else 0.
    fn slice_from_s(&mut self, s: &[u8]) -> i32 {
        if self.slice_check() {
            return -1;
        }
        self.replace_s(self.bra, self.ket, s);
        0
    }

    fn slice_del(&mut self) -> i32 {
        self.slice_from_s(b"")
    }

    fn r_prelude(&mut self) -> i32 {
        self.i[2] = 0;
        {
            let c1 = self.c;
            self.bra = self.c;
            if self.c < self.l && self.at(self.c) == b'\'' {
                self.c += 1;
                self.ket = self.c;
                let ret = self.slice_del();
                if ret < 0 {
                    return ret;
                }
            }
            self.c = c1;
        }
        {
            let c2 = self.c;
            self.bra = self.c;
            if self.c < self.l && self.at(self.c) == b'y' {
                self.c += 1;
                self.ket = self.c;
                let ret = self.slice_from_s(b"Y");
                if ret < 0 {
                    return ret;
                }
                self.i[2] = 1;
            }
            self.c = c2;
        }
        {
            let c3 = self.c;
            loop {
                let c4 = self.c;
                let mut ran_out = false;
                loop {
                    let c5 = self.c;
                    if self.in_grouping_u(G_V, 97, 121, false) == 0 {
                        self.bra = self.c;
                        if self.c < self.l && self.at(self.c) == b'y' {
                            self.c += 1;
                            self.ket = self.c;
                            self.c = c5;
                            break;
                        }
                    }
                    self.c = c5;
                    match skip_utf8(&self.p, self.c, self.l, 1) {
                        Some(next) => self.c = next,
                        None => {
                            ran_out = true;
                            break;
                        }
                    }
                }
                if ran_out {
                    self.c = c4;
                    break;
                }
                let ret = self.slice_from_s(b"Y");
                if ret < 0 {
                    return ret;
                }
                self.i[2] = 1;
            }
            self.c = c3;
        }
        1
    }

    fn r_mark_regions(&mut self) -> i32 {
        self.i[1] = self.l;
        self.i[0] = self.l;
        let c1 = self.c;
        'lab0: {
            let c2 = self.c;
            let hit_exception = self.c + 4 < self.l
                && self.at(self.c + 4) >> 5 == 3
                && (2_375_680u32 >> (self.at(self.c + 4) & 0x1f)) & 1 != 0
                && self.find_among(A_0) != 0;
            if !hit_exception {
                self.c = c2;
                let ret = self.out_grouping_u(G_V, 97, 121, true);
                if ret < 0 {
                    break 'lab0;
                }
                self.c += ret;
                let ret = self.in_grouping_u(G_V, 97, 121, true);
                if ret < 0 {
                    break 'lab0;
                }
                self.c += ret;
            }
            self.i[1] = self.c;
            let ret = self.out_grouping_u(G_V, 97, 121, true);
            if ret < 0 {
                break 'lab0;
            }
            self.c += ret;
            let ret = self.in_grouping_u(G_V, 97, 121, true);
            if ret < 0 {
                break 'lab0;
            }
            self.c += ret;
            self.i[0] = self.c;
        }
        self.c = c1;
        1
    }

    fn r_shortv(&mut self) -> i32 {
        let m1 = self.l - self.c;
        'lab1: {
            if self.out_grouping_b_u(G_V_WXY, 89, 121, false) != 0 {
                break 'lab1;
            }
            if self.in_grouping_b_u(G_V, 97, 121, false) != 0 {
                break 'lab1;
            }
            if self.out_grouping_b_u(G_V, 97, 121, false) != 0 {
                break 'lab1;
            }
            return 1;
        }
        self.c = self.l - m1;
        if self.out_grouping_b_u(G_V, 97, 121, false) != 0 {
            return 0;
        }
        if self.in_grouping_b_u(G_V, 97, 121, false) != 0 {
            return 0;
        }
        if self.c > self.lb {
            return 0;
        }
        1
    }

    fn r_r1(&self) -> i32 {
        i32::from(self.i[1] <= self.c)
    }

    fn r_r2(&self) -> i32 {
        i32::from(self.i[0] <= self.c)
    }

    fn r_step_1a(&mut self) -> i32 {
        {
            let m1 = self.l - self.c;
            self.ket = self.c;
            let has_suffix = !(self.c <= self.lb
                || (self.at(self.c - 1) != 39 && self.at(self.c - 1) != 115))
                && self.find_among_b(A_1) != 0;
            if has_suffix {
                self.bra = self.c;
                let ret = self.slice_del();
                if ret < 0 {
                    return ret;
                }
            } else {
                self.c = self.l - m1;
            }
        }
        self.ket = self.c;
        if self.c <= self.lb || (self.at(self.c - 1) != 100 && self.at(self.c - 1) != 115) {
            return 0;
        }
        let among_var = self.find_among_b(A_2);
        if among_var == 0 {
            return 0;
        }
        self.bra = self.c;
        match among_var {
            1 => {
                let ret = self.slice_from_s(b"ss");
                if ret < 0 {
                    return ret;
                }
            }
            2 => {
                let m2 = self.l - self.c;
                match skip_b_utf8(&self.p, self.c, self.lb, 2) {
                    Some(next) => {
                        self.c = next;
                        let ret = self.slice_from_s(b"i");
                        if ret < 0 {
                            return ret;
                        }
                    }
                    None => {
                        self.c = self.l - m2;
                        let ret = self.slice_from_s(b"ie");
                        if ret < 0 {
                            return ret;
                        }
                    }
                }
            }
            3 => {
                match skip_b_utf8(&self.p, self.c, self.lb, 1) {
                    Some(next) => self.c = next,
                    None => return 0,
                }
                let ret = self.out_grouping_b_u(G_V, 97, 121, true);
                if ret < 0 {
                    return 0;
                }
                self.c -= ret;
                let ret = self.slice_del();
                if ret < 0 {
                    return ret;
                }
            }
            _ => {}
        }
        1
    }

    fn r_step_1b(&mut self) -> i32 {
        self.ket = self.c;
        if self.c - 1 <= self.lb
            || self.at(self.c - 1) >> 5 != 3
            || (33_554_576u32 >> (self.at(self.c - 1) & 0x1f)) & 1 == 0
        {
            return 0;
        }
        let among_var = self.find_among_b(A_4);
        if among_var == 0 {
            return 0;
        }
        self.bra = self.c;
        match among_var {
            1 => {
                let ret = self.r_r1();
                if ret <= 0 {
                    return ret;
                }
                let ret = self.slice_from_s(b"ee");
                if ret < 0 {
                    return ret;
                }
            }
            2 => {
                {
                    let m_test1 = self.l - self.c;
                    let ret = self.out_grouping_b_u(G_V, 97, 121, true);
                    if ret < 0 {
                        return 0;
                    }
                    self.c -= ret;
                    self.c = self.l - m_test1;
                }
                let ret = self.slice_del();
                if ret < 0 {
                    return ret;
                }
                self.ket = self.c;
                self.bra = self.c;
                {
                    let m_test2 = self.l - self.c;
                    let among_var = if self.c - 1 <= self.lb
                        || self.at(self.c - 1) >> 5 != 3
                        || (68_514_004u32 >> (self.at(self.c - 1) & 0x1f)) & 1 == 0
                    {
                        3
                    } else {
                        self.find_among_b(A_3)
                    };
                    match among_var {
                        1 => {
                            let ret = self.slice_from_s(b"e");
                            if ret < 0 {
                                return ret;
                            }
                            return 0;
                        }
                        2 => {
                            let m3 = self.l - self.c;
                            if self.in_grouping_b_u(G_AEO, 97, 111, false) == 0 && self.c <= self.lb
                            {
                                return 0;
                            }
                            self.c = self.l - m3;
                        }
                        3 => {
                            if self.c != self.i[1] {
                                return 0;
                            }
                            {
                                let m_test4 = self.l - self.c;
                                let ret = self.r_shortv();
                                if ret <= 0 {
                                    return ret;
                                }
                                self.c = self.l - m_test4;
                            }
                            let ret = self.slice_from_s(b"e");
                            if ret < 0 {
                                return ret;
                            }
                            return 0;
                        }
                        _ => {}
                    }
                    self.c = self.l - m_test2;
                }
                self.ket = self.c;
                match skip_b_utf8(&self.p, self.c, self.lb, 1) {
                    Some(next) => self.c = next,
                    None => return 0,
                }
                self.bra = self.c;
                let ret = self.slice_del();
                if ret < 0 {
                    return ret;
                }
            }
            _ => {}
        }
        1
    }

    fn r_step_1c(&mut self) -> i32 {
        self.ket = self.c;
        let m1 = self.l - self.c;
        if self.c <= self.lb || self.at(self.c - 1) != b'y' {
            self.c = self.l - m1;
            if self.c <= self.lb || self.at(self.c - 1) != b'Y' {
                return 0;
            }
            self.c -= 1;
        } else {
            self.c -= 1;
        }
        self.bra = self.c;
        if self.out_grouping_b_u(G_V, 97, 121, false) != 0 {
            return 0;
        }
        if self.c <= self.lb {
            return 0;
        }
        let ret = self.slice_from_s(b"i");
        if ret < 0 {
            return ret;
        }
        1
    }

    fn r_step_2(&mut self) -> i32 {
        self.ket = self.c;
        if self.c - 1 <= self.lb
            || self.at(self.c - 1) >> 5 != 3
            || (815_616u32 >> (self.at(self.c - 1) & 0x1f)) & 1 == 0
        {
            return 0;
        }
        let among_var = self.find_among_b(A_5);
        if among_var == 0 {
            return 0;
        }
        self.bra = self.c;
        let ret = self.r_r1();
        if ret <= 0 {
            return ret;
        }
        let replacement: &[u8] = match among_var {
            1 => b"tion",
            2 => b"ence",
            3 => b"ance",
            4 => b"able",
            5 => b"ent",
            6 => b"ize",
            7 => b"ate",
            8 => b"al",
            9 => b"ful",
            10 => b"ous",
            11 => b"ive",
            12 => b"ble",
            13 => {
                if self.c <= self.lb || self.at(self.c - 1) != b'l' {
                    return 0;
                }
                self.c -= 1;
                b"og"
            }
            14 => b"less",
            15 => {
                if self.in_grouping_b_u(G_VALID_LI, 99, 116, false) != 0 {
                    return 0;
                }
                b""
            }
            _ => return 1,
        };
        let ret = self.slice_from_s(replacement);
        if ret < 0 {
            return ret;
        }
        1
    }

    fn r_step_3(&mut self) -> i32 {
        self.ket = self.c;
        if self.c - 2 <= self.lb
            || self.at(self.c - 1) >> 5 != 3
            || (528_928u32 >> (self.at(self.c - 1) & 0x1f)) & 1 == 0
        {
            return 0;
        }
        let among_var = self.find_among_b(A_6);
        if among_var == 0 {
            return 0;
        }
        self.bra = self.c;
        let ret = self.r_r1();
        if ret <= 0 {
            return ret;
        }
        let replacement: &[u8] = match among_var {
            1 => b"tion",
            2 => b"ate",
            3 => b"al",
            4 => b"ic",
            5 => b"",
            6 => {
                let ret = self.r_r2();
                if ret <= 0 {
                    return ret;
                }
                b""
            }
            _ => return 1,
        };
        let ret = self.slice_from_s(replacement);
        if ret < 0 {
            return ret;
        }
        1
    }

    fn r_step_4(&mut self) -> i32 {
        self.ket = self.c;
        if self.c - 1 <= self.lb
            || self.at(self.c - 1) >> 5 != 3
            || (1_864_232u32 >> (self.at(self.c - 1) & 0x1f)) & 1 == 0
        {
            return 0;
        }
        let among_var = self.find_among_b(A_7);
        if among_var == 0 {
            return 0;
        }
        self.bra = self.c;
        let ret = self.r_r2();
        if ret <= 0 {
            return ret;
        }
        match among_var {
            1 => {
                let ret = self.slice_del();
                if ret < 0 {
                    return ret;
                }
            }
            2 => {
                let m1 = self.l - self.c;
                if self.c <= self.lb || self.at(self.c - 1) != b's' {
                    self.c = self.l - m1;
                    if self.c <= self.lb || self.at(self.c - 1) != b't' {
                        return 0;
                    }
                }
                self.c -= 1;
                let ret = self.slice_del();
                if ret < 0 {
                    return ret;
                }
            }
            _ => {}
        }
        1
    }

    fn r_step_5(&mut self) -> i32 {
        self.ket = self.c;
        if self.c <= self.lb || (self.at(self.c - 1) != 101 && self.at(self.c - 1) != 108) {
            return 0;
        }
        let among_var = self.find_among_b(A_8);
        if among_var == 0 {
            return 0;
        }
        self.bra = self.c;
        match among_var {
            1 => {
                let ret = self.r_r2();
                if ret < 0 {
                    return ret;
                }
                if ret == 0 {
                    let ret = self.r_r1();
                    if ret <= 0 {
                        return ret;
                    }
                    let m1 = self.l - self.c;
                    let ret = self.r_shortv();
                    if ret < 0 {
                        return ret;
                    }
                    if ret != 0 {
                        return 0;
                    }
                    self.c = self.l - m1;
                }
                let ret = self.slice_del();
                if ret < 0 {
                    return ret;
                }
            }
            2 => {
                let ret = self.r_r2();
                if ret <= 0 {
                    return ret;
                }
                if self.c <= self.lb || self.at(self.c - 1) != b'l' {
                    return 0;
                }
                self.c -= 1;
                let ret = self.slice_del();
                if ret < 0 {
                    return ret;
                }
            }
            _ => {}
        }
        1
    }

    fn r_exception2(&mut self) -> i32 {
        self.ket = self.c;
        if self.c - 5 <= self.lb || (self.at(self.c - 1) != 100 && self.at(self.c - 1) != 103) {
            return 0;
        }
        if self.find_among_b(A_9) == 0 {
            return 0;
        }
        self.bra = self.c;
        if self.c > self.lb {
            return 0;
        }
        1
    }

    fn r_exception1(&mut self) -> i32 {
        self.bra = self.c;
        if self.c + 2 >= self.l
            || self.at(self.c + 2) >> 5 != 3
            || (42_750_482u32 >> (self.at(self.c + 2) & 0x1f)) & 1 == 0
        {
            return 0;
        }
        let among_var = self.find_among(A_10);
        if among_var == 0 {
            return 0;
        }
        self.ket = self.c;
        if self.c < self.l {
            return 0;
        }
        let replacement: &[u8] = match among_var {
            1 => b"ski",
            2 => b"sky",
            3 => b"die",
            4 => b"lie",
            5 => b"tie",
            6 => b"idl",
            7 => b"gentl",
            8 => b"ugli",
            9 => b"earli",
            10 => b"onli",
            11 => b"singl",
            _ => return 1,
        };
        let ret = self.slice_from_s(replacement);
        if ret < 0 {
            return ret;
        }
        1
    }

    fn r_postlude(&mut self) -> i32 {
        if self.i[2] == 0 {
            return 0;
        }
        loop {
            let c1 = self.c;
            let mut ran_out = false;
            loop {
                let c2 = self.c;
                self.bra = self.c;
                if self.c < self.l && self.at(self.c) == b'Y' {
                    self.c += 1;
                    self.ket = self.c;
                    self.c = c2;
                    break;
                }
                self.c = c2;
                match skip_utf8(&self.p, self.c, self.l, 1) {
                    Some(next) => self.c = next,
                    None => {
                        ran_out = true;
                        break;
                    }
                }
            }
            if ran_out {
                self.c = c1;
                break;
            }
            let ret = self.slice_from_s(b"y");
            if ret < 0 {
                return ret;
            }
        }
        1
    }

    /// `english_UTF_8_stem`.
    fn stem(&mut self) -> i32 {
        let c1 = self.c;
        let ret = self.r_exception1();
        if ret < 0 {
            return ret;
        }
        if ret != 0 {
            return 1;
        }
        self.c = c1;
        // Words shorter than three characters are left alone.
        if skip_utf8(&self.p, self.c, self.l, 3).is_none() {
            self.c = c1;
            return 1;
        }
        self.c = c1;
        let ret = self.r_prelude();
        if ret < 0 {
            return ret;
        }
        let ret = self.r_mark_regions();
        if ret < 0 {
            return ret;
        }
        self.lb = self.c;
        self.c = self.l;
        {
            let m3 = self.l - self.c;
            let ret = self.r_step_1a();
            if ret < 0 {
                return ret;
            }
            self.c = self.l - m3;
        }
        let m4 = self.l - self.c;
        let ret = self.r_exception2();
        if ret < 0 {
            return ret;
        }
        if ret == 0 {
            self.c = self.l - m4;
            macro_rules! step {
                ($method:ident) => {{
                    let m = self.l - self.c;
                    let ret = self.$method();
                    if ret < 0 {
                        return ret;
                    }
                    self.c = self.l - m;
                }};
            }
            step!(r_step_1b);
            step!(r_step_1c);
            step!(r_step_2);
            step!(r_step_3);
            step!(r_step_4);
            step!(r_step_5);
        }
        self.c = self.lb;
        {
            let c11 = self.c;
            let ret = self.r_postlude();
            if ret < 0 {
                return ret;
            }
            self.c = c11;
        }
        1
    }
}

#[rustfmt::skip]
const A_0: &[Among] = &[
    Among {
        s: b"arsen",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"commun",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"gener",
        substring_i: -1,
        result: -1,
    },
];

#[rustfmt::skip]
const A_1: &[Among] = &[
    Among {
        s: b"'",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"'s'",
        substring_i: 0,
        result: 1,
    },
    Among {
        s: b"'s",
        substring_i: -1,
        result: 1,
    },
];

#[rustfmt::skip]
const A_2: &[Among] = &[
    Among {
        s: b"ied",
        substring_i: -1,
        result: 2,
    },
    Among {
        s: b"s",
        substring_i: -1,
        result: 3,
    },
    Among {
        s: b"ies",
        substring_i: 1,
        result: 2,
    },
    Among {
        s: b"sses",
        substring_i: 1,
        result: 1,
    },
    Among {
        s: b"ss",
        substring_i: 1,
        result: -1,
    },
    Among {
        s: b"us",
        substring_i: 1,
        result: -1,
    },
];

#[rustfmt::skip]
const A_3: &[Among] = &[
    Among {
        s: b"",
        substring_i: -1,
        result: 3,
    },
    Among {
        s: b"bb",
        substring_i: 0,
        result: 2,
    },
    Among {
        s: b"dd",
        substring_i: 0,
        result: 2,
    },
    Among {
        s: b"ff",
        substring_i: 0,
        result: 2,
    },
    Among {
        s: b"gg",
        substring_i: 0,
        result: 2,
    },
    Among {
        s: b"bl",
        substring_i: 0,
        result: 1,
    },
    Among {
        s: b"mm",
        substring_i: 0,
        result: 2,
    },
    Among {
        s: b"nn",
        substring_i: 0,
        result: 2,
    },
    Among {
        s: b"pp",
        substring_i: 0,
        result: 2,
    },
    Among {
        s: b"rr",
        substring_i: 0,
        result: 2,
    },
    Among {
        s: b"at",
        substring_i: 0,
        result: 1,
    },
    Among {
        s: b"tt",
        substring_i: 0,
        result: 2,
    },
    Among {
        s: b"iz",
        substring_i: 0,
        result: 1,
    },
];

#[rustfmt::skip]
const A_4: &[Among] = &[
    Among {
        s: b"ed",
        substring_i: -1,
        result: 2,
    },
    Among {
        s: b"eed",
        substring_i: 0,
        result: 1,
    },
    Among {
        s: b"ing",
        substring_i: -1,
        result: 2,
    },
    Among {
        s: b"edly",
        substring_i: -1,
        result: 2,
    },
    Among {
        s: b"eedly",
        substring_i: 3,
        result: 1,
    },
    Among {
        s: b"ingly",
        substring_i: -1,
        result: 2,
    },
];

#[rustfmt::skip]
const A_5: &[Among] = &[
    Among {
        s: b"anci",
        substring_i: -1,
        result: 3,
    },
    Among {
        s: b"enci",
        substring_i: -1,
        result: 2,
    },
    Among {
        s: b"ogi",
        substring_i: -1,
        result: 13,
    },
    Among {
        s: b"li",
        substring_i: -1,
        result: 15,
    },
    Among {
        s: b"bli",
        substring_i: 3,
        result: 12,
    },
    Among {
        s: b"abli",
        substring_i: 4,
        result: 4,
    },
    Among {
        s: b"alli",
        substring_i: 3,
        result: 8,
    },
    Among {
        s: b"fulli",
        substring_i: 3,
        result: 9,
    },
    Among {
        s: b"lessli",
        substring_i: 3,
        result: 14,
    },
    Among {
        s: b"ousli",
        substring_i: 3,
        result: 10,
    },
    Among {
        s: b"entli",
        substring_i: 3,
        result: 5,
    },
    Among {
        s: b"aliti",
        substring_i: -1,
        result: 8,
    },
    Among {
        s: b"biliti",
        substring_i: -1,
        result: 12,
    },
    Among {
        s: b"iviti",
        substring_i: -1,
        result: 11,
    },
    Among {
        s: b"tional",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ational",
        substring_i: 14,
        result: 7,
    },
    Among {
        s: b"alism",
        substring_i: -1,
        result: 8,
    },
    Among {
        s: b"ation",
        substring_i: -1,
        result: 7,
    },
    Among {
        s: b"ization",
        substring_i: 17,
        result: 6,
    },
    Among {
        s: b"izer",
        substring_i: -1,
        result: 6,
    },
    Among {
        s: b"ator",
        substring_i: -1,
        result: 7,
    },
    Among {
        s: b"iveness",
        substring_i: -1,
        result: 11,
    },
    Among {
        s: b"fulness",
        substring_i: -1,
        result: 9,
    },
    Among {
        s: b"ousness",
        substring_i: -1,
        result: 10,
    },
];

#[rustfmt::skip]
const A_6: &[Among] = &[
    Among {
        s: b"icate",
        substring_i: -1,
        result: 4,
    },
    Among {
        s: b"ative",
        substring_i: -1,
        result: 6,
    },
    Among {
        s: b"alize",
        substring_i: -1,
        result: 3,
    },
    Among {
        s: b"iciti",
        substring_i: -1,
        result: 4,
    },
    Among {
        s: b"ical",
        substring_i: -1,
        result: 4,
    },
    Among {
        s: b"tional",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ational",
        substring_i: 5,
        result: 2,
    },
    Among {
        s: b"ful",
        substring_i: -1,
        result: 5,
    },
    Among {
        s: b"ness",
        substring_i: -1,
        result: 5,
    },
];

#[rustfmt::skip]
const A_7: &[Among] = &[
    Among {
        s: b"ic",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ance",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ence",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"able",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ible",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ate",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ive",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ize",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"iti",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"al",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ism",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ion",
        substring_i: -1,
        result: 2,
    },
    Among {
        s: b"er",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ous",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ant",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ent",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"ment",
        substring_i: 15,
        result: 1,
    },
    Among {
        s: b"ement",
        substring_i: 16,
        result: 1,
    },
];

#[rustfmt::skip]
const A_8: &[Among] = &[
    Among {
        s: b"e",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"l",
        substring_i: -1,
        result: 2,
    },
];

#[rustfmt::skip]
const A_9: &[Among] = &[
    Among {
        s: b"succeed",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"proceed",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"exceed",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"canning",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"inning",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"earring",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"herring",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"outing",
        substring_i: -1,
        result: -1,
    },
];

#[rustfmt::skip]
const A_10: &[Among] = &[
    Among {
        s: b"andes",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"atlas",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"bias",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"cosmos",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"dying",
        substring_i: -1,
        result: 3,
    },
    Among {
        s: b"early",
        substring_i: -1,
        result: 9,
    },
    Among {
        s: b"gently",
        substring_i: -1,
        result: 7,
    },
    Among {
        s: b"howe",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"idly",
        substring_i: -1,
        result: 6,
    },
    Among {
        s: b"lying",
        substring_i: -1,
        result: 4,
    },
    Among {
        s: b"news",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"only",
        substring_i: -1,
        result: 10,
    },
    Among {
        s: b"singly",
        substring_i: -1,
        result: 11,
    },
    Among {
        s: b"skies",
        substring_i: -1,
        result: 2,
    },
    Among {
        s: b"skis",
        substring_i: -1,
        result: 1,
    },
    Among {
        s: b"sky",
        substring_i: -1,
        result: -1,
    },
    Among {
        s: b"tying",
        substring_i: -1,
        result: 5,
    },
    Among {
        s: b"ugly",
        substring_i: -1,
        result: 8,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    /// `ts_lexize('english_stem', word)` from PostgreSQL 18 (PGLite) for each word: vocabulary of
    /// Snowball's English stemmer, case variants, apostrophes, non-ASCII, long words and fuzz.
    const GOLDEN: &str = include_str!("../../tests/fixtures/english_stem.tsv");

    #[test]
    fn matches_postgres_for_every_golden_row() {
        let mut rows = 0;
        let mut mismatches = Vec::new();
        for line in GOLDEN.lines() {
            let (word, expected) = line.split_once('\t').expect("word<TAB>lexeme");
            let expected = (expected != "<stop>").then(|| expected.to_string());
            let got = english_stem(word);
            if got != expected {
                let shown: String = word.chars().take(40).collect();
                mismatches.push(format!("{shown:?}: got {got:?}, postgres {expected:?}"));
            }
            rows += 1;
        }
        assert!(rows >= 30_000, "fixture too small: {rows} rows");
        assert!(
            mismatches.is_empty(),
            "{} of {rows} rows differ, first: {:?}",
            mismatches.len(),
            &mismatches[..mismatches.len().min(10)]
        );
    }

    #[test]
    fn stopwords_yield_no_lexeme() {
        for word in ENGLISH_STOPWORDS {
            assert!(is_english_stopword(word), "{word}");
            assert_eq!(english_stem(word), None, "{word}");
            assert_eq!(english_stem(&word.to_uppercase()), None, "{word}");
        }
        assert!(!is_english_stopword("The"));
        assert!(!is_english_stopword("running"));
        assert_eq!(english_stem(""), None);
    }

    #[test]
    fn stems_common_words_like_postgres() {
        let cases = [
            ("running", "run"),
            ("Generously", "generous"),
            ("commune", "commune"),
            ("don't", "don't"),
            ("O'Neil's", "o'neil"),
            ("yellow", "yellow"),
            ("skies", "sky"),
            ("CAFÉ", "café"),
            ("naïve", "naïv"),
            ("Straße", "straße"),
            ("'", "'"),
        ];
        for (word, lexeme) in cases {
            assert_eq!(english_stem(word).as_deref(), Some(lexeme), "{word}");
        }
    }

    #[test]
    fn long_words_are_lowercased_but_not_stemmed() {
        let long = "RUNNING".repeat(143);
        assert_eq!(long.len(), 1001);
        assert_eq!(english_stem(&long), Some(long.to_lowercase()));
        let short = "RUNNING".repeat(142);
        assert_eq!(
            english_stem(&short),
            Some(format!("{}run", "running".repeat(141)))
        );
    }

    #[test]
    fn lowercase_follows_libc_not_newer_unicode() {
        assert_eq!(pg_lower("İSTANBUL"), "istanbul");
        assert_eq!(pg_lower("ΣΑΣ"), "σασ");
        assert_eq!(pg_lower("Ⓐ"), "Ⓐ");
        assert_eq!(pg_lower("\u{A7C0}"), "\u{A7C0}");
    }
}
