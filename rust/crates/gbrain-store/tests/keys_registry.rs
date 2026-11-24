//! The key tag registry: every one-byte tag in `src/keys.rs` is unique, every sub-tag is unique
//! within its family, and the tag tables of docs/designs/RUST_ENGINE_INTERFACES.md ("Key layout",
//! "Reserved tags" and the telemetry sub-tags) name the same bytes as `keys.rs`. Two families once
//! took the same byte in separate branches and only the merge showed it; this fails at the commit.
//! The "Tag registry" table lists the tags claimed on branches and the reserved ones: no row may take
//! a byte another constant or row holds, a digit `4`-`9` needs an approved row, `~` is only the
//! family escape, and every two-byte family tag (`~` then one byte) is unique and listed.

use std::collections::BTreeMap;

const KEYS_RS: &str = include_str!("../src/keys.rs");
const REGISTRY: &str = include_str!("../../../../docs/designs/RUST_ENGINE_INTERFACES.md");

/// A `pub const NAME: u8 = b'x';` (a tag) or `= 0xNN;` (a sub-tag) line of `keys.rs`.
fn constants(src: &str) -> Vec<(String, u8, bool)> {
    let mut out = Vec::new();
    for line in src.lines() {
        // Any visibility (`pub`, `pub(crate)`, none): a tag is a tag wherever it is declared.
        let Some((_, rest)) = line.trim().split_once("const ") else {
            continue;
        };
        let Some((name, value)) = rest.split_once(": u8 = ") else {
            continue;
        };
        let value = value.split(';').next().unwrap_or("").trim();
        let tag = value.strip_prefix("b'").and_then(|v| v.strip_suffix('\''));
        let sub = value
            .strip_prefix("0x")
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (tag.map(str::as_bytes), sub) {
            (Some([b]), _) => out.push((name.to_string(), *b, true)),
            (None, Some(b)) => out.push((name.to_string(), b, false)),
            _ => {}
        }
    }
    out
}

/// Every `const NAME: [u8; 2] = family_tag(...)` declaration of `keys.rs` (any visibility, any trailing comment): a
/// two-byte family tag by its family byte, or `None` when the argument is not one printable byte literal `b'x'`
/// (which includes `b'\0'`), so no declaration is skipped unseen.
fn family_constants(src: &str) -> Vec<(String, Option<u8>)> {
    src.lines()
        .filter_map(|line| {
            let (_, rest) = line.trim().split_once("const ")?;
            let (name, value) = rest.split_once(": [u8; 2] = family_tag(")?;
            // Read the literal before the closing delimiter, so a family byte of `)` is not cut short. An escape
            // (`b'\0'`, `b'\''`) or any other argument is unreadable and reported.
            let byte = match value.strip_prefix("b'").map(str::as_bytes) {
                Some([b, b'\'', b')', ..]) if b.is_ascii_graphic() && *b != b'\\' => Some(*b),
                _ => None,
            };
            Some((name.trim().to_string(), byte))
        })
        .collect()
}

/// The escape byte that starts every two-byte family tag (`keys::FAMILY_ESCAPE`).
const ESCAPE: u8 = b'~';

/// The backticked words of one markdown table cell.
fn ticked(cell: &str) -> Vec<&str> {
    cell.split('`').skip(1).step_by(2).collect()
}

/// The data rows of the first markdown table after `heading`, as trimmed cells.
fn table<'a>(doc: &'a str, heading: &str) -> Vec<Vec<&'a str>> {
    let Some(start) = doc.find(heading) else {
        return Vec::new();
    };
    doc[start..]
        .lines()
        .skip_while(|l| !l.starts_with('|'))
        .take_while(|l| l.starts_with('|'))
        .skip(2)
        .map(|l| l.trim_matches('|').split('|').map(str::trim).collect())
        .collect()
}

