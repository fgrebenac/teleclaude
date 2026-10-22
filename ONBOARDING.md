# Getting Started with Teleclaude

This walks you through your first hour with teleclaude, end to end: Telegram
setup, installing the service, and sending your first message to a Claude
Code session from your phone. Budget about 15 minutes.

For background on what teleclaude does and full command/config reference, see
[README.md](README.md) — this guide only covers first-run setup.

## What you'll need

- **A Mac or Linux machine** you can leave running — this hosts the bridge;
  your phone just talks to it over Telegram.
- **Claude Code** installed and logged in, with a Claude **Pro or Max
  subscription** (teleclaude drives Claude Code with your existing login —
  no separate API key).
- **Channels enabled** on your Claude account. Individual Pro/Max accounts
  have this by default; if your account belongs to an organization, an admin
  must turn on `channelsEnabled` at claude.ai/admin-settings/claude-code —
  without it, topics will never answer (teleclaude detects this and alerts
  you).
- **Node.js 20 or newer.**
- **A Telegram account.**
- **Linux only:** the installer runs `loginctl enable-linger` so the service
  survives logout; if that fails, run `loginctl enable-linger $USER` once.

See [README.md's Prerequisites](README.md#prerequisites) for the full list,
including optional voice-transcription dependencies.

## Step 1 — Set up your Telegram group and bot

Three things, all inside Telegram:

1. **A bot token.** Message [@BotFather](https://t.me/BotFather), send
   `/newbot`, and follow the prompts (it asks for a display name and a
   username ending in `bot`). It replies with a token that looks like
   `123456:ABC-DEF...` — copy it somewhere safe, you'll paste it in during
   setup.
2. **Your Telegram user ID.** Message [@userinfobot](https://t.me/userinfobot)
   — it replies with a number. That's you, and it's what teleclaude uses to
   confirm messages come from you and not a stranger who finds the bot.
3. **A group with Topics enabled.** Create a new Telegram group, open its
   settings, and turn on **Topics** (Telegram converts it to a supergroup
   automatically). Add the bot you just created to the group, then promote it
   to **admin** and grant it **Manage Topics** — it needs this permission to
   create a forum topic per project.

## Step 2 — Install

On the machine that will host teleclaude (macOS or Linux):

```bash
git clone https://github.com/fgrebenac/teleclaude.git
cd teleclaude
./scripts/install.sh
```

This installs dependencies, walks you through setup (bot token + your
Telegram ID from Step 1), and installs a background service so teleclaude
keeps running and restarts on its own if the machine reboots.

Every command below runs from the checkout directory as
`npx tsx src/index.ts <command>`.

## Step 3 — Run the doctor

Once the installer finishes, confirm everything is healthy:

```bash
npx tsx src/index.ts doctor
```

This checks your Node version, Claude Code presence/version/login, Telegram
bot token, authorized users, your group's bot membership, project directory
paths, and optional dependencies — and flags the org `channelsEnabled` policy
if it looks like it could block your topics. Fix anything marked ❌ before
moving on.

Keep this command in mind — it's the first thing to run any time something
misbehaves later.

## Step 4 — Setup (if you skipped it)

If the installer's setup prompt was interrupted, or you need to add another
authorized user, run:

```bash
npx tsx src/index.ts setup
```

It asks for the bot token and the authorized Telegram user ID(s) — list every
ID comma-separated (e.g. `123456789, 991234567`); anyone not listed is
silently ignored.

## Step 5 — Create your first project

Open your Telegram group, go to the **General** topic, and send:

```
/new myproject ~/path/to/some/project
```

(swap in a real project directory on the host machine). This creates a new
forum topic for it — every message you send in that topic goes straight to a
Claude Code session running in that directory.

## Step 6 — Send your first message

In the new topic, send anything — a question about the project, or just
"hello". What good looks like:

- Telegram shows a typing indicator almost immediately.
- Within a few seconds to a couple minutes (depending on the task), Claude
  replies in the topic.
- `/status` in that topic shows the session running, with a model and
  permission mode set.

Send `/help` any time for the full command list — there's a lot more than
chatting: scheduling recurring runs, switching models, screenshotting URLs,
and driving emulators/simulators.

## Logs

If something doesn't look right, the daemon log usually explains why:

```bash
tail -f ~/.teleclaude/logs/teleclaude.log
```

It rotates at 10MB and is kept private (0600) since it can contain message
content.

## Getting help

Run `npx tsx src/index.ts doctor` first — it pinpoints most setup problems on
its own. If that doesn't explain it, open a GitHub issue with the doctor
output, your `claude --version`, and the relevant log lines.
