# Contributing to teleclaude

Thanks for helping out! Bug reports, fixes and features are all welcome.

## How changes get in

`main` is protected: nobody pushes to it directly. Every change goes through a
pull request, and a PR can only be merged once CI (typecheck + tests) passes
and a maintainer has reviewed it.

1. **Fork** the repo and create a branch from `main`
   (`git checkout -b fix/stall-alert-timing`).
2. Make your change, with tests where it's testable.
3. Run `npm run typecheck` and `npm test` locally.
4. Open a pull request against `main` and fill in the template.

For anything bigger than a bug fix, please open an issue first to talk it
through — it saves you from building something that won't fit.

## Development setup

```bash
git clone https://github.com/<your-fork>/teleclaude.git
cd teleclaude
npm install
npx tsx src/index.ts setup    # bot token + your Telegram user ID
npx tsx src/index.ts start    # run the daemon in the foreground
```

Use a **separate test bot and test group** for development, and stop any
installed teleclaude service first (`npx tsx src/index.ts uninstall`) — one bot
token supports only one polling process.

**Don't develop teleclaude from inside a teleclaude-hosted session.** Restarting
the daemon kills the Claude Code session doing the work.

## Read CLAUDE.md first

[CLAUDE.md](CLAUDE.md) is the architecture reference: why each piece works the
way it does, which Claude Code behaviours teleclaude depends on, and the
invariants the tests pin. Many things that look over-engineered are there
because of a specific failure — the reason is usually written down. If you
work with Claude Code, it picks this file up automatically.

## Ground rules

- **Tests never touch real state.** Use temp dirs; `saveSessionState` throws
  under vitest if it would write the real `~/.teleclaude`. No test may launch a
  browser.
- **No `console.log` in daemon code** — use the file logger (`src/log.ts`).
- **Escape everything** that goes into a Telegram HTML message (`escapeHtml`).
- **Match the surrounding code**: naming, comment density, small pure
  functions with tests for the decision logic.
- **Keep personal data out**: no real tokens, chat/user IDs or home paths in
  code, tests or fixtures.

## Reporting bugs

Open an issue with:

- the output of `npx tsx src/index.ts doctor`
- your Claude Code version (`claude --version`) and OS
- the relevant lines of `~/.teleclaude/logs/teleclaude.log` — scrub message
  content first, the log can contain it

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