/// Every problem with the tags of `keys_src` and the tables of `doc`; empty when they agree.
fn problems(keys_src: &str, doc: &str) -> Vec<String> {
    let mut out = Vec::new();
    let consts = constants(keys_src);
    let mut tags: BTreeMap<u8, Vec<&str>> = BTreeMap::new();
    let mut subs: BTreeMap<(String, u8), Vec<&str>> = BTreeMap::new();
    for (name, byte, is_tag) in &consts {
        if *is_tag {
            tags.entry(*byte).or_default().push(name);
        } else {
            let family = name.split('_').next().unwrap_or("").to_string();
            subs.entry((family, *byte)).or_default().push(name);
        }
    }
    for (byte, names) in &tags {
        if *byte == 0 {
            out.push(format!(
                "tag 0x00 belongs to the storage adapter: {names:?}"
            ));
        }
        if names.len() > 1 {
            out.push(format!("tag {:?} is taken by {names:?}", *byte as char));
        }
    }
    for ((family, byte), names) in &subs {
        if names.len() > 1 {
            out.push(format!(
                "{family} sub-tag 0x{byte:02X} is taken by {names:?}"
            ));
        }
    }
    let by_name: BTreeMap<&str, u8> = consts.iter().map(|(n, b, _)| (n.as_str(), *b)).collect();
    let mut documented: Vec<u8> = Vec::new();
    for row in table(doc, "### Key layout") {
        for tag in ticked(row[0]) {
            documented.extend(tag.bytes().take(1));
        }
    }
    for row in table(doc, "Reserved tags:") {
        let (Some(tag), Some(name)) = (
            ticked(row[1]).first().copied(),
            ticked(row[2]).first().copied(),
        ) else {
            out.push(format!(
                "reserved tag row without a tag and a constant: {row:?}"
            ));
            continue;
        };
        documented.extend(tag.bytes().take(1));
        // A family claimed on a branch is listed before its constant reaches this tree.
        let on_branch = table(doc, "### Tag registry").iter().any(|r| {
            ticked(r[1]).first() == Some(&name) && r.get(3).is_some_and(|s| s.starts_with("branch"))
        });
        if on_branch && !by_name.contains_key(name) {
            continue;
        }
        if by_name.get(name).copied() != tag.bytes().next() {
            out.push(format!(
                "registry says {name} is {tag:?}; keys.rs says {:?}",
                by_name.get(name).map(|b| *b as char)
            ));
        }
    }
    for (byte, names) in &tags {
        if !documented.contains(byte) {
            out.push(format!(
                "tag {:?} ({names:?}) is not in the RUST_ENGINE_INTERFACES.md tag tables",
                *byte as char
            ));
        }
    }
    out.extend(registry_problems(&consts, &family_constants(keys_src), doc));
    let telemetry = table(doc, "| Sub-tag | Constant | Table |");
    let mut listed = Vec::new();
    for row in &telemetry {
        let (Some(hex), Some(name)) = (
            ticked(row[0]).first().copied(),
            ticked(row[1]).first().copied(),
        ) else {
            continue;
        };
        listed.push(name.to_string());
        let byte = hex
            .strip_prefix("0x")
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        if by_name.get(name).copied() != byte {
            out.push(format!("registry says {name} is {hex}; keys.rs disagrees"));
        }
    }
    for (name, _, is_tag) in &consts {
        if !is_tag && name.starts_with("TELEMETRY_") && !listed.contains(name) {
            out.push(format!("{name} is not in the telemetry sub-tag table"));
        }
    }
    out
}

