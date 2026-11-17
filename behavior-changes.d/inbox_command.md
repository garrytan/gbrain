---
kind: add
---
New command gbrain inbox: files you drop into ~/.gbrain/inbox/ (from iOS Shortcuts, AirDrop, Drafts or Finder) now become pages. gbrain inbox shows what is waiting; gbrain inbox run --once turns every waiting text, markdown, HTML or JSON file into an inbox/ page and moves the original to ~/.gbrain/inbox/.archived/<date>/; gbrain inbox run keeps watching until you stop it. On a PGLite brain the page is written right away; on Postgres it is queued for the job worker (gbrain jobs work, which autopilot runs). The same file dropped again applies once. A PDF, image, audio or video file stays in the inbox with a note: convert it to text first. Captured pages are stored as outside text, like a webhook capture.
