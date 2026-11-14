# AGENTS.md

## Code review

- MemoSync ships desktop builds for macOS (Apple silicon and Intel), Windows x64 and Linux x64. Review path handling, subprocesses and native integrations on all three operating systems. Release builds run on their native OS/architecture; ordinary PR checks do not require installers.
- Prefer findings that change what a user sees or can lose. Skip style nits and speculative hardening.
- Real user memory never belongs in fixtures, logs or docs. Flag any that appears.
