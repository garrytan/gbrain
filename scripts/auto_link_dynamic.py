#!/usr/bin/env python3
import os
import re
from pathlib import Path

# Paths
BRAIN_DIR = Path("/root/brain")
SOURCES_DIR = BRAIN_DIR / "sources"

# Hardcoded baselines from auto_link.py to preserve historical mappings
LINK_MAP = {
    r"\bwarren\s+farrell\b": "[[sources/the-myth-of-male-power|Warren Farrell]]",
    r"\bmyth\s+of\s+male\s+power\b": "[[sources/the-myth-of-male-power|The Myth of Male Power]]",
    r"\bsecond\s+sexism\b": "[[sources/the-second-sexism-discrimination-against-men-and-boys|The Second Sexism]]",
    r"\bbenatar\b": "[[sources/the-second-sexism-discrimination-against-men-and-boys|Benatar]]",
    r"\bmisandry\b": "[[sources/spreading-misandry-the-teaching-of-contempt-for-men|misandry]]",
    r"\blegalizing\s+misandry\b": "[[sources/legalizing-misandry-from-public-shame-to-systemic-discrimination|Legalizing Misandry]]",
    r"\bspreading\s+misandry\b": "[[sources/spreading-misandry-the-teaching-of-contempt-for-men|Spreading Misandry]]",
    r"\bcynical\s+theories\b": "[[sources/cynical-theories|Cynical Theories]]",
    r"\blookism\b": "[[sources/looks-why-they-matter-more-than-you-ever-imagined|lookism]]",
    r"\bbeauty\s+bias\b": "[[sources/the-beauty-bias-the-injustice-of-appearance-in-life-and-law|beauty bias]]",
    r"\bgender\s+symmetry\b": "[[sources/the-second-sexism-discrimination-against-men-and-boys|gender symmetry]]",
    r"\bsymmetry\b": "[[sources/the-second-sexism-discrimination-against-men-and-boys|symmetry]]",
    r"\bfeminism\b": "[[sources/who-stole-feminism-how-women-have-betrayed-women|feminism]]",
    r"\bbeauty\b": "[[sources/survival-of-the-prettiest-the-science-of-beauty|beauty]]",
    r"\bphysical\s+appearance\b": "[[sources/looks-why-they-matter-more-than-you-ever-imagined|physical appearance]]",
    r"\blooks\b": "[[sources/looks-why-they-matter-more-than-you-ever-imagined|looks]]",
    r"\bfalse\s+allegations\b": "[[sources/legalizing-misandry-from-public-shame-to-systemic-discrimination|false allegations]]"
}

def parse_frontmatter(content):
    lines = content.split('\n')
    fm_lines = []
    in_fm = False
    start_idx = -1
    end_idx = -1
    for i, line in enumerate(lines):
        if line.startswith('---'):
            if not in_fm:
                in_fm = True
                start_idx = i
            else:
                end_idx = i
                break
        elif in_fm:
            fm_lines.append(line)

    if start_idx != -1 and end_idx != -1:
        fm_text = '\n'.join(fm_lines)
        body_text = '\n'.join(lines[end_idx+1:])
        metadata = {}
        for l in fm_lines:
            l = l.strip()
            if not l or l.startswith('#'):
                continue
            if ':' in l:
                parts = l.split(':', 1)
                k = parts[0].strip()
                v = parts[1].strip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                if v.startswith('[') and v.endswith(']'):
                    items = []
                    for item in v[1:-1].split(','):
                        item = item.strip()
                        if (item.startswith('"') and item.endswith('"')) or (item.startswith("'") and item.endswith("'")):
                            item = item[1:-1]
                        if item:
                            items.append(item)
                    metadata[k] = items
                else:
                    metadata[k] = v
        return metadata, body_text
    return {}, content

