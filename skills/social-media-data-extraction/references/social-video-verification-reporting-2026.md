# Social video verification reporting pattern — 2026

Use when a self-hosted social-video metadata/stats resolver has been live-tested and the user asks what actually worked.

## Lesson

Do not report only `pytest passed`, `ruff clean`, or generic adapter status. For this class of project, the user's core question is usually:

> Which exact video URLs did we parse, and what numbers came back?

Put that answer at the top of the doc and at the top of the chat response. If the user is frustrated or asks «выведи ссылки», stop summarizing architecture and list the exact public URLs with metrics immediately.

## Required evidence matrix

For every tested URL, preserve:

- exact public URL as supplied/tested;
- platform;
- adapter/source;
- resolved media id;
- views / likes / comments / shares / reposts / plays, using `null`/`—` when absent;
- parsed/failed status;
- short reason for failures.

If a smoke test succeeded but URL or metrics were not saved, label it **partial** and rerun with a concrete URL list before claiming full platform verification.

## Good top-level shape

```md
## Короткий ответ

| Platform | Status | Evidence |
|---|---|---|
| Instagram Reels | ✅ real parse | 3 public Reel URLs, exact views/likes/comments/plays captured |
| YouTube Shorts | ✅ real parse | exact Shorts URLs and metrics captured via `youtube_yt_dlp_adapter` |
| TikTok | ✅/❌ per run | exact TikTok URLs and metrics or target-access failure captured |
```

Then add the concrete sample table:

```md
| Platform | URL | Source | ID | Views | Likes | Comments | Shares/Reposts | Result |
|---|---|---|---|---:|---:|---:|---:|---|
| TikTok | `https://vt.tiktok.com/.../` | `tiktok_web_rehydration_adapter` | `...` | ... | ... | ... | ... | ✅ parsed |
| YouTube | `https://youtube.com/shorts/...` | `youtube_yt_dlp_adapter` | `...` | ... | ... | ... | — | ✅ parsed |
```

## Classification rules

- **Real parsed sample**: exact URL/ID is known and exact returned fields/numbers are recorded.
- **Smoke test**: adapter/service returned an expected shape or non-empty fields, but URL/ID or exact numbers were not recorded. Label as partial.
- **Provider plumbing pass**: proxy/provider API calls work, but target platform data was not obtained. Do not imply platform extraction works.
- **Target-platform fail**: provider check/generic HTTP may pass while TikTok/Instagram/YouTube target access still fails. Say the target access failed.
- **Changed result after rerun**: update the verdict explicitly. Example: earlier TikTok via Proxy6 datacenter IPv4 failed; later user-provided TikTok URLs parsed via public rehydration. State both so the doc does not preserve stale pessimism.

## Copywriter pass checklist

When using a copywriter for verification docs:

1. Send a self-contained brief with exact sample URLs/IDs, numbers, and negative results.
2. Ask for a draft file, not direct overwrite of the canonical doc.
3. Coordinator must merge/fact-check; copywriters may over-compress evidence like warning details or caveats.
4. Keep privacy: no raw API keys, proxy hosts/user/pass, IPs, private domains, chat IDs, or unsaved live target URLs.
5. Push only after `git diff --check` and privacy scan.

## Example from social-video-metadata

Initial state:

- Instagram had exact numbers for 3 public Reels via anonymous GraphQL (`doc_id=10015901848480474`).
- YouTube had a live-smoke showing `youtube_yt_dlp_adapter` returned views/likes/comments, but exact URL/numbers were not saved; doc had to mark this as partial.
- TikTok through Proxy6 datacenter IPv4 did not produce stats; Proxy6 lifecycle worked, but TikTok target access was blocked.

Rerun pattern:

- User provided 3 TikTok and 3 YouTube Shorts URLs.
- Run the resolver against those exact URLs.
- Record every URL and number in `docs/verification-results.md`.
- Reply in chat with the concrete tables first, then mention tests/commit.
