#!/usr/bin/env python3
import os
import re
from pathlib import Path

# Paths
ARTICLES_DIR = Path("/root/brain/sources/articles")

# Define target keywords to match in academic papers and map them to standard wiki-links
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

def auto_link_file(file_path):
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Split frontmatter from body to avoid matching inside YAML
    parts = content.split("---", 2)
    if len(parts) < 3:
        body = content
        fm = ""
    else:
        fm = f"---{parts[1]}---"
        body = parts[2]

    links_created = 0
    # Process replacements only once per pattern to avoid cluttering
    for pattern, link in LINK_MAP.items():
        # Compile case-insensitive pattern
        regex = re.compile(pattern, re.IGNORECASE)
        # Check if matched and if it is not already inside a wiki-link [[]]
        if regex.search(body):
            # Safe replacement: replace raw occurrence if not already preceded by [[ or followed by ]] or |
            def replace_fn(match):
                start, end = match.span()
                # Check surrounding to see if already linked
                left = body[max(0, start-10):start]
                right = body[end:end+10]
                if "[[" in left or "]]" in right or "|" in right or "|" in left:
                    return match.group(0) # already linked
                return link

            body, count = regex.subn(replace_fn, body, count=1) # max 1 link per pattern per file
            links_created += count

    if links_created > 0:
        new_content = fm + body if fm else body
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        print(f"Linked {links_created} terms in {file_path.name}")
        return True
    return False

def main():
    print("Running automatic sessional linking...")
    if not ARTICLES_DIR.exists():
        print(f"Directory {ARTICLES_DIR} does not exist.")
        return

    count = 0
    for file in ARTICLES_DIR.glob("*.md"):
        if auto_link_file(file):
            count += 1
    print(f"Finished linking. Updated {count} files.")

if __name__ == "__main__":
    main()
