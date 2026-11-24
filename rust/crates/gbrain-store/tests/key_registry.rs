//! No two record kinds share a store key prefix.
//!
//! A family is one byte (`keys::FACT`, `F`); each record kind a module writes takes a sub-tag byte
//! after it (`const TAKE_PURGE: u8 = 0x10`). Two kinds on one `(family, sub-tag)` read each other's
//! records: the take purge ledger and the loop mutes both took `F 0x10`, and one mute made the
//! source report a take purge. This test reads the store's source, collects every
//! `(family, sub-tag)` a module declares, and fails when two different declarations share one.
//!
//! What counts as a declaration: a `const NAME: u8 = <number>;` in a file whose code (before its
//! `#[cfg(test)] mod`) writes `keys::FAMILY, NAME` (as in `vec![keys::FACT, NAME]` or
//! `scan_prefix(read, &[keys::FACT, NAME], ...)`); a sub-tag of `keys.rs` itself
//! (`keys::TELEMETRY, keys::TELEMETRY_SEARCH`) counts the same way. A literal sub-tag
//! (`keys::FACT, 0x0C`) is a read of a kind declared elsewhere and is not a declaration. A builder
//! that takes the sub-tag as a parameter (`text_key(BY_SOURCE, ..)` in `facts.rs`), or one that
//! inserts it into a built key, is not seen: write `vec![keys::FAMILY, CONST]` so the kind is
//! registered. The sanity checks below fail if the scan stops seeing the kinds it should.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// One declaration: the file and the const that names the sub-tag.
type Claim = (String, String);

/// Collisions the scan finds that this change does not fix. Each names the family, the sub-tag and
/// why it is allowed; the test fails when an entry stops colliding, so the list only shrinks.
const KNOWN: &[(&str, u8, &str)] = &[(
    "FACT",
    0x0C,
    "not a second kind: `seed/format_5.rs` names the page purge ledger's `0x0C` again to \
         carry the v0.60.766.0 addon's old key shape over to `facts/page_purges.rs`'s.",
)];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            // Test files declare no record kinds.
            if name != "tests.rs" && !name.ends_with("_tests.rs") {
                out.push(path);
            }
        }
    }
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The `u8` constants a source declares, `NAME` to value.
fn u8_consts(code: &str) -> BTreeMap<String, u8> {
    let mut out = BTreeMap::new();
    for line in code.lines() {
        let line = line.trim();
        let Some(at) = line.find("const ") else {
            continue;
        };
        let decl = &line[at + "const ".len()..];
        let Some((name, rest)) = decl.split_once(": u8 = ") else {
            continue;
        };
        // The number ends at the `;`; a trailing comment is ignored.
        let Some((number, _)) = rest.split_once(';') else {
            continue;
        };
        let value = match number.strip_prefix("0x") {
            Some(hex) => u8::from_str_radix(hex, 16),
            None => number.parse(),
        };
        if let (true, Ok(value)) = (name.chars().all(is_ident_char), value) {
            out.insert(name.to_owned(), value);
        }
    }
    out
}

/// The family bytes of `keys.rs` (`pub const FACT: u8 = b'F';`), by name.
fn families(keys_rs: &str) -> BTreeMap<String, u8> {
    let mut out = BTreeMap::new();
    for line in keys_rs.lines() {
        if let Some(rest) = line.strip_prefix("pub const ")
            && let Some((name, value)) = rest.split_once(": u8 = b'")
            && let Some(ch) = value.strip_suffix("';")
            && ch.len() == 1
        {
            out.insert(name.to_owned(), ch.as_bytes()[0]);
        }
    }
    out
}

