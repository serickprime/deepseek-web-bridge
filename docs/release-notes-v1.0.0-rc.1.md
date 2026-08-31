# DeepSeek Web Bridge v1.0.0-rc.1

First release candidate for the v1.0 line. This is a pre-release, not the final
stable v1.0.0.

## Validated

- Windows, Ubuntu and macOS CI
- OpenAI-compatible and Anthropic-compatible APIs
- Claude Code tool cycles with `Write`, `Read`, `Edit` and `Bash`
- multi-step tool correlation and fresh verification
- DeepSeek rate-limit handling
- persistence, restart and resume
- Claude Code `/compact`
- PB-v1 deterministic benchmark
- safe owned-process shutdown

The frozen live baseline for this release candidate is Claude Code 2.1.241 with
`deepseek-v4-flash`.

## Known limitations

- This is an unofficial bridge that uses the authenticated user's own DeepSeek
  Web session; it is not an official DeepSeek API or officially supported by
  DeepSeek.
- Changes to the internal DeepSeek Web API may temporarily break compatibility.
- Desktop GUI live validation is strongest on Windows.
- macOS/Linux CI exercises real OS filesystem and process behavior, but not full
  GUI terminal interaction.
- Later Claude Code releases are not automatically covered by the frozen 2.1.241
  live baseline.
