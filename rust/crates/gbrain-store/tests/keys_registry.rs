//! The key tag registry: every one-byte tag in `src/keys.rs` is unique, every sub-tag is unique
//! within its family, and the tag tables of docs/designs/RUST_ENGINE_INTERFACES.md ("Key layout",
//! "Reserved tags" and the telemetry sub-tags) name the same bytes as `keys.rs`. Two families once
//! took the same byte in separate branches and only the merge showed it; this fails at the commit.

use std::collections::BTreeMap;

const KEYS_RS: &str = include_str!("../src/keys.rs");
const REGISTRY: &str = include_str!("../../../../docs/designs/RUST_ENGINE_INTERFACES.md");

/// A `pub const NAME: u8 = b'x';` (a tag) or `= 0xNN;` (a sub-tag) line of `keys.rs`.
fn constants(src: &str) -> Vec<(String, u8, bool)> {
    let mut out = Vec::new();
    for line in src.lines() {
        let Some(rest) = line.trim().strip_prefix("pub const ") else {
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
