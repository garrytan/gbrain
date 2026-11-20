**GBrain Helper on a Mac can now turn on sending, because its keychain check accepts its own send-keys item when macOS records the app bundle instead of the program file inside it.**

### Fixed
- `send-setup` no longer fails with `send_keys_tampered` on a Mac where the keychain lists `GBrain Helper.app` as the app allowed to read the send keys. The check still compares exact paths, and the only paths it accepts are the helper's own program file and, when that file sits at `<name>.app/Contents/MacOS/<program>`, that one `.app` folder.
- Reinstalling the helper re-registers its background agent so the new build runs, refreshes the app's LaunchServices record first, and checks that the helper answers on its port before reporting success.
- When the background agent waits for you to turn it on in System Settings, the install no longer fails while waiting for an answer.
- The install ends by listing what stays on the Mac and how to remove it, including a new `gbrain-apple-helper unregister` command that removes the background agent.
