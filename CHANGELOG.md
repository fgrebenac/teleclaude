# Changelog

All notable changes to teleclaude are documented here. This project follows
[semantic versioning](https://semver.org/): MAJOR.MINOR.PATCH.

## Unreleased

### Changed
- **Open source under the MIT license.** The paid-distribution layer is gone: no
  tokenized update manifest, no `~/.teleclaude/update.json`, no staged
  `~/.teleclaude/app/` installs. `teleclaude update` and `/update` pull from git; a
  bundled build (`npm run build`) runs from wherever it was built.

### Fixed
- Screenshots (`/screenshot`, `browse`, `/diff` previews) no longer time out while the
  Mac's display is asleep: headless Chrome runs with `--disable-gpu`, and a 60s
  protocol timeout bounds any future stall.
- Fresh installs on npm ≥ 11.20, which blocks dependency install scripts by default:
  `package.json` now carries `allowScripts`, so puppeteer downloads Chrome (needed by
  `/screenshot` and `browse`) and node-pty can build where it has no prebuilt binary.
- `/rename <name>` didn't submit longer names on Claude Code 2.1.308: one write with a
  trailing Enter is now treated as a paste. The Enter is sent separately.
- `/sessions` labels: sessions are listed by rename, then Claude Code's title, then the
  first real prompt — not the "you must use the reply tool" reminder.

### Added
- **Sessions name themselves.** After a session's first finished turn, teleclaude asks
  Claude Code to name it from the conversation (a bare `/rename`), so Telegram sessions
  show up in `/sessions` and the terminal `/resume` picker by what they're about instead
  of `<dir>-<2hex>`. Only for sessions still on Claude Code's placeholder name, only
  while idle, once per process. Turn off with `defaults.autoNameSessions: false`.
- **Live turn view** — a project topic can now show what Claude is doing *while* it's
  doing it: incremental narration (assistant "thinking out loud" text, via the new
  `MessageDisplay` hook), per-tool outcomes (✓/❌ with duration or error snippet, via
  the new `PostToolUseFailure` hook alongside the existing `PostToolUse`), and subagent
  rows with their own nested tool calls that collapse to a final line when the agent
  stops. `/live full|summary|off` picks the detail level per topic (persisted, default
  `summary`); `summary` collapses the live message down to just the finished reply text
  once a turn settles, `full` keeps everything live, `off` matches the old behavior
  (off still shows the new tool outcomes and agent rows; it disables narration and
  summary collapse). Switching modes applies immediately, with no session respawn.
  `full`/`summary` additionally collapse each CLOSED phase (its reply already
  delivered) to a one-line `▸ N tools · M agents · Ns` summary above the reply, while
  the still-running phase keeps full tool-line detail; `off` keeps the classic
  uncollapsed per-phase rendering.

### Fixed
- **Topics no longer die on first start in a new folder (Claude Code 2.1.301+).** The
  workspace-trust dialog now lists "No, exit" first and highlights it, so the unattended
  Enter declined it and Claude Code exited with code 1 ("Claude Code exited right after
  starting"). Every spawn now pre-trusts its working directory (previously only `/new`
  and `/ls` did, so topics restored from `projects.json` on a new machine hit the
  dialog), and the PTY fallback moves to "Yes, I trust this folder" before confirming.
- **`install` works on a brand-new macOS account.** It now creates
  `~/Library/LaunchAgents` if missing instead of failing with `ENOENT`.
- **Typing indicator no longer disappears while Claude is working.** Three gaps closed:
  it now starts the moment a message is accepted instead of after spawn + channel
  readiness (a cold topic used to show nothing for the whole 8-30s startup), it re-sends
  immediately after every activity event (throttled to 1.5s, except a confirmed reply
  send, which always re-sends — Telegram clients clear the typing status whenever a bot
  message arrives, so waiting for the next 4s tick left a visible blink after every
  reply/activity render), and an indicator kept alive by a stray post-turn event (e.g.
  a lingering parallel subagent's tool call, whether it lands inside the post-done
  settle window or after the indicator already stopped) now carries a 5-min idle cap
  instead of running until the next turn happens to stop it. Every delivery-failure
  path stops the early-started indicator.

### Changed
- **Reply-tool reminder trimmed to once per spawn** — the "you must use the reply tool"
  prefix used to be prepended to every injected message; it's now sent only on the first
  message a freshly spawned session sees, with the MCP server instructions,
  post-compaction system-reminder re-injection, and the `/forward` fallback all still
  covering a session that never gets that first reminder.

Message-reliability fixes: a focused pass over delivery correctness and Telegram
formatting, closing gaps found while stress-testing the send/receive paths.

### Fixed
- **Stuck-tool watchdog leak on failed tools** — a tool call that errored used to never
  fire `PostToolUse`, so the watchdog's in-flight tool count only ever went up for that
  call and never came back down; the new `PostToolUseFailure` handling now decrements it
  like any other completed tool.
- **Silent photo/document drop fixed** — a failed inbound photo/document upload used to
  vanish with no notice; the user now gets told the receive failed instead of wondering
  why nothing happened.
- **Reply overwrite/duplicate races fixed** — a turn-generation guard stops a stale,
  in-flight reply from overwriting or resurrecting a newer turn's state, and the
  edit-failure fallback now sends only the newest phase instead of duplicating history
  (`reply-delivery.ts`, extracted and unit-tested).
- **Exactly-once inbound dedupe** — the channel-server's injected-message dedupe now
  tracks in-flight (not just completed) injections and re-checks state after awaiting a
  prior attempt, so a timed-out retry can no longer double-inject the same message.
- **Telegram 429s handled with bounded waits** — rate-limit responses honor `retry_after`
  up to a 10s cap instead of blind-resending a message that may have already been
  delivered; duplicate-delivery responses are no longer re-queued for StopFailure resend.
- **Upload timeouts** added to previously unbounded Telegram upload calls.
- **`/forward` budget aligned** with the new worst-case send timing (bounded retries +
  capped 429 waits) so it can no longer time out before a legitimate send completes.
- **DM routing ack corrected on failure** — `/<project> <message>` from a DM no longer
  reports a false "✅ → Name" when delivery into the topic actually failed.
- **StopFailure resend overflow disclosed** — if messages were evicted from the pending
  queue before an auto-resend, the user is told, instead of a silent partial resend.
- **Formatter fixes**: quotes inside URLs are escaped correctly in HTML output;
  parenthesized link URLs are now supported; tables inside fenced code blocks pass
  through verbatim instead of being reformatted, and small tables keep their headers;
  message splitting never cuts a surrogate pair in half; a split across a code fence now
  closes and reopens the fence so formatting survives the split; nested bold/italic and
  literal asterisks inside bold render correctly.

## [1.8.0] — 2026-08-24

### Added
- **`send_page` MCP tool** — Claude can now send any report, table, or long
  structured answer as a polished, self-contained HTML document that opens in
  Telegram's in-app browser (the generalization of `/diff`'s delivery shape).
  Claude passes title + markdown (GFM: tables, fenced code; inline HTML passes
  through as an escape hatch); the channel server renders it through a new pure
  module (`page-render.ts`, via `marked`) into a dark-mode-aware template and
  uploads it **from memory** — no temp file, nothing written to the project
  repo, so `send_file`'s path containment isn't involved and no new
  exfiltration surface is added. A `Content-Security-Policy` meta tag on every
  rendered page enforces the no-script/no-network invariant (inline `<script>`
  or `<img>` beacons in content are inert), and a test asserts the template
  references no external URLs. Content capped at 2MB; filenames slugged from
  the title. The schema stays deferred (not `alwaysLoad`); discoverability
  comes from the server instructions and the post-compaction reminder, and the
  tool is pre-approved via `--allowedTools`.

