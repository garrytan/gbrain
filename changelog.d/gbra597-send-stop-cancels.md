**Turning GBrain Helper's sending off now cancels a text that was still on its way, and `send-setup --off` only reports success when it can show the helper is stopped or has confirmed.**

### Fixed
- A send accepted before a confirmed `send-setup --off` or `send-key remove` is refused at the handover to Messages even if sending was turned back on, or the same key added again, in the few seconds before it got there. It answers `send_disabled` or `unknown_send_key`.
- When nothing answers on the helper's port, `send-setup --off` now checks whether a `gbrain-apple-helper` process is still running. Only when none is does it report success; otherwise it exits 69 and says a text being handed over may still go out.
- A busy answer to `send-setup --off` says a text being handed over may still go out.
- The helper no longer holds its settings lock while a send waits its turn with Messages, so `--off` waits only for a text already being handed over, not for one still waiting its turn. Other helper commands now wait up to 40 seconds as well, instead of 30.
