//! Prototype, measure only: a Rust port of the mention scanner `findMentionedEntities`
//! (`src/core/by-mention.ts`). Not wired into gbrain; nothing calls it outside the bench.
//!
//! The scanner works on UTF-16 code units, the way JavaScript strings index, so every offset
//! it returns is the offset TypeScript would return. It takes text that `stripCodeBlocks` has
//! already processed (same length as the original, code replaced by spaces), exactly as
//! `findMentionedEntities` does internally.
//!
//! Output is a flat list of `(page index, entry index, offset)` triples; the caller maps the
//! entry index back to its gazetteer entry to build the `Mention` object.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};
use unicode_general_category::{GeneralCategory as Gc, get_general_category};
use unicode_normalization::UnicodeNormalization;

/// FxHash: the gazetteer lookups hash short lowercase tokens, where SipHash dominates.
#[derive(Default)]
pub struct Fx(u64);
impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
}
type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;

#[derive(Deserialize, Debug, Clone)]
pub struct EntryIn {
    pub slug: String,
    pub source_id: String,
    pub title: String,
    pub tokens: Vec<String>,
    #[serde(default, rename = "caseTokens")]
    pub case_tokens: Option<Vec<String>>,
    #[serde(default, rename = "matchText")]
    pub match_text: Option<String>,
    #[serde(default, rename = "anySpacing")]
    pub any_spacing: Option<bool>,
    #[serde(default)]
    pub shared: Option<bool>,
    #[serde(default)]
    pub connector_stub: Option<bool>,
    #[serde(default, rename = "atOnly")]
    pub at_only: Option<bool>,
}

struct Entry {
    slug: String,
    source_id: String,
    tokens: Vec<String>,
    case_tokens: Option<Vec<String>>,
    at_only: bool,
    shared: bool,
    connector_stub: bool,
    all_hangul: bool,
    all_katakana: bool,
    /// `(matchText ?? tokens.join('')).trim()` with whitespace runs collapsed (Hangul check).
    hangul_expected: Vec<u16>,
    hangul_space: Option<u16>,
    /// `tokens.join('')` as UTF-16 (Katakana check).
    joined: Vec<u16>,
    /// `tokens.join(' ')` (ignore-list key).
    ignore_key: String,
}

pub struct Scanner {
    entries: Vec<Entry>,
    buckets: FxMap<String, Vec<u32>>,
}

const HANGUL_TITLES: &str = "씨 님 오빠 언니 누나 선배 후배 선생님 선생 교수 대표 사장 회장 팀장 부장 과장 이사 의원 기자 작가 감독 측";
const HANGUL_PARTICLES: &str = "이 가 은 는 을 를 의 에 에게 에게서 한테 한테서 께 께서 와 과 랑 이랑 도 만 로 으로 로서 으로서 로부터 으로부터 에서 부터 까지 처럼 보다 마저 조차 뿐 밖에 이나 이든 이라도 라도 이여 이며 이고 이다 입니다 이에요 예요 이었다 였다 이었던 였던 이라는 라는 이라고 라고 이란 이야 야 아";

