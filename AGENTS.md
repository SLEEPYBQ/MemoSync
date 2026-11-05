# AGENTS.md

## Code review

- MemoSync ships only for macOS (the desktop app) and runs from source on macOS and Linux. Windows is not a supported platform; don't report issues that only affect Windows paths or behavior.
- Prefer findings that change what a user sees or can lose. Skip style nits and speculative hardening.
- Real user memory never belongs in fixtures, logs or docs. Flag any that appears.