## [1.7.0] — 2026-08-23

The hardening and feature release: everything from the 2026-08-21 five-review
audit's Phase 0 plus the packaging, value-feature, and session-mobility work built on it.
~95 commits, all subagent-implemented and review-gated; suite grew 597 → 826 tests.

### Security & correctness (Phase 0)
- **`send_file` confined to the project root** — the critical audit finding: the tool is
  pre-approved, so a prompt-injected repo could previously exfiltrate any absolute path
  (`~/.ssh`, the MCP config with the bot token) to the topic. Realpath containment both
  sides, symlinks resolved, 50MB cap, fail-closed with no root.
- **`killPort` replaced with an identity-checked sweep** — never SIGKILLs a stranger's
  process on a recycled port; foreign listeners make spawn move to a new port instead.
- **Channel-server auth fails closed on an empty token**; state files written 0600 in a
  0700 dir; corrupt `sessions.json` preserved as `.corrupt-<ts>` instead of silently reset.
- **Boot auto-spawn can no longer crash-loop the daemon** (stale-state re-check at fire
  time + try/catch around a synchronously-throwing `pty.spawn`).
- **Delivery correctness**: every failed channel POST notifies instead of dropping,
  loopback fetches are bounded, failure-path kills are generation-guarded, reply counters
  reset on kill, and a failed `/forward` falls back to a direct send.
