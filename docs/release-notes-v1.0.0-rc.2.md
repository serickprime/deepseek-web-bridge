# DeepSeek Web Bridge v1.0.0-rc.2

Second release candidate for the v1.0 line. This is a pre-release, not the final
stable v1.0.0.

## Fixed in rc.2

- Claude Code launched from Bridge Console now receives the required gateway
  model-discovery environment, restoring built-in tool availability.
- The fix applies to the supported Windows launcher and the native macOS/Linux
  terminal runners without changing OpenCode configuration.

## Validated scope

- Claude Code 2.1.241 frozen baseline and Claude Code 2.1.246 GUI launch
- `deepseek-v4-flash`
- OpenAI-compatible and Anthropic-compatible APIs
- `Write`, `Read`, `Edit` and `Bash` tool cycles
- Windows, Ubuntu and macOS CI

## Known limitations

- This unofficial bridge uses the authenticated user's own DeepSeek Web session.
- Changes to the internal DeepSeek Web API may temporarily break compatibility.
- Desktop GUI live validation is strongest on Windows; macOS/Linux CI validates
  real filesystem/process behavior but not full GUI terminal interaction.
