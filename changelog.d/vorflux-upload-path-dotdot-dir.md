**An agent can upload a file that sits in a folder whose name starts with two dots, such as `..drafts/report.pdf`, inside the working directory.**

### Fixed
- `file_upload` over MCP refused a file under a folder like `..drafts/` or `.../` in the working directory with "Upload path must be within the working directory", because the confinement check matched any path whose first name starts with `..`. The check now compares whole path parts on the resolved paths, so only a real `..` step, another drive, a sibling folder that shares the working directory's name, a symlinked parent that resolves outside it, a symlinked file and the working directory itself are refused. Local CLI uploads were never affected.
