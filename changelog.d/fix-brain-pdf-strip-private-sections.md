---
important: security
---
**PDFs made with the brain-pdf skill no longer include a page's private Timeline or fact rows.**

<!-- behavior-change: brain_pdf_strips_private_sections -->

### Fixed
- The brain-pdf skill removed only a page's frontmatter before rendering, so a PDF made for sharing carried its private Timeline, fact rows and comments. It now strips the page exactly as `gbrain publish` does.
- brain-pdf writes its work files and the PDF in a private temporary directory instead of a fixed `/tmp/<slug>.pdf` path, and a failed render now exits non-zero instead of printing `Rendered:`.
- `gbrain publish` failed in the release binary with `Cannot find module 'marked'`, because it read the browser copy of marked from `node_modules` at runtime. The copy is now built into the binary. (#10019, reported by @ocscdsa)
- Stripping a page with a very long run of spaces, or a long space run before a citation, no longer takes seconds.

### Added
- `gbrain publish --markdown` writes the stripped markdown instead of an HTML page, for other renderers such as brain-pdf.
