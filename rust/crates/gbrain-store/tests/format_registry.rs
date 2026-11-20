//! The store format registry (`rust/docs/store/format.md`) and the code agree, so two branches
//! cannot ship one format number: the second claim fails here or collides in the table.

use gbrain_store::{FORMAT_VERSION, FORMAT_VERSIONS};

const REGISTRY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/store/format.md"
));

struct Row {
    format: u32,
    status: String,
    branch: String,
}

/// The rows of the registry table: the table whose header starts `| Format | Status |`.
fn rows() -> Vec<Row> {
    let mut lines = REGISTRY
        .lines()
        .skip_while(|line| !line.starts_with("| Format | Status |"));
    let header: Vec<String> = cells(lines.next().expect("format.md has no registry table"));
    let col = |name: &str| {
        header
            .iter()
            .position(|cell| cell == name)
            .unwrap_or_else(|| panic!("the registry table has no {name:?} column"))
    };
    let (format, status, branch) = (col("Format"), col("Status"), col("Branch and commit"));
    let separator = lines
        .next()
        .expect("the registry table has no separator row");
    assert!(
        separator.starts_with("|---"),
        "the registry header is not followed by |---|"
    );
    lines
        .take_while(|line| line.starts_with('|'))
        .map(|line| {
            let cells = cells(line);
            assert_eq!(
                cells.len(),
                header.len(),
                "registry row has the wrong column count: {line}"
            );
            Row {
                format: cells[format]
                    .parse()
                    .unwrap_or_else(|_| panic!("registry format is not a number: {line}")),
                status: cells[status].clone(),
                branch: cells[branch].clone(),
            }
        })
        .collect()
}

fn cells(line: &str) -> Vec<String> {
    line.trim()
        .trim_matches('|')
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect()
}

#[test]
fn the_registry_numbers_every_format_once_in_order() {
    let rows = rows();
    assert!(!rows.is_empty(), "the registry table is empty");
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(
            row.format,
            i as u32 + 1,
            "format numbers must be unique and run 1, 2, 3, … with no gap"
        );
        assert!(
            row.status == "shipped" || row.status == "reserved",
            "format {} has status {:?}; use shipped or reserved",
            row.format,
            row.status
        );
        assert!(
            !row.branch.is_empty(),
            "format {} names no branch",
            row.format
        );
    }
}

#[test]
fn format_version_is_the_last_shipped_row() {
    let rows = rows();
    let shipped: Vec<u32> = rows
        .iter()
        .filter(|row| row.status == "shipped")
        .map(|row| row.format)
        .collect();
    assert_eq!(
        shipped.last(),
        Some(&FORMAT_VERSION),
        "FORMAT_VERSION is {FORMAT_VERSION}; add or mark its row shipped in rust/docs/store/format.md"
    );
    assert_eq!(
        shipped, FORMAT_VERSIONS,
        "the shipped rows must be exactly FORMAT_VERSIONS"
    );
    for row in rows.iter().filter(|row| row.status == "reserved") {
        assert!(
            row.format > FORMAT_VERSION,
            "format {} is reserved but this build already ships format {FORMAT_VERSION}",
            row.format
        );
    }
}