def build_dynamic_link_map():
    dynamic_map = {}

    # Walk over all markdown files in brain
    all_mds = list(BRAIN_DIR.glob("**/*.md"))
    print(f"Scanning {len(all_mds)} files to build dynamic link map...")

    for file_path in all_mds:
        # Skip node_modules, .git, etc.
        rel_parts = file_path.relative_to(BRAIN_DIR).parts
        if "node_modules" in rel_parts or "exports" in rel_parts or any(p.startswith('.') for p in rel_parts):
            continue
        if file_path.name.startswith('_') or file_path.name == 'README.md':
            continue

        slug = str(file_path.relative_to(BRAIN_DIR).with_suffix(''))

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception:
            continue

        meta, body = parse_frontmatter(content)
        title = meta.get("title", file_path.stem)

        # Clean title for exact mapping
        # E.g. "The Myth of Male Power" -> map to slug
        # Only map titles that are longer than 5 chars to avoid noise
        if title and len(title) > 5:
            # Clean special chars in title for regex
            clean_title = re.sub(r'[^\w\s-]', '', title).strip()
            # Replace whitespace with \s+ pattern
            title_pat = r'\b' + re.sub(r'\s+', r'\\s+', re.escape(clean_title)) + r'\b'
            dynamic_map[title_pat] = f"[[{slug}|{title}]]"

        # Get author/authors
        authors = []
        if "author" in meta:
            author_val = meta["author"]
            if isinstance(author_val, list):
                authors.extend(author_val)
            elif isinstance(author_val, str):
                authors.append(author_val)
        elif "authors" in meta:
            authors_val = meta["authors"]
            if isinstance(authors_val, list):
                authors.extend(authors_val)
            elif isinstance(authors_val, str):
                authors.append(authors_val)

        year = meta.get("year")

        if authors:
            # 1. Map full author names
            for author in authors:
                if len(author) > 3:
                    author_pat = r'\b' + re.sub(r'\s+', r'\\s+', re.escape(author)) + r'\b'
                    dynamic_map[author_pat] = f"[[{slug}|{author}]]"

            # 2. Map citations if it is an academic paper (year present)
            if year:
                year_str = str(year).strip()
                # Determine lead author last name
                lead_author = authors[0].split()[-1] # Usually last name

                if len(lead_author) > 2:
                    # Lead author last name only
                    if len(authors) == 1:
                        # Single author citation
                        pat = r'\b' + re.escape(lead_author) + r'\s*\,?\s*\(?' + re.escape(year_str) + r'\)?\b'
                        dynamic_map[pat] = f"[[{slug}|{lead_author} ({year_str})]]"
                    elif len(authors) == 2:
                        # Two authors citation
                        second_author = authors[1].split()[-1]
                        pat1 = r'\b' + re.escape(lead_author) + r'\s*(?:and|&)\s*' + re.escape(second_author) + r'\s*\,?\s*\(?' + re.escape(year_str) + r'\)?\b'
                        dynamic_map[pat1] = f"[[{slug}|{lead_author} & {second_author} ({year_str})]]"
                        # Fallback to lead et al if cited loosely
                        pat2 = r'\b' + re.escape(lead_author) + r'\s+et\s+al\.?\s*\,?\s*\(?' + re.escape(year_str) + r'\)?\b'
                        dynamic_map[pat2] = f"[[{slug}|{lead_author} et al. ({year_str})]]"
                        # Just last name + year
                        pat3 = r'\b' + re.escape(lead_author) + r'\s*\,?\s*\(?' + re.escape(year_str) + r'\)?\b'
                        dynamic_map[pat3] = f"[[{slug}|{lead_author} ({year_str})]]"
                    else:
                        # Multiple authors citation
                        pat1 = r'\b' + re.escape(lead_author) + r'\s+et\s+al\.?\s*\,?\s*\(?' + re.escape(year_str) + r'\)?\b'
                        dynamic_map[pat1] = f"[[{slug}|{lead_author} et al. ({year_str})]]"
                        # Just last name + year
                        pat2 = r'\b' + re.escape(lead_author) + r'\s*\,?\s*\(?' + re.escape(year_str) + r'\)?\b'
                        dynamic_map[pat2] = f"[[{slug}|{lead_author} et al. ({year_str})]]"

    return dynamic_map

def auto_link_file(file_path, link_map):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return False

    # Try to safely isolate frontmatter
    fm_match = re.match(r"^---.*?\n(.*?\n)---", content, re.DOTALL)
    if fm_match:
        fm_end = fm_match.end()
        fm = content[:fm_end]
        body = content[fm_end:]
    else:
        if content.startswith('---'):
            parts = content.split('---', 2)
            if len(parts) >= 3:
                fm = f"---{parts[1]}---"
                body = parts[2]
            else:
                fm = ""
                body = content
        else:
            fm = ""
            body = content

    links_created = 0
    sorted_patterns = sorted(link_map.keys(), key=lambda x: len(x), reverse=True)
    current_slug = str(file_path.relative_to(BRAIN_DIR).with_suffix(''))

    for pattern in sorted_patterns:
        link = link_map[pattern]

        # Avoid self-linking
        target_slug_match = re.match(r"^\[\[([^|\]]+)", link)
        if target_slug_match:
            target_slug = target_slug_match.group(1).strip()
            if target_slug == current_slug:
                continue

        regex = re.compile(pattern, re.IGNORECASE)
        if regex.search(body):
            def replace_fn(match):
                start, end = match.span()
                # Safe boundary search: check surrounding to see if already linked
                left = body[max(0, start-15):start]
                right = body[end:end+15]
                if "[[" in left or "]]" in right or "|" in right or "|" in left:
                    return match.group(0) # already linked
                return link

            body, count = regex.subn(replace_fn, body, count=1)
            links_created += count

    if links_created > 0:
        new_content = fm + body
        try:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(new_content)
            print(f"Linked {links_created} terms in {file_path.relative_to(BRAIN_DIR)}")
            return True
        except Exception as e:
            print(f"Error writing {file_path}: {e}")
            return False
    return False

def main():
    print("Initializing Dynamic Auto-Linker...")
    dynamic_map = build_dynamic_link_map()

    # Merge maps: let explicit custom mappings override dynamic ones
    merged_map = {}
    merged_map.update(dynamic_map)
    merged_map.update(LINK_MAP)

    print(f"Total compiled dictionary contains {len(merged_map)} active mapping patterns.")

    all_mds = list(BRAIN_DIR.glob("**/*.md"))
    updated_count = 0

    for file_path in all_mds:
        # Skip node_modules, etc.
        rel_parts = file_path.relative_to(BRAIN_DIR).parts
        if "node_modules" in rel_parts or "exports" in rel_parts or any(p.startswith('.') for p in rel_parts):
            continue
        if file_path.name.startswith('_') or file_path.name == 'README.md':
            continue

        if auto_link_file(file_path, merged_map):
            updated_count += 1

    print(f"\nAuto-linking completed. Updated {updated_count} files successfully!")

if __name__ == "__main__":
    main()
