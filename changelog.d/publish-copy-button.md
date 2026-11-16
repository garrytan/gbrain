**Code blocks on pages made with `gbrain publish` get a Copy button, so a shared prompt or command can be pasted into an agent or terminal without selecting it by hand.**

### Added
- Every code block on a published page, including a password-protected page once it is unlocked, shows a Copy button in its top-right corner. It copies the block's exact text, works from the keyboard, and reads "Copied" for a moment. Pages opened from a file or a plain-http host fall back to the browser's older copy command. Code blocks also get a bordered panel that scrolls sideways, so long lines no longer stretch the page. Contributed by @Pierre-Bouquet (#9453).

### Fixed
- A published page whose markdown contains a closing `</script>` tag, such as a code block that shows HTML, now renders that text instead of breaking the page. Before, the tag ended the page's script early, so the rest of the page was lost and any HTML after it skipped the sanitizer.
- The password-protected page now renders unlocked content through the same sanitizing function as an open page, instead of patching its unlock script by string replacement.
