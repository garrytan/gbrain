**Honor alpha upgrades from stable-pinned Bun global installs.**

### Fixed
- Resolve upstream `#stable` and `#latest-stable` installs to the selected published alpha version instead of updating the saved stable ref. Preserve Bun-floor refusal, remove-before-add recovery, current-version no-ops and unrelated branch/repository behavior.

<!-- behavior-change: alpha_escapes_stable_install_pin_8790 -->
