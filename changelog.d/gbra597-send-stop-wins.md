**Turning GBrain Helper's sending off now wins over a text in progress and over a Touch ID dialog still open.**

### Fixed
- Each send checks the kill switch and its key again right before it hands the text to Messages, under the lock the settings are saved under. Once `send-setup --off` or `send-key remove` has returned, no new text is handed to Messages; a text Messages has already accepted may still be delivered. Both commands now say so when they succeed.
- `send-setup --off` no longer waits for an earlier `send-setup` that is still showing its Touch ID dialog, and an approval given after the switch went off answers `send_disabled` instead of turning sending back on. `--off` keeps the config file locked until the helper has answered, so a `send-setup` started meanwhile waits for it instead of writing sending back on in between.
- `send-setup --off` says what happened when the helper doesn't confirm: if the helper isn't running it says so and exits 0, because the config switch alone stops every send; if it doesn't answer within 40 seconds it exits 69; and if it answers with an error, it names the error (for example that the helper was busy) instead of blaming the keychain.