/// The identifiers `keys::FAMILY, IDENT` names in `code`, as `(FAMILY, IDENT)`; `IDENT` may be
/// `keys::SUB` (the sub-tag constants of `keys.rs`, returned as `SUB` with `keys_sub` true).
fn pairs(code: &str) -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    let mut rest = code;
    while let Some(at) = rest.find("keys::") {
        rest = &rest[at + "keys::".len()..];
        let family: String = rest.chars().take_while(|c| is_ident_char(*c)).collect();
        let after = rest[family.len()..].trim_start();
        let Some(after) = after.strip_prefix(',') else {
            continue;
        };
        let after = after.trim_start();
        let (after, keys_sub) = match after.strip_prefix("keys::") {
            Some(a) => (a, true),
            None => (after, false),
        };
        let ident: String = after.chars().take_while(|c| is_ident_char(*c)).collect();
        if !family.is_empty() && ident.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
            out.push((family, ident, keys_sub));
        }
    }
    out
}

/// Every `(family name, sub-tag)` the store source declares, with its claims.
fn registry() -> BTreeMap<(String, u8), BTreeSet<Claim>> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let keys_rs = fs::read_to_string(src.join("keys.rs")).unwrap();
    let family_bytes = families(&keys_rs);
    let key_subs = u8_consts(&keys_rs);
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut out: BTreeMap<(String, u8), BTreeSet<Claim>> = BTreeMap::new();
    for path in files {
        let text = fs::read_to_string(&path).unwrap();
        let code = text.split("#[cfg(test)]\nmod ").next().unwrap();
        let name = path
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let consts = u8_consts(code);
        for (family, ident, keys_sub) in pairs(code) {
            if !family_bytes.contains_key(&family) {
                continue;
            }
            let (value, file) = if keys_sub {
                (key_subs.get(&ident), "keys.rs".to_owned())
            } else {
                (consts.get(&ident), name.clone())
            };
            if let Some(value) = value {
                out.entry((family, *value))
                    .or_default()
                    .insert((file, ident));
            }
        }
    }
    out
}

fn show(claims: &BTreeSet<Claim>) -> String {
    claims
        .iter()
        .map(|(file, name)| format!("{file}::{name}"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[test]
fn no_two_record_kinds_share_a_family_and_sub_tag() {
    let registry = registry();
    let collisions: BTreeMap<_, _> = registry
        .iter()
        .filter(|(_, claims)| claims.len() > 1)
        .collect();
    let unexpected: Vec<String> = collisions
        .iter()
        .filter(|((family, byte), _)| !KNOWN.iter().any(|(f, b, _)| f == family && b == byte))
        .map(|((family, byte), claims)| format!("keys::{family} {byte:#04x}: {}", show(claims)))
        .collect();
    assert!(
        unexpected.is_empty(),
        "two record kinds share a key prefix (give one a free sub-tag and add a store format \
         upgrade that moves its records):\n{}",
        unexpected.join("\n")
    );
    for (family, byte, why) in KNOWN {
        assert!(
            collisions.contains_key(&(family.to_string(), *byte)),
            "keys::{family} {byte:#04x} no longer collides; remove it from KNOWN ({why})"
        );
    }
}

#[test]
fn the_scan_sees_the_kinds_it_exists_to_tell_apart() {
    let registry = registry();
    let only = |family: &str, byte: u8| -> String {
        let claims = registry.get(&(family.to_owned(), byte)).unwrap_or_else(|| {
            panic!("the scan found no declaration of keys::{family} {byte:#04x}")
        });
        show(claims)
    };
    // The two kinds that once shared `F 0x10`.
    assert_eq!(only("FACT", 0x10), "facts/take_purges.rs::TAKE_PURGE");
    assert_eq!(only("FACT", 0x11), "facts/loops/mutes.rs::SUPPRESSION");
    assert_eq!(only("FACT", 0x0F), "facts/purge_ledger.rs::PURGE");
    assert_eq!(only("FACT", 0x08), "facts/loops.rs::ROW");
    // The two kinds that once shared `x 0x04`.
    assert_eq!(only("ACCESS_MEMBERS", 0x04), "access_member_links.rs::LINK");
    assert_eq!(
        only("ACCESS_MEMBERS", 0x0d),
        "shared_skill_members.rs::STATE"
    );
    assert!(
        registry.len() > 40,
        "the scan found only {} prefixes",
        registry.len()
    );
    // Sub-tags of `keys.rs` are read as declarations too.
    assert_eq!(only("TELEMETRY", 0x01), "keys.rs::TELEMETRY_SEARCH");
}