fn is_cjk(cp: u32) -> bool {
    (0x4E00..=0x9FFF).contains(&cp)
        || (0x3040..=0x309F).contains(&cp)
        || (0x30A0..=0x30FF).contains(&cp)
        || (0xAC00..=0xD7AF).contains(&cp)
}
fn is_hangul_syllable(cp: u32) -> bool {
    (0xAC00..=0xD7A3).contains(&cp)
}
/// `\s` / `String.prototype.trim` whitespace in JavaScript.
fn is_js_space(u: u16) -> bool {
    matches!(u, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}
/// Script=Katakana (Unicode 16 Scripts.txt).
fn is_katakana_script(cp: u32) -> bool {
    matches!(cp, 0x30A1..=0x30FA | 0x30FD..=0x30FF | 0x31F0..=0x31FF | 0x32D0..=0x32FE | 0x3300..=0x3357
        | 0xFF66..=0xFF6F | 0xFF71..=0xFF9D | 0x1AFF0..=0x1AFF3 | 0x1AFF5..=0x1AFFB | 0x1AFFD..=0x1AFFE
        | 0x1B000 | 0x1B120..=0x1B122 | 0x1B155 | 0x1B164..=0x1B167)
}
fn is_katakana_run(cp: u32) -> bool {
    is_katakana_script(cp)
        || cp == 0x30FC
        || (0x3099..=0x309C).contains(&cp)
        || cp == 0xFF70
        || cp == 0xFF9E
        || cp == 0xFF9F
}
fn category(cp: u32) -> Option<Gc> {
    char::from_u32(cp).map(get_general_category)
}
fn is_letter(cp: u32) -> bool {
    if cp < 0x80 {
        return (cp as u8).is_ascii_alphabetic();
    }
    matches!(
        category(cp),
        Some(
            Gc::UppercaseLetter
                | Gc::LowercaseLetter
                | Gc::TitlecaseLetter
                | Gc::ModifierLetter
                | Gc::OtherLetter
        )
    )
}
fn is_mark(cp: u32) -> bool {
    if cp < 0x80 {
        return false;
    }
    matches!(
        category(cp),
        Some(Gc::NonspacingMark | Gc::SpacingMark | Gc::EnclosingMark)
    )
}
/// JavaScript `codePointAt`: a surrogate pair is one code point, a lone surrogate is itself.
#[inline]
fn cp_at(s: &[u16], i: usize) -> (u32, usize) {
    let u = s[i] as u32;
    if (0xD800..0xDC00).contains(&u) && i + 1 < s.len() {
        let l = s[i + 1] as u32;
        if (0xDC00..0xE000).contains(&l) {
            return (0x10000 + ((u - 0xD800) << 10) + (l - 0xDC00), 2);
        }
    }
    (u, 1)
}
fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn collapse_ws(s: &[u16], space: Option<u16>) -> Vec<u16> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if is_js_space(s[i]) {
            while i < s.len() && is_js_space(s[i]) {
                i += 1;
            }
            if let Some(sp) = space {
                out.push(sp);
            }
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    out
}
fn js_trim(s: &[u16]) -> &[u16] {
    let mut a = 0;
    let mut b = s.len();
    while a < b && is_js_space(s[a]) {
        a += 1;
    }
    while b > a && is_js_space(s[b - 1]) {
        b -= 1;
    }
    &s[a..b]
}
fn single_cp(t: &str) -> Option<u32> {
    let mut it = t.chars();
    let c = it.next()?;
    if it.next().is_some() {
        None
    } else {
        Some(c as u32)
    }
}

pub struct Tok {
    pub start: u32,
    pub len: u32,
    ns: u32,
    ne: u32,
}

/// `tokenizeForScan`: word runs (`(?![CJK])[\p{L}0-9](?:(?![CJK])[\p{L}\p{M}0-9])*`) and single
/// CJK characters, in text order, each normalized with NFC then lowercased into `arena`.
pub fn tokenize(text: &[u16], arena: &mut String, out: &mut Vec<Tok>) {
    let n = text.len();
    let mut i = 0;
    let mut buf = String::new();
    while i < n {
        let (cp, l) = cp_at(text, i);
        if is_cjk(cp) {
            let ns = arena.len() as u32;
            push_norm(&text[i..i + l], arena, &mut buf);
            out.push(Tok {
                start: i as u32,
                len: l as u32,
                ns,
                ne: arena.len() as u32,
            });
            i += l;
            continue;
        }
        if is_letter(cp) || (0x30..=0x39).contains(&cp) {
            let start = i;
            i += l;
            while i < n {
                let (c, cl) = cp_at(text, i);
                if is_cjk(c) || !(is_letter(c) || is_mark(c) || (0x30..=0x39).contains(&c)) {
                    break;
                }
                i += cl;
            }
            let ns = arena.len() as u32;
            push_norm(&text[start..i], arena, &mut buf);
            out.push(Tok {
                start: start as u32,
                len: (i - start) as u32,
                ns,
                ne: arena.len() as u32,
            });
            continue;
        }
        // JavaScript's walker steps one code unit at a time outside tokens.
        i += 1;
    }
}
fn push_norm(units: &[u16], arena: &mut String, buf: &mut String) {
    if units.iter().all(|&u| u < 0x80) {
        arena.extend(
            units
                .iter()
                .map(|&u| (u as u8).to_ascii_lowercase() as char),
        );
        return;
    }
    buf.clear();
    buf.extend(
        char::decode_utf16(units.iter().copied())
            .map(|r| r.unwrap_or('\u{FFFD}'))
            .nfc(),
    );
    for c in buf.to_lowercase().chars() {
        arena.push(c);
    }
}
fn nfc_of(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|r| r.unwrap_or('\u{FFFD}'))
        .nfc()
        .collect()
}

