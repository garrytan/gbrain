---
important: security
---
**An agent can upload a file that sits in a folder whose name starts with two dots, such as `..drafts/report.pdf`, inside the working directory.**

### Fixed
- `file_upload` over MCP refused a file under a folder like `..drafts/` or `.../` in the working directory with "Upload path must be within the working directory", because the confinement check matched any path whose first name starts with `..`. The check now compares whole path parts on the resolved paths, so only a path that resolves outside the working directory (through `..`, a sibling folder that shares the working directory's name, or a symlinked parent), a symlinked file and the working directory itself are refused. Local CLI uploads were never affected.
- On Windows, an upload path on another drive or a network (UNC) share is now refused for remote callers. The old check accepted it. This is shown with Node's `path.win32`, not on a Windows machine.