- **Delivery is idempotent and ledgered** — `DeliveryEnvelope` ids + channel-server dedupe
  close the at-least-once resend holes (StopFailure auto-resend, scheduler retries).

### Architecture
- **TopicRuntime** — the ~12 scattered per-topic maps (timers, counters, scratch state)
  consolidated into one registry object with a single `dispose()` on process death.

### Packaging & onboarding
- **`teleclaude doctor`** — read-only environment preflight (claude/node/token/owners/
  groups/paths/optional deps), safe while the daemon runs.
- **Bundled build**: esbuild bundles (`dist/index.js` + `dist/channel-server.js`
  — plain node over MCP stdio, spike-verified), setup-time token + owner-id validation.
- **DM privacy**: group membership enforced for DM routing and pickers; project listings
  filtered by membership.

### Features
- `/diff` — uncommitted changes: diff-stat summary, full `.patch`, a **self-contained
  syntax-highlighted HTML document** that opens in Telegram's in-app browser (diff2html,
  offline-only), and a **"🖼 Preview as images" button** rendering paged PNGs as an album.
- `/review` — turn-end prompt on uncommitted changes (show diff / ask Claude to commit /
  leave), deduped on the dirty-state signature.
- `/receipts` — one-line turn receipts (duration · tools · ~tokens out).
- `/digest` — preset recurring briefings via buttons, persisted as normal cron jobs.
- `/webhook` — per-topic inbound webhook (constant-time token auth, localhost-only).
- `defaults.schedulePauseAtPercent` — defer scheduled runs above a quota threshold.
- **Worktree/subfolder sessions** — sessions started in a git worktree or subdirectory are
  now visible in `/sessions` (labeled `↳ path`), resumable at the right cwd (persisted per
  topic, self-healing when the worktree was deleted), and found by `/usage`. `/diff` and
  `/review` follow the session's cwd too.
- `/handoff` — hand a topic's session to your terminal: stops it here and replies with the
  exact `cd … && claude --resume …` command.
- **Two-writer protection** — resuming a session that's open in another Claude process is
  refused (live-session registry check); `/sessions` marks such sessions 🔺.

## [1.6.10] — 2026-08-03

### Fixed
- **`/usage` no longer spikes the daemon's heap by 142MB.** It aggregates every
  transcript modified in the window — 246MB of the 681MB on disk here — and read
  each one whole with `readFileSync` plus `split("\n")`, holding the file *and* an
  array of its lines. Transcripts are now walked in bounded chunks, so the same
  numbers cost 4MB. Verified byte-identical output before and after.
- **Sessions over 50MB were silently excluded from usage totals.** That cap
  existed to keep the whole-file read from blowing up memory; with reading now
  bounded it's raised to 512MB and exists only to stop an enormous transcript
  stalling the event loop. Nothing on this host was over it yet — the largest is
  26MB and growing.
- **Multi-byte characters no longer risk corruption when read in chunks.**
  Decoding goes through `StringDecoder`, since a chunk boundary can land
  mid-character and transcripts are full of non-ASCII.
- **The callback server authenticates before reading the request body**, and caps
  the body size. A POST without a usable `(chat, topic)` pair previously skipped
  the spawn-token check altogether and fell through to a log line, which let any
  local process write to the daemon log; an unbounded body read let one caller
  grow the heap at will.

## [1.6.9] — 2026-08-03

### Changed
- **Hooks are installed per spawn instead of per project.** They were merged
  into each project's own `.claude/settings.local.json`, which meant they applied
  to *every* Claude Code session in that directory: your own terminal sessions
  fired teleclaude's callbacks on every tool use, and the daemon had to recognise
  and reject them as foreign. It also wrote the spawn token — which doubles as
  the channel server's HTTP auth — into a file inside a repo, and any hook key a
  later version stopped installing was left behind firing forever. Hooks now live
  in a per-spawn temp file passed with `--settings`, deleted when the session is
  killed. `--settings` merges with your settings files rather than replacing
  them, so your own hooks still run. teleclaude no longer writes into any project
  directory; the boot sweep now exists to clean up what older versions left.