fn suffix_ok(s: &[u16], titles: &[Vec<u16>], particles: &[Vec<u16>]) -> bool {
    fn particles_ok(s: &[u16], pos: usize, n: usize, particles: &[Vec<u16>]) -> bool {
        if pos >= s.len() || !is_hangul_syllable(s[pos] as u32) {
            return true;
        }
        if n == 2 {
            return false;
        }
        particles
            .iter()
            .any(|p| s[pos..].starts_with(p) && particles_ok(s, pos + p.len(), n + 1, particles))
    }
    titles
        .iter()
        .any(|t| s.starts_with(t) && particles_ok(s, t.len(), 0, particles))
        || particles_ok(s, 0, 0, particles)
}

pub struct ScanPage<'a> {
    pub text: &'a [u16],
    pub from_source: &'a str,
    pub from_slug: &'a str,
    pub ignored: Option<&'a HashSet<String>>,
}

impl Scanner {
    /// Build from the TypeScript gazetteer serialized as `JSON.stringify([...gazetteer])`.
    pub fn from_json(json: &str) -> Result<Scanner, serde_json::Error> {
        let raw: Vec<(String, Vec<EntryIn>)> = serde_json::from_str(json)?;
        let mut entries = Vec::new();
        let mut buckets: FxMap<String, Vec<u32>> = FxMap::default();
        for (key, bucket) in raw {
            let ids = buckets.entry(key).or_default();
            for e in bucket {
                ids.push(entries.len() as u32);
                entries.push(Self::prepare(e));
            }
        }
        Ok(Scanner { entries, buckets })
    }
    /// Entries in the order `[...gazetteer].flatMap(([, b]) => b)` lists them.
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    fn prepare(e: EntryIn) -> Entry {
        let all_hangul = e
            .tokens
            .iter()
            .all(|t| !t.is_empty() && t.chars().all(|c| is_hangul_syllable(c as u32)));
        let all_katakana = e
            .tokens
            .iter()
            .all(|t| single_cp(t).is_some_and(|c| is_katakana_script(c) || c == 0x30FC));
        let space = if e.any_spacing.unwrap_or(false) {
            None
        } else {
            Some(0x20)
        };
        let expected_src = utf16(&e.match_text.clone().unwrap_or_else(|| e.tokens.concat()));
        Entry {
            hangul_expected: collapse_ws(js_trim(&expected_src), space),
            hangul_space: space,
            joined: utf16(&e.tokens.concat()),
            ignore_key: e.tokens.join(" "),
            all_hangul,
            all_katakana,
            at_only: e.at_only.unwrap_or(false),
            shared: e.shared.unwrap_or(false),
            connector_stub: e.connector_stub.unwrap_or(false),
            slug: e.slug,
            source_id: e.source_id,
            tokens: e.tokens,
            case_tokens: e.case_tokens,
        }
    }

