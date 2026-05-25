# Audio fixtures

Pre-recorded 16kHz mono 16-bit PCM WAV files. Used by `voice-roundtrip.test.mjs`
and `voice-full-flow.test.mjs` as the source for Chromium's
`--use-file-for-fake-audio-capture` flag.

| File | Content | Use case |
|------|---------|----------|
| `utterance-add.wav` | "What is two plus two?" | Semantic verify: response must mention 4 / four |
| `utterance-joke.wav` | "Tell me a one line joke." | Liveness: response just needs to exist and be coherent |
| `utterance-brain-query.wav` | "Search the brain for any recent notes about projects." | Tool-call verify: response should invoke `search` then summarize results |

## Regenerating

The fixtures are committed verbatim so tests are reproducible across machines.
If you ever need to regenerate (different voice, different utterance, etc.):

```bash
# macOS only — uses the `say` command + ffmpeg.
generate_fixture() {
  local text="$1"
  local out="$2"
  local tmp_aiff=$(mktemp /tmp/agent-voice-fixture.XXXXXX.aiff)
  /usr/bin/say -v Samantha -o "$tmp_aiff" "$text"
  ffmpeg -y -i "$tmp_aiff" -ar 16000 -ac 1 -sample_fmt s16 "$out"
  rm -f "$tmp_aiff"
}

generate_fixture "What is two plus two?" utterance-add.wav
generate_fixture "Tell me a one line joke." utterance-joke.wav
generate_fixture "Search the brain for any recent notes about projects." utterance-brain-query.wav
```

For Linux operators without `say`, use any TTS that produces 16kHz mono WAV
(e.g., `espeak`, `piper`, OpenAI TTS). The exact voice doesn't matter as long
as Whisper can transcribe it back for semantic-verify assertions.