/// The "Tag registry" rule over the one-byte tags and two-byte family tags of `keys.rs`.
fn registry_problems(
    consts: &[(String, u8, bool)],
    families: &[(String, Option<u8>)],
    doc: &str,
) -> Vec<String> {
    let mut out = Vec::new();
    let tags: BTreeMap<&str, u8> = consts
        .iter()
        .filter(|(_, _, is_tag)| *is_tag)
        .map(|(n, b, _)| (n.as_str(), *b))
        .collect();
    for (name, byte) in &tags {
        if *byte == ESCAPE && *name != "FAMILY_ESCAPE" {
            out.push(format!("tag '~' is the family escape and cannot be {name}"));
        }
    }
    let rows = table(doc, "### Tag registry");
    let mut claimed: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for row in &rows {
        let (Some(tag), Some(name), Some(status)) = (
            ticked(row[0]).first().copied(),
            ticked(row[1]).first().copied(),
            row.get(3),
        ) else {
            out.push(format!(
                "tag registry row without a tag, a constant and a status: {row:?}"
            ));
            continue;
        };
        claimed.entry(tag.to_string()).or_default().push(name);
        if let [byte] = tag.as_bytes() {
            if let Some((holder, _)) = tags.iter().find(|(n, b)| *b == byte && *n != &name) {
                out.push(
                    format!("registry claims {tag:?} for {name}, which keys.rs gives {holder}")
                        .replace('"', "'"),
                );
            }
            if (b'4'..=b'9').contains(byte) && !status.starts_with("approved") {
                out.push(format!("digit tag {tag:?} ({name}) is not approved: a digit 4-9 needs an approved row").replace('"', "'"));
            }
        }
    }
    for (tag, names) in &claimed {
        if names.len() > 1 {
            out.push(format!("tag registry gives {tag:?} to {names:?}"));
        }
    }
    for (name, byte) in &tags {
        if (b'4'..=b'9').contains(byte)
            && !rows.iter().any(|r| {
                ticked(r[0]).first().map(|t| t.as_bytes()) == Some(&[*byte][..])
                    && ticked(r[1]).first() == Some(name)
                    && r.get(3).is_some_and(|s| s.starts_with("approved"))
            })
        {
            out.push(format!(
                "digit tag '{}' ({name}) has no approved Tag registry row",
                *byte as char
            ));
        }
    }
    let mut by_family: BTreeMap<u8, Vec<&str>> = BTreeMap::new();
    for (name, byte) in families {
        let Some(byte) = byte else {
            out.push(format!("family tag declaration the guard cannot read: {name} (use family_tag(b'x') with one printable byte)"));
            continue;
        };
        by_family.entry(*byte).or_default().push(name);
        let tag = format!("~{}", *byte as char);
        if !rows.iter().any(|r| {
            ticked(r[0]).first() == Some(&tag.as_str())
                && ticked(r[1]).first() == Some(&name.as_str())
        }) {
            out.push(format!(
                "family tag {tag} ({name}) is not in the Tag registry"
            ));
        }
    }
    for (byte, names) in &by_family {
        if names.len() > 1 {
            out.push(format!(
                "family tag ~{} is taken by {names:?}",
                *byte as char
            ));
        }
    }
    out
}

#[test]
fn keys_rs_tags_are_unique_and_match_the_registry() {
    assert_eq!(problems(KEYS_RS, REGISTRY), Vec::<String>::new());
}

#[test]
fn a_duplicate_tag_an_unlisted_tag_and_a_drifted_row_are_reported() {
    let keys = "pub const ONE: u8 = b'h';\npub const TWO: u8 = b'h';\npub const NEW: u8 = b'2';\n\
        pub const TELEMETRY_A: u8 = 0x01;\npub const TELEMETRY_B: u8 = 0x01;\n";
    let doc = "### Key layout\n\n| Tag | Records | Owner |\n|---|---|---|\n| `h` | x | core |\n\n\
        Reserved tags:\n\n| Family | Tag | Constant | Cascade |\n|---|---|---|---|\n| one | `y` | `ONE` | no |\n\n\
        | Sub-tag | Constant | Table |\n|---|---|---|\n| `0x01` | `TELEMETRY_A` | a |\n";
    let found = problems(keys, doc);
    assert!(
        found
            .iter()
            .any(|p| p.contains("tag 'h' is taken by [\"ONE\", \"TWO\"]")),
        "{found:?}"
    );
    assert!(
        found.iter().any(|p| p.contains("TELEMETRY sub-tag 0x01")),
        "{found:?}"
    );
    assert!(
        found
            .iter()
            .any(|p| p.contains("registry says ONE is \"y\"")),
        "{found:?}"
    );
    assert!(
        found
            .iter()
            .any(|p| p.contains("tag '2' ([\"NEW\"]) is not in")),
        "{found:?}"
    );
    assert!(
        found
            .iter()
            .any(|p| p.contains("TELEMETRY_B is not in the telemetry sub-tag table")),
        "{found:?}"
    );
}