    /// `findMentionedEntities` over one already-stripped text. Appends `(entry, offset)` pairs.
    pub fn scan(
        &self,
        page: &ScanPage,
        allow_cross: bool,
        scratch: &mut Scratch,
        out: &mut Vec<(u32, u32)>,
    ) {
        let text = page.text;
        scratch.arena.clear();
        scratch.toks.clear();
        scratch.seen.clear();
        tokenize(text, &mut scratch.arena, &mut scratch.toks);
        let toks = &scratch.toks;
        let arena = &scratch.arena;
        if toks.is_empty() || self.entries.is_empty() {
            return;
        }
        let tok_text = |k: usize| &arena[toks[k].ns as usize..toks[k].ne as usize];
        let hangul_ok = |e: &Entry, at: usize| -> bool {
            if !e.all_hangul {
                return true;
            }
            let first = &toks[at];
            let fo = first.start as usize;
            if fo > 0 && is_hangul_syllable(text[fo - 1] as u32) {
                return false;
            }
            let last = &toks[at + e.tokens.len() - 1];
            let end = (last.start + last.len) as usize;
            if collapse_ws(&text[fo..end], e.hangul_space) != e.hangul_expected {
                return false;
            }
            suffix_ok(
                &text[end..(end + 12).min(text.len())],
                &scratch.titles,
                &scratch.particles,
            )
        };
        let katakana_ok = |e: &Entry, at: usize| -> bool {
            if !e.all_katakana {
                return true;
            }
            let fo = toks[at].start as usize;
            let last = &toks[at + e.tokens.len() - 1];
            let end = (last.start + last.len) as usize;
            if text[fo..end] != e.joined[..] {
                return false;
            }
            let before = &text[fo.saturating_sub(2)..fo];
            if !before.is_empty() {
                let k = before.len() - 1;
                let lu = before[k] as u32;
                let cp = if k == 1
                    && (0xDC00..0xE000).contains(&lu)
                    && (0xD800..0xDC00).contains(&(before[0] as u32))
                {
                    cp_at(before, 0).0
                } else {
                    lu
                };
                if is_katakana_run(cp) {
                    return false;
                }
            }
            let after = &text[end..(end + 2).min(text.len())];
            !(!after.is_empty() && is_katakana_run(cp_at(after, 0).0))
        };
        let case_ok = |e: &Entry, at: usize| -> bool {
            match &e.case_tokens {
                None => true,
                Some(ct) => ct.iter().enumerate().all(|(k, t)| {
                    let tk = &toks[at + k];
                    nfc_of(&text[tk.start as usize..(tk.start + tk.len) as usize]) == *t
                }),
            }
        };
        let at_ok = |e: &Entry, at: usize| -> bool {
            !e.at_only || {
                let o = toks[at].start as usize;
                o > 0 && text[o - 1] == b'@' as u16
            }
        };
        let same_tokens =
            |a: &Entry, b: &Entry| a.tokens.len() == b.tokens.len() && a.tokens == b.tokens;
        let same_name = |e: &Entry, want: &Entry, at: usize| {
            same_tokens(e, want)
                && case_ok(e, at)
                && at_ok(e, at)
                && hangul_ok(e, at)
                && katakana_ok(e, at)
        };

        let seen = &mut scratch.seen;
        let mut i = 0;
        while i < toks.len() {
            let Some(bucket) = self.buckets.get(tok_text(i)) else {
                i += 1;
                continue;
            };
            let mut matched: Option<u32> = None;
            for &id in bucket {
                let e = &self.entries[id as usize];
                if i + e.tokens.len() > toks.len() {
                    continue;
                }
                if !(1..e.tokens.len()).all(|k| tok_text(i + k) == e.tokens[k]) {
                    continue;
                }
                if !hangul_ok(e, i) || !katakana_ok(e, i) || !case_ok(e, i) || !at_ok(e, i) {
                    continue;
                }
                matched = Some(id);
                break;
            }
            let Some(mut m) = matched else {
                i += 1;
                continue;
            };
            let n_tok = self.entries[m as usize].tokens.len();
            if self.entries[m as usize].source_id != page.from_source {
                let want = &self.entries[m as usize];
                if let Some(&own) = bucket.iter().find(|&&id| {
                    let e = &self.entries[id as usize];
                    e.source_id == page.from_source && same_name(e, want, i)
                }) {
                    m = own;
                }
            }
            if allow_cross && self.entries[m as usize].connector_stub {
                let stub = &self.entries[m as usize];
                let canonical: Vec<u32> = bucket
                    .iter()
                    .copied()
                    .filter(|&id| {
                        let e = &self.entries[id as usize];
                        !e.connector_stub && e.source_id != stub.source_id && same_name(e, stub, i)
                    })
                    .collect();
                let pick = if canonical.len() == 1 {
                    Some(canonical[0])
                } else {
                    canonical
                        .iter()
                        .copied()
                        .find(|&id| self.entries[id as usize].slug == stub.slug)
                };
                if let Some(p) = pick {
                    let ps = &self.entries[p as usize].slug;
                    if canonical
                        .iter()
                        .filter(|&&id| &self.entries[id as usize].slug == ps)
                        .count()
                        == 1
                    {
                        m = p;
                    }
                }
            }
            let me = &self.entries[m as usize];
            if let Some(ig) = page.ignored
                && !ig.is_empty()
                && ig.contains(&me.ignore_key)
            {
                i += n_tok;
                continue;
            }
            if me.source_id == page.from_source && me.slug == page.from_slug {
                i += n_tok;
                continue;
            }
            if !allow_cross && me.source_id != page.from_source {
                i += n_tok;
                continue;
            }
            if seen.contains(&(me.source_id.as_str(), me.slug.as_str()).key()) {
                i += n_tok;
                continue;
            }
            let group: Vec<u32> = if me.shared {
                bucket
                    .iter()
                    .copied()
                    .filter(|&id| {
                        let e = &self.entries[id as usize];
                        e.shared
                            && e.source_id == me.source_id
                            && same_tokens(e, me)
                            && case_ok(e, i)
                            && at_ok(e, i)
                    })
                    .collect()
            } else {
                vec![m]
            };
            if group.len() > 1
                && group.iter().any(|&id| {
                    let e = &self.entries[id as usize];
                    e.source_id == page.from_source && e.slug == page.from_slug
                })
            {
                i += n_tok;
                continue;
            }
            for id in group {
                let e = &self.entries[id as usize];
                if seen.insert((e.source_id.as_str(), e.slug.as_str()).key()) {
                    out.push((id, toks[i].start));
                }
            }
            i += n_tok;
        }
    }
}