## [1.6.8] — 2026-08-03

### Fixed
- **Startup dialogs are answered when they appear, not on a fixed timer.** Spawn
  cleared Claude Code's workspace-trust and development-channels dialogs with
  blind Enters at 2s and 4s — a bet on render timing, where a third dialog would
  never be answered at all and a missed one costs the whole spawn. The PTY
  handler now matches the affordance every dialog prints and answers each as it
  renders, rate-limited and capped, with the timed Enters kept as a fallback.

## [1.6.7] — 2026-08-03

### Fixed
- **MCP tool schemas no longer drift from the types they describe.** The
  hand-written JSON Schema for `android`/`ios` declared every field optional with
  only `action` required, while their action types are discriminated unions — so
  `{action:"install"}` with no apk passed validation and failed inside adb, and
  the call handler cast unvalidated input. Tools are now declared with
  `registerTool` + zod schemas that mirror each module's exported type, asserted
  assignable at compile time, so per-action requirements are documented to Claude
  instead of discovered by failing. `browse` stays loose on purpose: it soft-fails
  per action and finishes the sequence.

## [1.6.6] — 2026-08-03

### Fixed
- **README described the pre-auto-mode world**; refreshed, and `AGENTS.md` is
  gitignored so `teleclaude update` (and `/update` from chat) stops refusing on a
  dirty tree.

## [1.6.5] — 2026-08-03

Closing the remaining ways a topic can stall waiting for a human who isn't at
the terminal.

### Changed
- **Sessions spawn with `--strict-mcp-config`**, so a topic loads only
  teleclaude's own channel server. `--mcp-config` is additive, so every topic was
  also inheriting globally configured MCP servers — verified live, a plain spawn
  opened an HTTP transport to `a third-party MCP server` on every topic. That made a
  topic's tool surface depend on unrelated installs and pulled in auth and
  elicitation prompts nobody can answer from a phone. Set
  `defaults.strictMcpConfig` to `false` in `~/.teleclaude/config.json` if you
  deliberately want a global MCP server reachable from Telegram.

### Fixed
- **An MCP server asking for interactive input no longer hangs the turn.** Its
  form dialog renders in a PTY nobody is watching, and unlike a permission prompt
  there's no asynchronous channel to answer it through — the hook response *is*
  the answer. The `Elicitation` hook now declines, tells the topic what happened,
  and tells Claude not to retry but to ask through the reply tool instead.

## [1.6.4] — 2026-08-03

### Added
- **Auto-mode denials are forwarded to the topic.** Switching to auto mode in
  1.6.3 introduced a signal with nowhere to go: when the classifier blocks an
  action, Claude Code tells Claude and shows the user a terminal notification
  plus a `/permissions` entry — none of which exists on a phone. Claude quietly
  tried another way and you couldn't tell why the answer changed shape. The
  `PermissionDenied` hook now reaches the topic with the tool and an input
  preview, throttled per `(topic, tool, input)` so a retried block doesn't spam
  while genuinely different blocks all get through.

### Fixed
- **Dead hooks are swept for every project at boot, not only for projects being
  spawned.** Retired hook keys were pruned during spawn, so a project driven
  from a terminal kept its fossils forever — an old `UserPromptSubmit` hook was
  still POSTing `event=working` on every prompt, with no chat id and no token, so
  it skipped the auth guard and landed in the daemon's unhandled branch. Measured
  177 dead hooks across 21 of 22 project settings files. The daemon now prunes
  them at startup, before auto-spawn, when no spawn is alive to own them.
  Unparseable settings files are skipped rather than truncated, files with
  nothing to prune aren't rewritten, and a failure can't block startup.

## [1.6.3] — 2026-08-03

A review of what changed in MCP and Claude Code recently, and the fixes that
came out of it (self-review plus an independent GPT review of both the code and
the research). The 2026-07-28 MCP spec revision itself needs nothing from us —
it targets remote HTTP servers, and the SDK still negotiates 2025-11-25 — but
the client side had moved underneath us.

