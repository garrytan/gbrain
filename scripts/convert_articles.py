#!/usr/bin/env python3
import os
import sys
import re
from pathlib import Path

# Set up paths
MISANDRY_DIR = Path("/root/misandry_articles")
BRAIN_SOURCES_DIR = Path("/root/brain/sources/articles")
INDEX_PATH = MISANDRY_DIR / "INDEX.md"

def parse_index_md(index_path):
    articles = []
    if not index_path.exists():
        print(f"Error: {index_path} does not exist.")
        return articles

    with open(index_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    lines = content.splitlines()
    for line in lines:
        line_strip = line.strip()
        if not line_strip.startswith("|") or ".pdf" not in line_strip:
            continue

        # Parse table cells
        cells = [cell.strip() for cell in line_strip.split("|")]
        # Keep non-empty cells
        cells = [c for c in cells if c]
        if len(cells) >= 5:
            filename = cells[0]
            title = cells[1]
            authors_raw = cells[2]
            year_raw = cells[3]
            doi = cells[4]

            # Format year
            try:
                year = int(year_raw)
            except ValueError:
                year = None

            # Format authors list
            authors = [a.strip() for a in re.split(r",|;| et al\.", authors_raw) if a.strip()]

            articles.append({
                "filename": filename,
                "title": title,
                "authors": authors,
                "year": year,
                "doi": doi if doi != "—" else None
            })
    return articles

def convert_pdf_to_md_pdfium(pdf_path, dest_path, metadata):
    try:
        import pypdfium2 as pdfium
    except ImportError as e:
        print(f"Error: pypdfium2 not installed in this environment. {e}")
        return False

    try:
        print(f"Extracting {pdf_path.name} (pdfium)...")
        doc = pdfium.PdfDocument(str(pdf_path))
        text_parts = []
        for page in doc:
            text_page = page.get_textpage()
            text = text_page.get_text_range()
            if text:
                text_parts.append(text)

        md_text = "\n\n".join(text_parts)

        # Build clean frontmatter
        fm_lines = ["---"]
        fm_lines.append(f'title: {repr(metadata["title"])}')
        fm_lines.append(f'authors: {metadata["authors"]}')
        if metadata["year"]:
            fm_lines.append(f'year: {metadata["year"]}')
        if metadata["doi"]:
            fm_lines.append(f'doi: {repr(metadata["doi"])}')
        fm_lines.append('type: "article"')
        fm_lines.append('tags: ["academic", "sociology", "misandry", "victimization"]')
        fm_lines.append("---")

        fm = "\n".join(fm_lines)
        full_content = fm + "\n\n" + md_text

        # Write output
        with open(dest_path, "w", encoding="utf-8") as f:
            f.write(full_content)
        print(f"Successfully saved {pdf_path.stem}.md")
        return True
    except Exception as e:
        print(f"Failed to convert {pdf_path.name}: {e}")
        return False

def main():
    print("Parsing INDEX.md...")
    articles = parse_index_md(INDEX_PATH)
    print(f"Found {len(articles)} academic articles listed.")

    BRAIN_SOURCES_DIR.mkdir(parents=True, exist_ok=True)

    success_count = 0
    skipped_count = 0

    # Process all of them (without OCR they will convert in a few seconds each!)
    for art in articles:
        pdf_file = MISANDRY_DIR / art["filename"]
        dest_file = BRAIN_SOURCES_DIR / f"{pdf_file.stem}.md"

        if not pdf_file.exists():
            print(f"Warning: PDF file {pdf_file.name} does not exist. Skipping.")
            continue

        if dest_file.exists():
            print(f"File {dest_file.name} already exists. Skipping.")
            skipped_count += 1
            continue

        success = convert_pdf_to_md_pdfium(pdf_file, dest_file, art)
        if success:
            success_count += 1

    print(f"\nDone: {success_count} converted, {skipped_count} skipped.")

if __name__ == "__main__":
    main()