trait Key {
    fn key(&self) -> String;
}
impl Key for (&str, &str) {
    fn key(&self) -> String {
        let mut s = String::with_capacity(self.0.len() + self.1.len() + 1);
        s.push_str(self.0);
        s.push('\0');
        s.push_str(self.1);
        s
    }
}

/// Reusable buffers, one per scanning thread.
pub struct Scratch {
    arena: String,
    toks: Vec<Tok>,
    seen: HashSet<String>,
    titles: Vec<Vec<u16>>,
    particles: Vec<Vec<u16>>,
}
impl Default for Scratch {
    fn default() -> Self {
        Scratch {
            arena: String::new(),
            toks: Vec::new(),
            seen: HashSet::new(),
            titles: HANGUL_TITLES.split(' ').map(utf16).collect(),
            particles: HANGUL_PARTICLES.split(' ').map(utf16).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokenizes_like_typescript() {
        let mut a = String::new();
        let mut t = Vec::new();
        let s = utf16("Nguyễn met 王伟 at Acme's");
        tokenize(&s, &mut a, &mut t);
        let words: Vec<&str> = t.iter().map(|k| &a[k.ns as usize..k.ne as usize]).collect();
        assert_eq!(words, ["nguyễn", "met", "王", "伟", "at", "acme", "s"]);
    }
    #[test]
    fn hangul_suffix() {
        let s = Scratch::default();
        assert!(suffix_ok(&utf16("씨는 오늘"), &s.titles, &s.particles));
        assert!(!suffix_ok(&utf16("하는"), &s.titles, &s.particles));
        assert!(suffix_ok(&utf16(""), &s.titles, &s.particles));
    }
}