### Changed
- **Sessions now run in Claude Code's `auto` permission mode, not bypass.**
  Every session spawned with `--dangerously-skip-permissions`, and that was the
  *default* — any topic with no persisted choice ran with no permission checks
  and no prompt-injection protection at all. Auto mode has a classifier vet each
  action, blocking the escalation, exfiltration and destruction classes while
  routine local work still runs unprompted. It fails soft toward supervision:
  repeated classifier blocks (or a model that doesn't support auto mode) make
  Claude Code fall back to prompting, and the permission relay turns those
  prompts into Telegram buttons.
- **`/permissions` replaces `/bypass`**, picking Auto / Supervised / Bypass per
  topic by inline button or argument. Bypass is still reachable, just no longer
  one keystroke away. A legacy `bypass` boolean in `sessions.json` is still
  honoured, since that was an explicit choice.
- **`reply` and `send_file` are pinned into context** with
  `_meta: {"anthropic/alwaysLoad": true}`. Claude Code defers MCP tool schemas
  behind `ToolSearch` by default, and the logs showed two `ToolSearch` calls
  (~9s) before *every* reply — a search round-trip to find the one tool the
  bridge needs on every turn. Pinned per-tool, so the large `android`/`ios`/
  `browse` schemas stay deferred and out of context.

### Added
- **Screenshots can come back to Claude, not just to you.** `screenshot`,
  `browse`, `android` and `ios` accept `return_image: true`, which appends the
  final screenshot to the tool result as an MCP image block — so Claude can
  actually see what it captured and do a tap → look → tap loop on an emulator
  instead of being told "screenshot sent". Opt-in, since image payloads count
  against `MAX_MCP_OUTPUT_TOKENS`. Downscaled through `sips`/`magick`/`convert`
  on a ladder tuned against a real measurement, and never inlined over 90KB —
  when it can't be inlined the result says so, so Claude doesn't act as if it
  saw an image it never got.

### Fixed
- **The permission relay could hang a turn outright.** `tool_name`,
  `description` and `input_preview` went into a `parse_mode: "HTML"` message
  unescaped, so a bare `<` or `&` made Telegram reject the send — the 🔐 prompt
  never arrived and the turn waited for the 5-minute auto-deny. They're escaped
  and clipped to a budget now (the client relays up to 3,500 code points *per
  field*, which overflows Telegram's 4096 on its own), and a failed HTML send
  retries as plain text.
- **A failed prompt send left no auto-deny timer at all**, so that turn waited
  forever with nobody watching the terminal dialog. The timer is armed before
  the send.
- **The timeout no longer claims a denial for work that already ran.** Claude
  Code never reports a prompt answered at the *local* terminal, so the auto-deny
  could fire after a call had been approved and completed, injecting
  "auto-denied after timeout" as false context. A completed tool of that name,
  or the turn ending, now marks the prompt answered — and neither cancels the
  auto-deny, because both are inferences and a wrong one must never cost the
  safety net. Turn end also retires the prompt's dead buttons from the chat.
- **A verdict for an already-closed prompt is swallowed** instead of reaching
  Claude as chat text.
- **A failed `sendPhoto` no longer abandons the remaining screenshots** in
  `/tmp` (200KB–1.5MB each).

## [1.6.1] — 2026-07-31

Review pass over the 1.5.0/1.6.0 features (self-review plus an independent
GPT review); every finding from both is addressed here.

### Fixed
- **Scheduled runs no longer silently lost on a failed delivery.** The schedule
  was advanced (and one-shots deleted) before delivery, but `sendToChannel`
  handles spawn failures, a blocked channel and POST errors internally rather
  than throwing — so a run that never reached Claude was recorded as done. It
  now returns a delivery result; the schedule only advances on success, and a
  failure retries in 5 min up to 3 attempts before giving up with a notice.
  The attempt counter is persisted before delivery, so a crash mid-run can't
  loop, and `lastRunAt` is only stamped for runs that actually happened.
- **A weekly bucket resetting exactly 7 days out got no reset notice** — the
  one-minute buffer pushed it past the 7-day cap.
- **The quota reset notice no longer claims "available again" when it couldn't
  check.** An unreachable quota API is now treated as unknown: it re-arms and
  looks again, and hedges the wording if it still can't confirm.
- **A failure building the continue picker no longer suppresses the whole quota
  alert** — it falls back to a plain-text alert.
- **`/at 2026-02-30 07:00` is rejected** instead of silently becoming March 2.
- **`/schedules` can't exceed Telegram's message limit** (20 flag-heavy jobs
  measured 4944 chars, and an over-long reply is just dropped); it now budgets
  by characters and says how many it hid.
- **`/unschedule <prefix>` refuses an ambiguous prefix** instead of cancelling
  an arbitrary match; job ids are also checked for collisions on creation.
- **Continue-at-reset buttons expire** 30 minutes after the limit resets, and
  identical continue runs are deduped so two owners confirming the same alert
  can't queue the same prompt twice.
- **The scheduler can't be wedged by a hung socket**: every await in a tick is
  bounded (4 min per delivery, 30s per Telegram call), and a tick running over
  15 minutes releases the overlap guard.
- **Project creation refuses a name that folds to the same `/command`** as an
  existing project (`Garden-Web` vs `garden_web`) — routing couldn't tell them
  apart and only one could appear in the command menu.

### Changed
- Scheduling inside a group now resolves the project within that group only
  (DMs still reach any project, like `/<project> <message>`).
- Cancelling a schedule from a DM requires being its creator; group buttons
  still cancel that group's jobs.
- Each chat is capped at 50 schedules.

## [1.6.0] — 2026-07-31

### Added
- **"Continue at reset" buttons on the quota-exhausted alert.** The 5h cap
  usually lands mid-task, so the 🔴 DM now carries a project picker: one toggle
  per project that was working (ticked by default if its session was live),
  plus ⏰ Continue at reset. Confirming schedules a "Continue working" message
  into each ticked project for just after the limit resets, resuming the
  existing session with its context. The confirmation lists an
  `/unschedule <id>` per job.

## [1.5.0] — 2026-07-31

### Added
- **Scheduled runs: `/at`, `/every`, `/schedules`, `/unschedule`.** Wake a
  session on a timer without a live session to set it up. One-off (`07:00`,
  `tomorrow 07:00`, `2026-08-02 09:00`, `+30m`) and recurring (`day 07:00`,
  `mon-fri 09:30`, `30m`, raw `"0 7 * * 1-5"` cron), in host local time. Jobs
  persist in `~/.teleclaude/schedules.json` and deliver through the same
  `sendToChannel` path a typed message takes, so spawn/resume, channel-readiness
  waiting and stall alerts all apply. Per-job `--new` / `--model` / `--effort`
  flags. Works from a project topic (project implied), the group General topic,
  or a DM to the bot. A run missed while the daemon was down fires within a
  30-minute grace window; older ones are skipped with a note.

- **Telegram command menu (`setMyCommands`).** The bot now registers its
  commands, so the Menu button and `/` autocomplete work — per scope (DM,
  group, and one list per known chat), each carrying `/<project>` routing
  shortcuts. Re-synced automatically whenever the project list changes.
- **Richer `/help`.** Works inside project topics too (it used to refuse),
  scoped to where you ran it, and `/help schedule` prints a full scheduling
  reference. A test asserts every registered command is documented.

### Changed
- Project routing (`/<project> <message>`) now accepts Telegram-safe spellings:
  `/game_template` reaches `Game-Template`, `/cafe` reaches `Café`.

### Fixed
- **Quota alerts no longer repeat every 10 minutes at 100%.** The API restamps
  `resets_at` with per-request microseconds, so the dedupe key changed on every
  poll and re-alerted forever. The key now floors the reset time to the minute.
  At 100% the bot sends one red "exhausted" DM and schedules a single 🟢 message
  for when the bucket actually resets, instead of repeating.

## [1.4.0] — 2026-07-06

### Added
- **`/update` and `/restart` from chat.** Previously restarting from a
  Teleclaude chat killed the channel server hosting it (a real past incident).
  Now: pre-flight checks (dirty tree, commits behind origin) run in the live
  daemon, a confirmation button shows how many sessions would be interrupted,
  pull+install run before anything is killed, the service restart is spawned
  detached so it survives the daemon, and a marker file makes the freshly
  booted daemon confirm "✅ Back online — v…" into the same chat.
- **Proactive quota alerts.** The daemon checks subscription quota every
  10 minutes and DMs all owners when a bucket (5h / weekly / per-model)
  crosses `defaults.quotaAlertPercent` (default 90, 0 disables) — once per
  reset window. A stalled-at-100% bucket previously looked like a silent
  multi-hour hang.

## [1.3.1] — 2026-07-06

### Changed
- All dependencies updated to latest: grammy 1.44, @modelcontextprotocol/sdk
  1.29, zod 4.4, tsx 4.23, vitest 4.1, and the majors TypeScript 6.0 and
  Puppeteer 25.3 (screenshot path smoke-tested against a real browser).
  `@types/node` stays on 25.x intentionally — it matches the installed Node
  runtime (v25). 0 npm audit vulnerabilities.

## [1.3.0] — 2026-07-06

Full-project review sweep: five batches of confirmed-bug fixes and hardening.

### Fixed
- **`/status` and `/usage` in project topics never responded** — each was
  registered twice and the general-topic handler consumed the update without
  calling `next()`. Merged into single handlers branching on topic.
- **One throwing handler could kill the bot** — no `bot.catch` meant an
  exception in any handler silently ended the polling loop, after which the
  health watchdog killed every running session. Now logged and survived.
- **Ordinary replies like "no problem" were eaten as permission verdicts** —
  the `yes|no <id>` regex now only consumes a message when the id matches a
  *pending* permission request.
- **Lost messages**: channel-server startup timeouts retry once and notify the
  user; StopFailure recovery auto-resends the message that triggered the failed
  turn (once); POST failures notify instead of failing silently.
- **Spawn lifecycle races**: readiness waits are generation-aware (`spawnToken`),
  so failure paths can no longer kill a *newer* process after /new//model
  restarts; messages arriving while a directly-spawned session (boot, /model,
  /bypass, /resume) is still booting now wait for readiness instead of killing
  it on ECONNREFUSED; a spawn throw can no longer brick the topic via a stuck
  rejected promise; /stop during a spawn no longer burns the full 60s timeout;
  a boot-spawned channel-blocked process is killed so the cooldown respawn can
  detect re-enabled channels.
- **Watchdog gaps**: the stall alert re-arms when it fires mid-tool (a wedge
  after tool completion never alerted before) and stops the typing indicator;
  the stuck-tool watchdog tracks an in-flight tool *count* so parallel tool
  calls can't disarm it early.
- **iOS simulator tool interactions never worked** — `idb tap/swipe/type/button`
  are not real subcommands; now `idb ui tap` / `ui swipe` / `ui text` /
  `ui button`. Error filtering no longer aborts the action list on ordinary
  "device not found" output. Android `type` escapes device-shell metacharacters.
- **`/sessions`, `/resume`, `/usage` were silently empty** for project paths
  containing dots or unicode — session-dir munging now matches Claude Code's
  (all non-alphanumerics → `-`).
- False "channels blocked" detection: PTY classification only runs until the
  channel registers (self-referential assistant output could trigger it) and
  uses a rolling buffer (banners split across PTY chunks were missed).

### Changed
- **Log moved to `~/.teleclaude/logs/teleclaude.log`** (0600) with dated local
  timestamps and 10MB rotation. Raw PTY output is only logged during startup
  (was 88% of log volume and leaked conversation content into world-readable
  /tmp); set `TELECLAUDE_DEBUG_PTY=1` for the old firehose. Foreign-session
  hook rejections log once per session instead of per tool call.
- State files (`config.json`, `projects.json`, `sessions.json`) are written
  atomically (temp+rename); corrupt files are preserved as `.corrupt-<ts>` and
  tolerated on load instead of crash-looping the daemon.

### Security
- `.claude/settings.local.json` written 0600 — its hook URLs embed the spawn
  token that doubles as the channel server's HTTP auth.
- Callback server (:8800) rejects events for topics with no running process
  (was: no token required at all in that case).
- Document uploads `basename()` the sender-controlled filename (path
  traversal out of `_inbox/`); `screenshot`/`browse` only accept http(s) URLs
  (no more `file://`); Telegram file downloads validate the response.
- `npm audit fix`: 15 vulnerabilities → 1 (low, dev-only); typescript moved to
  devDependencies.

## [1.2.1] — 2026-06-08

### Fixed
- **Typing indicator stuck on after the reply.** A `subagent_stop` reliably fires
  2-3s *after* the final `done`; it was treated as activity, which cancelled the
  pending stop and re-armed typing with no following `done` to ever stop it again
  (indicator ran indefinitely). Subagent lifecycle events no longer keep typing
  alive — during real subagent work the main turn hasn't `done`'d yet, so the
  indicator stays on without them.

## [1.2.0] — 2026-06-08

### Added
- **Session continuity across restarts** — session ids are now persisted as soon
  as they're known, so a conversation survives a daemon restart/deploy and resumes
  (with context) on your next message. Boot auto-spawn is gated on recent activity
  (`lastActiveAt`, 48h window) so it stays bounded with many projects; turn
  completion bumps activity so cron-driven sessions keep auto-spawning.
- **Configurable stall alert** — `defaults.stallAlertMinutes` (was the unused
  `processTimeoutMinutes`) controls when the no-progress force-stop ping fires
  (default 5, 1-minute floor).

### Changed
- Consolidated the composite-key helper into a single `topicKey(chatId, topicId)`
  (`bot.ts`), replacing the per-module `sessionKey`/`procKey`/inline copies — one
  source of truth so the order can't drift.

## [1.1.4] — 2026-06-08

### Added
- **Legacy project self-heal** — a project with no `chatId` (e.g. one that never
  had a session) is stamped with its chat the first time a message is sent in its
  topic, so it auto-spawns on boot and DM routing works (`backfillProjectChat`).

### Changed
- Extracted the typing-indicator state machine (`typing-state.ts`) and DM-route
  resolution (`resolveRoute`) into pure, unit-tested functions. +12 tests
  (typing lifecycle, route resolution, self-heal); 112 total.

## [1.1.3] — 2026-06-08

### Changed
- **Typing indicator now stops on the confirmed final send**, not a blind timer.
  `event=reply` is posted only after the Telegram send completes, and the reply
  tool awaits delivery, so `done` lands after the final reply: with replies it
  stops after a 2.5s settle; with no reply it waits for a new `forwarded` event
  (emitted after the `/forward` fallback send) before stopping. 8s fallback only
  when nothing is sent. Any later activity resets the pending stop.

## [1.1.2] — 2026-06-08

### Fixed
- **Typing indicator cut off mid-work** — the Stop hook fires per-turn, and typing
  stopped on the first `done`, so it vanished while Claude was still working on
  multi-turn tasks. Typing now stays on through all activity (reply/tool_use/
  subagent/compaction) and only stops after an 8s quiet grace period (also
  covering the final message edit). Terminal events still stop it immediately.
  `tool_use` is now forwarded to the event handler so long tool phases keep it on.

## [1.1.1] — 2026-06-08

### Fixed
- **StopFailure wedge** — when a Claude turn failed (`StopFailure`), the process
  stayed alive but stopped pulling new channel messages, so further messages were
  silently dropped until a manual `/new`. Now the session auto-resets on error
  (persisting the live session id, then killing) so the next message respawns a
  fresh session resuming context — no `/new` needed.
- **Silent stalls** — a turn stuck with no active tool (e.g. retrying a failing
  API call) gave no signal for hours; the 5-minute response timeout only logged.
  It now notifies with a force-stop button when there's no reply and no tool
  running, so a stall surfaces in minutes instead of hours.

## [1.1.0] — 2026-06-08

### Added
- **Multi-user whitelist** — `ownerTelegramIds` in `config.json` authorizes
  several Telegram users (e.g. you and a partner). Legacy `ownerTelegramId`
  still honored. `setup` accepts comma-separated IDs.
- **Multi-group support** — projects, sessions, and processes are keyed by the
  composite `(chatId, topicId)`, so multiple Telegram groups can run side by
  side (your own, someone else's, shared). General-topic commands (`/new`,
  `/list`, `/delete`, `/status`) are scoped to the current group.
- **Deployment commands** — `teleclaude update` (git pull + npm install +
  restart), `teleclaude restart`, and `teleclaude version`. `scripts/install.sh`
  bootstraps a fresh install. `/status` in Telegram shows the running version.

### Changed
- Startup migration (`migrate.ts`) re-keys old `sessions.json` and backfills
  `Project.chatId` automatically on first run after upgrade. Idempotent.

## [1.0.0]

- Initial release: forum-topic-per-project Claude Code sessions, channels
  messaging, voice/photo/document handling, session management, model/effort
  switching, permission relay, launchd/systemd service.