/// The tag registry rule (RUST_ENGINE_INTERFACES.md, "Tag registry"): a tag claimed on a branch may not take a byte
/// another constant holds, a digit `4`-`9` needs an approved row, `~` is only the escape, and two-byte family tags are
/// unique. Each line of this synthetic tree breaks one of them.
#[test]
fn a_branch_claim_on_a_held_byte_an_unapproved_digit_and_a_duplicate_family_tag_are_reported() {
    let keys = "pub const HELD: u8 = b'h';\npub const DIGIT: u8 = b'4';\npub const ODD: u8 = b'~';\n\
        pub const FAMILY_ESCAPE: u8 = b'~';\n\
        pub const FAM_A: [u8; 2] = family_tag(b'a');\npub const FAM_B: [u8; 2] = family_tag(b'a');\n";
    let doc = "### Key layout\n\n| Tag | Records | Owner |\n|---|---|---|\n| `h` | x | core |\n| `4` | x | core |\n\n\
        Reserved tags:\n\n| Family | Tag | Constant | Cascade |\n|---|---|---|---|\n| esc | `~` | `FAMILY_ESCAPE` | no |\n\n\
        ### Tag registry\n\n| Tag | Constant | Owner | Status |\n|---|---|---|---|\n\
        | `h` | `CLAIMED` | lane 9 | branch rust-engine/x |\n| `4` | `DIGIT` | core | requested |\n\
        | `~a` | `FAM_A` | core | main |\n\n\
        | Sub-tag | Constant | Table |\n|---|---|---|\n";
    let found = problems(keys, doc);
    for want in [
        "registry claims 'h' for CLAIMED, which keys.rs gives HELD",
        "digit tag '4' (DIGIT) has no approved Tag registry row",
        "tag '~' is the family escape and cannot be ODD",
        "family tag ~a is taken by [\"FAM_A\", \"FAM_B\"]",
        "family tag ~a (FAM_B) is not in the Tag registry",
    ] {
        assert!(
            found.iter().any(|p| p.contains(want)),
            "missing {want:?} in {found:?}"
        );
    }
}

/// Round-1 review cases: a declaration with a trailing comment or an argument the guard cannot read is never skipped,
/// a digit approval counts only for its own byte, and a duplicate registry row or an unapproved digit row is named.
#[test]
fn a_commented_or_unreadable_family_tag_a_digit_approved_for_another_byte_and_duplicate_rows_are_reported()
 {
    let keys = "pub const FAMILY_ESCAPE: u8 = b'~';\npub const DIGIT: u8 = b'5';\n\
        pub const FAM_A: [u8; 2] = family_tag(b'a'); // first\npub const FAM_B: [u8; 2] = family_tag(b'a'); // second\n\
        pub const FAM_NUL: [u8; 2] = family_tag(b'\\0');\npub(crate) const FAM_C: [u8; 2] = family_tag(NAME);\n";
    let doc = "### Key layout\n\n| Tag | Records | Owner |\n|---|---|---|\n| `5` | x | core |\n\n\
        Reserved tags:\n\n| Family | Tag | Constant | Cascade |\n|---|---|---|---|\n| esc | `~` | `FAMILY_ESCAPE` | no |\n\n\
        ### Tag registry\n\n| Tag | Constant | Owner | Status |\n|---|---|---|---|\n\
        | `4` | `DIGIT` | core | approved |\n| `6` | `OTHER` | core | requested |\n\
        | `~a` | `FAM_A` | core | main |\n| `~a` | `FAM_B` | core | main |\n\n\
        | Sub-tag | Constant | Table |\n|---|---|---|\n";
    let found = problems(keys, doc);
    for want in [
        "family tag ~a is taken by [\"FAM_A\", \"FAM_B\"]",
        "digit tag '5' (DIGIT) has no approved Tag registry row",
        "digit tag '6' (OTHER) is not approved",
        "tag registry gives \"~a\" to [\"FAM_A\", \"FAM_B\"]",
        "family tag declaration the guard cannot read: FAM_NUL",
        "family tag declaration the guard cannot read: FAM_C",
    ] {
        assert!(
            found.iter().any(|p| p.contains(want)),
            "missing {want:?} in {found:?}"
        );
    }
}

/// Round-2 review case: a family byte that is itself `)` is read as a byte literal, not cut at the delimiter, so a
/// registered `family_tag(b')')` passes.
#[test]
fn a_registered_family_tag_whose_byte_is_a_closing_paren_passes() {
    let keys = "pub const FAMILY_ESCAPE: u8 = b'~';\npub const FAM_P: [u8; 2] = family_tag(b')'); // paren\n";
    let doc = "Reserved tags:\n\n| Family | Tag | Constant | Cascade |\n|---|---|---|---|\n| esc | `~` | `FAMILY_ESCAPE` | no |\n\n\
        ### Tag registry\n\n| Tag | Constant | Owner | Status |\n|---|---|---|---|\n| `~)` | `FAM_P` | core | main |\n\n\
        | Sub-tag | Constant | Table |\n|---|---|---|\n";
    assert_eq!(problems(keys, doc), Vec::<String>::new());
}
