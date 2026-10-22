/**
 * Turn-level render state for the channel server.
 *
 * Supersedes `ReplyState` (src/reply-state.ts, deleted in a later task once
 * the channel server switches over). Preserves ReplyState's phase/task
 * contract verbatim and adds two new concerns:
 *
 *   - narration: incremental "thinking out loud" text chunks, assembled by
 *     (message, index) into a live tail shown while a phase is still open.
 *   - tool outcomes: a `toolFinished` event is matched back to the
 *     `toolStarted` line it belongs to (by scope + fingerprint) so the
 *     rendered tool line can grow a "✓ (Ns)" / "❌ <snippet>" suffix.
 *
 * Rendered layout (unchanged from ReplyState, narration inserted before the
 * live tool lines):
 *   [task list]          ← pinned at top if tasks are active
 *   [phase 1 tools + reply]
 *   [phase 2 tools + reply]
 *   ...
 *   [💬 narration tail]  ← in-progress phase, no reply yet
 *   [current tools]      ← in-progress phase, no reply yet
 *
 * Pure module: no I/O, no Telegram, no HTML escaping.
 */

export interface ReplyTask { subject: string; status: "pending" | "done" }
/** Snapshot for rollback. Tasks are intentionally excluded — rollback never touches them. */
export interface ReplySnapshot { phases: string[]; tools: string[] }

/**
 * Channel-server-wide live-rendering mode (Task 5): "full" keeps every
 * detail live, "summary" collapses the message to renderFinal("summary") at
 * turn end (subject to shouldCollapse's background-agent grace window). "off"
 * takes the same detailed-render path as "full" at turn end — no summary
 * collapse — and only additionally gates narration off; tool outcomes and
 * agent rows still render in "off" mode.
 *
 * Phase collapse (channel-server sets `TurnView.phaseCollapse = liveMode !==
 * "off"`): in "full"/"summary" a CLOSED phase renders as one collapsed
 * "▸ N tools · M agents · Ns" line above its reply, instead of its full
 * tool-line header — the still-running phase is unaffected, it always keeps
 * full detail. "off" keeps the classic uncollapsed per-phase rendering,
 * matching its documented "old behavior" contract.
 */
export type LiveViewMode = "full" | "summary" | "off";
/** Single source of truth for validation/iteration (session-state.ts, commands.ts). */
export const LIVE_VIEW_MODES: readonly LiveViewMode[] = ["full", "summary", "off"];

/** A tool invocation as reported by the PreToolUse/tool_use hook. */
export interface ToolStart {
  toolName: string;
  /** Stable identity for matching a later outcome — see makeFingerprint. */
  fingerprint: string;
  /** Pre-rendered display line, e.g. "🔧 Bash: ls". */
  line: string;
  /** Present for a subagent's tool call; absent (or undefined) means main scope. */
  agentId?: string;
}

/** A tool completion as reported by the PostToolUse hook. */
export interface ToolOutcome {
  toolName: string;
  fingerprint: string;
  ok?: boolean;
  errorSnippet?: string;
  durationMs?: number;
  agentId?: string;
}

/** One streamed narration delta. */
export interface NarrationChunk {
  delta: string;
  index: number;
  final: boolean;
  messageId: string;
  promptId: string;
}

interface NarrationMsg { chunks: Map<number, string>; final: boolean }
interface ToolLine { line: string; scope: string; fingerprint: string; outcome?: string }

/**
 * A completed phase, stored structurally (not as a single frozen string) so
 * renderFinal("summary") can emit `replyText` alone, without the tool
 * header. `toolHeader` is "" when the phase had no live tools when it
 * closed. `toolCount`/`agentCount` are the phase's own per-phase counters
 * (see TurnView.toolStarted/agentStarted) snapshotted at closePhase() time,
 * and `durationMs` is set only when closePhase() was called with a `now` —
 * together they drive the phaseCollapse "▸ N tools · M agents · Ns" line
 * (see phaseCollapsedText). A phase produced by restore() (see
 * ReplySnapshot below) always has an empty toolHeader AND toolCount=0,
 * agentCount=0, durationMs=undefined — snapshot() only hands back the
 * already-combined flat string, so there is no header/counters to recover;
 * that combined string is kept as replyText, which reproduces the exact
 * same `render()` output as before (renderFinal("summary") on a restored
 * phase would then include the header text too — restore is a rollback
 * path, not a summary path, so this is an accepted trade-off, not a
 * contract violation) AND — since toolCount/agentCount are both 0 —
 * phaseCollapsedText renders it as plain replyText with no ▸ line, so a
 * restored phase never gains a collapsed summary it has no data for.
 */
interface Phase { toolHeader: string; replyText: string; toolCount: number; agentCount: number; durationMs?: number }

/**
 * One subagent row. `background` marks a row that survived a `reset()`
 * while still running (rendered in the detached "— background —" section
 * instead of being deleted alongside the rest of the turn's state).
 * `agentType` may be the PLACEHOLDER_AGENT_TYPE sentinel when the row was
 * upserted from a tool/label/stop event that arrived before SubagentStart —
 * a later agentStarted() upgrades it to the real type.
 */
interface AgentRow {
  agentType: string;
  label?: string;
  running: boolean;
  /** First line of the stop message, capped — set once, on the transition to stopped. */
  finalExcerpt?: string;
  background: boolean;
}

const NARRATION_TAIL = 400;
const SLOW_TOOL_MS = 2000;
const MAIN_SCOPE = "main";
const AGENT_EXCERPT_MAX = 100;
const MAX_AGENT_ROWS = 4;
const MAX_AGENT_NESTED = 3;
/** Stand-in type for a row upserted from an event that isn't SubagentStart. */
const PLACEHOLDER_AGENT_TYPE = "agent";
/**
 * render() output cap, source chars (pre-HTML-escaping — TurnView stays
 * pure and has no HTML awareness). Headroom under Telegram's 4096 after
 * entity expansion, matching HTML_SAFE_LEN's role in channel-server.ts.
 */
const MAX_RENDER_CHARS = 3500;
const TEN_MINUTES_MS = 10 * 60_000;

/** "45s" under a minute, "2m 45s" at or above. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s}s`;
}

/** "1 tool" / "3 tools" — shared by the phase-collapse line and the receipt line, both of which count tools/agents. */
function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Deterministic identity for a tool call, used to match a later ToolOutcome
 * back to the ToolStart line it belongs to. Same tool name + same input
 * (independent of key order) always produces the same fingerprint.
 */
export function makeFingerprint(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${stableStringify(input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export class TurnView {
  private completedPhases: Phase[] = [];
  private toolLines: ToolLine[] = [];
  private readonly taskList = new Map<string, ReplyTask>();
  /** Insertion order tracks arrival order — render walks it in that order. */
  private readonly agents = new Map<string, AgentRow>();

  // Narration: chunks land keyed by messageId, each holding a per-index map.
  // Map insertion order tracks arrival order of each message's first chunk,
  // so "newest message" is simply the last entry.
  private narrationMsgs = new Map<string, NarrationMsg>();
  // Only chunks for the "current" prompt segment are accepted; a chunk for a
  // prompt id we've already moved past (present in seenPrompts but not the
  // current one) is a late/stale delivery from a superseded segment and is
  // dropped. An id we've never seen becomes the new current segment (e.g. an
  // async sub-agent wake) and clears prior narration. promptId is an opaque
  // UUID with no ordering signal (real payloads have been observed where a
  // later-arriving id sorts lexicographically lower than an earlier one), so
  // membership — not comparison — is the only safe staleness test.
  private currentPromptId: string | null = null;
  private seenPrompts = new Set<string>();

  private turnStartedAtMs = 0;
  private turnToolCountValue = 0;
  /** Distinct agent ids seen this turn (any event referencing one), for the receipt's "M agents". */
  private readonly turnAgentIds = new Set<string>();
  /** Stamped by noteDone(); drives shouldCollapse's 10-minute grace window. */
  private lastDoneAtMs = 0;

  /**
   * Per-phase counters (reset on both turnStarted() and closePhase()) that
   * feed the phaseCollapse "▸ N tools · M agents · Ns" line — see
   * toolStarted/agentStarted/closePhase.
   */
  private phaseToolCountValue = 0;
  private readonly phaseAgentIds = new Set<string>();
  /** Stamped by turnStarted(now) and refreshed by every closePhase(text, now). */
  private phaseStartedAtMs = 0;

  /**
   * Whether a CLOSED phase renders as a collapsed "▸ N tools · M agents ·
   * Ns" line above its reply, instead of its full tool-line header. Default
   * true, matching the "summary" live-view mode's default; the channel
   * server sets this explicitly at spawn and on every /live-mode switch
   * (false for "off" — see the LiveViewMode doc above). Public and mutable:
   * a mode switch is a live toggle, not a reconstruction of TurnView.
   */
  phaseCollapse = true;

  constructor(private maxTools = 5) {}

  // ---- turn counters (for the /receipts feature, Task 3) ----------------

  /** Stamp the turn's start time and reset the per-turn AND per-phase tool/agent counters. */
  turnStarted(now: number): void {
    this.turnStartedAtMs = now;
    this.turnToolCountValue = 0;
    this.turnAgentIds.clear();
    this.phaseStartedAtMs = now;
    this.phaseToolCountValue = 0;
    this.phaseAgentIds.clear();
  }

  get turnStartedAt(): number { return this.turnStartedAtMs; }
  /** Tools started this turn. NOT reset by clearTools — only by turnStarted. */
  get turnToolCount(): number { return this.turnToolCountValue; }
  /** Distinct agent ids seen this turn. NOT reset by reset() — only by turnStarted. */
  get turnAgentCount(): number { return this.turnAgentIds.size; }

  /** Stamp the moment the turn finished — shouldCollapse measures elapsed time from here. */
  noteDone(now: number): void {
    this.lastDoneAtMs = now;
  }

  /**
   * Whether the live message may collapse to its terminal (summary/full)
   * form. Held back while an agent is still running AND it's been under 10
   * minutes since the turn finished — long enough for a background agent's
   * own updates to still be worth showing live, but bounded so a forgotten
   * background agent can't pin the message open forever.
   */
  shouldCollapse(now: number): boolean {
    return !(this.runningAgentCount > 0 && now - this.lastDoneAtMs < TEN_MINUTES_MS);
  }

  // ---- tools --------------------------------------------------------------

  private mainLines(): ToolLine[] {
    return this.toolLines.filter((l) => l.scope === MAIN_SCOPE);
  }

  private nonMainLines(): ToolLine[] {
    return this.toolLines.filter((l) => l.scope !== MAIN_SCOPE);
  }

  private agentLines(agentId: string): ToolLine[] {
    return this.toolLines.filter((l) => l.scope === agentId);
  }

  toolStarted(t: ToolStart): void {
    this.turnToolCountValue++;
    this.phaseToolCountValue++; // ALL scopes — nested agent tools count toward "N tools" too
    if (t.agentId) this.turnAgentIds.add(t.agentId);
    const scope = t.agentId ?? MAIN_SCOPE;
    // A tool call for an agent we've never seen SubagentStart for (out-of-order
    // hook delivery) still needs somewhere to render — upsert a placeholder row.
    if (t.agentId && !this.agents.has(t.agentId)) {
      this.agents.set(t.agentId, { agentType: PLACEHOLDER_AGENT_TYPE, running: true, background: false });
    }
    this.toolLines.push({ line: t.line, scope, fingerprint: t.fingerprint });
    if (scope === MAIN_SCOPE) {
      if (this.mainLines().length > this.maxTools) {
        const oldest = this.toolLines.findIndex((l) => l.scope === MAIN_SCOPE);
        this.toolLines.splice(oldest, 1);
      }
    } else if (this.agentLines(scope).length > MAX_AGENT_NESTED) {
      const oldest = this.toolLines.findIndex((l) => l.scope === scope);
      this.toolLines.splice(oldest, 1);
    }
  }

  /** Match an outcome to the oldest unfinished tool line with the same (scope, fingerprint). */
  toolFinished(o: ToolOutcome): void {
    const scope = o.agentId ?? MAIN_SCOPE;
    const line = this.toolLines.find((l) => l.scope === scope && l.fingerprint === o.fingerprint && l.outcome === undefined);
    if (!line) return; // unmatched (before any start, wrong fingerprint, or already matched) — show nothing, never guess
    // `||`, not `??`: an empty snippet must also fall back to "failed" — a
    // dangling "· ❌ " with nothing after it is not a useful outcome.
    if (o.ok === false) line.outcome = ` · ❌ ${o.errorSnippet || "failed"}`;
    else if (o.ok === true && (o.durationMs ?? 0) >= SLOW_TOOL_MS) line.outcome = ` · ✓ (${Math.round((o.durationMs ?? 0) / 1000)}s)`;
    // ok === undefined, or a fast success, renders no outcome.
  }

  // ---- subagents ------------------------------------------------------

  private static excerptOf(msg: string | undefined): string {
    if (!msg) return "";
    const firstLine = msg.split("\n", 1)[0] ?? "";
    return firstLine.length > AGENT_EXCERPT_MAX ? firstLine.slice(0, AGENT_EXCERPT_MAX) : firstLine;
  }

  /** SubagentStart. Upserts: a placeholder row (from an earlier tool/label/stop
   * event) has its type filled in; a genuine duplicate start is a no-op — it
   * never revives an already-stopped row or resets a running one. */
  agentStarted(agentId: string, agentType: string): void {
    this.turnAgentIds.add(agentId);
    this.phaseAgentIds.add(agentId); // Set — a duplicate/upsert start for an existing id never double-counts
    const existing = this.agents.get(agentId);
    if (!existing) {
      this.agents.set(agentId, { agentType, running: true, background: false });
      return;
    }
    if (existing.agentType === PLACEHOLDER_AGENT_TYPE) existing.agentType = agentType;
  }

  /** The Agent tool's PostToolUse description, arriving before or after SubagentStart. */
  agentLabel(agentId: string, label: string): void {
    this.turnAgentIds.add(agentId);
    const existing = this.agents.get(agentId);
    if (existing) { existing.label = label; return; }
    this.agents.set(agentId, { agentType: PLACEHOLDER_AGENT_TYPE, label, running: true, background: false });
  }

  /** SubagentStop. Upserts: stop-before-start creates an already-stopped row;
   * a duplicate stop (already stopped) is a no-op that keeps the first result. */
  agentStopped(agentId: string, lastMessage?: string): void {
    this.turnAgentIds.add(agentId);
    const excerpt = TurnView.excerptOf(lastMessage);
    const existing = this.agents.get(agentId);
    if (!existing) {
      this.agents.set(agentId, { agentType: PLACEHOLDER_AGENT_TYPE, running: false, finalExcerpt: excerpt, background: false });
      return;
    }
    if (!existing.running) return; // duplicate stop
    existing.running = false;
    existing.finalExcerpt = excerpt;
    this.toolLines = this.toolLines.filter((l) => l.scope !== agentId); // nested lines are dropped
  }

  get runningAgentCount(): number {
    let n = 0;
    for (const row of this.agents.values()) if (row.running) n++;
    return n;
  }

  /**
   * Pick which agent rows render, capped at MAX_AGENT_ROWS **combined across
   * both the current-turn and background sections** — this is a Telegram
   * message-size budget, not a per-section allowance, so a busy session
   * with agents in both sections still renders at most MAX_AGENT_ROWS rows
   * total. Priority: every running row beats every completed row; within
   * the same status, a current-section row beats a background one; within
   * a bucket that still needs trimming, oldest is evicted first.
   */
  private selectVisibleAgents(): { currentVisible: string[]; backgroundVisible: string[]; hiddenCount: number } {
    const currentIds = [...this.agents.keys()].filter((id) => !this.agents.get(id)!.background);
    const backgroundIds = [...this.agents.keys()].filter((id) => this.agents.get(id)!.background);
    const total = currentIds.length + backgroundIds.length;
    if (total <= MAX_AGENT_ROWS) return { currentVisible: currentIds, backgroundVisible: backgroundIds, hiddenCount: 0 };

    const buckets = [
      currentIds.filter((id) => this.agents.get(id)!.running),
      backgroundIds.filter((id) => this.agents.get(id)!.running),
      currentIds.filter((id) => !this.agents.get(id)!.running),
      backgroundIds.filter((id) => !this.agents.get(id)!.running),
    ];
    const visible = new Set<string>();
    let remaining = MAX_AGENT_ROWS;
    for (const bucket of buckets) {
      if (remaining <= 0) break;
      const take = bucket.length <= remaining ? bucket : bucket.slice(-remaining); // oldest evicted first
      for (const id of take) visible.add(id);
      remaining -= take.length;
    }
    return {
      currentVisible: currentIds.filter((id) => visible.has(id)),
      backgroundVisible: backgroundIds.filter((id) => visible.has(id)),
      hiddenCount: total - visible.size,
    };
  }

  private agentHeaderText(id: string, row: AgentRow): string {
    // Unlabeled rows are ambiguous among same-type agents — the id disambiguates
    // until a real label lands, after which it's dropped as redundant noise.
    const idSuffix = row.label === undefined ? ` · ${id}` : "";
    if (row.running) {
      const core = row.label
        ? `🤖 ${row.agentType}: ${row.label} — running`
        : `🤖 ${row.agentType} — running`;
      return core + idSuffix;
    }
    const name = row.label ?? row.agentType;
    const core = row.finalExcerpt ? `🤖 ${name} ✓ ${row.finalExcerpt}` : `🤖 ${name} ✓`;
    return core + idSuffix;
  }

  /**
   * `nestedOf` is injected (rather than reading `this.toolLines` directly)
   * so the budget trimmer in applyBudget() can render against a shrunk
   * working copy of nested lines without mutating real state.
   */
  private renderAgentRow(id: string, nestedOf: (agentId: string) => ToolLine[]): string {
    const row = this.agents.get(id)!;
    const header = this.agentHeaderText(id, row);
    if (!row.running) return header; // stopped: no nested lines
    const nested = nestedOf(id).map((l) => `   ${l.line}${l.outcome ?? ""}`);
    return nested.length > 0 ? `${header}\n${nested.join("\n")}` : header;
  }

  private renderAgentLines(ids: string[], nestedOf: (agentId: string) => ToolLine[]): string[] {
    return ids.map((id) => this.renderAgentRow(id, nestedOf));
  }

  clearTools(): void {
    this.toolLines = this.nonMainLines();
  }

  // ---- narration ------------------------------------------------------

  narration(c: NarrationChunk): void {
    // Known accepted corner case: a stale chunk from a prompt segment that
    // never narrated before now — arriving after the next segment already
    // began — is indistinguishable from a legitimate new segment (no
    // ordering info in the payload) and will wrongly become current. This
    // is self-correcting and bounded: the cost is one wrong narration tail
    // until the live segment's next chunk arrives, never permanent loss —
    // unlike silently dropping a real new segment would be.
    if (c.promptId !== this.currentPromptId) {
      if (this.seenPrompts.has(c.promptId)) return; // stale — already superseded
      this.currentPromptId = c.promptId;
      this.seenPrompts.add(c.promptId);
      this.narrationMsgs.clear();
    }
    let msg = this.narrationMsgs.get(c.messageId);
    if (!msg) {
      msg = { chunks: new Map(), final: false };
      this.narrationMsgs.set(c.messageId, msg);
    }
    if (msg.chunks.has(c.index)) return; // duplicate delivery
    msg.chunks.set(c.index, c.delta);
    if (c.final) msg.final = true;
  }

  private narrationTail(): string | null {
    const entries = [...this.narrationMsgs.values()];
    const last = entries[entries.length - 1];
    if (!last) return null;
    const text = [...last.chunks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, delta]) => delta)
      .join("");
    if (!text.trim()) return null;
    return text.length > NARRATION_TAIL ? "…" + text.slice(-NARRATION_TAIL) : text;
  }

  // ---- phases -------------------------------------------------------------

  /**
   * Freeze current tools + reply text together as a completed phase; drop
   * narration (the reply is its polished version). Stored structurally —
   * see the Phase interface — so renderFinal("summary") can emit `text`
   * alone, without the tool header. `now`, when provided, stamps the
   * phase's durationMs (elapsed since the last turnStarted()/closePhase())
   * and refreshes the phase-start clock for the NEXT phase; omitted (legacy
   * callers, tests) the phase simply carries no duration segment and the
   * phase-start clock is left as-is.
   */
  closePhase(text: string, now?: number): void {
    this.narrationMsgs.clear();
    const mainLines = this.mainLines();
    const header = mainLines.length > 0 ? mainLines.map((l) => l.line + (l.outcome ?? "")).join("\n") : "";
    this.completedPhases.push({
      toolHeader: header,
      replyText: text,
      toolCount: this.phaseToolCountValue,
      agentCount: this.phaseAgentIds.size,
      durationMs: now !== undefined ? now - this.phaseStartedAtMs : undefined,
    });
    this.toolLines = this.nonMainLines();
    this.phaseToolCountValue = 0;
    this.phaseAgentIds.clear();
    if (now !== undefined) this.phaseStartedAtMs = now;
  }

  /** Reassembles a Phase into the same flat string ReplyState/render() has always emitted. */
  private static phaseFullText(p: Phase): string {
    return p.toolHeader ? `${p.toolHeader}\n\n${p.replyText}` : p.replyText;
  }

  /**
   * The phaseCollapse-mode "▸ N tools · M agents · Ns" summary line for a
   * closed phase — null when there's nothing worth a line (toolCount and
   * agentCount both 0, e.g. a pure-text phase, or a restore()d phase which
   * always has both at 0 — see the Phase interface doc). "N tools" always
   * shows when the line renders at all; " · M agents" only when M > 0;
   * " · Ns" only when durationMs was recorded.
   */
  private static phaseCollapsedLine(p: Phase): string | null {
    if (p.toolCount === 0 && p.agentCount === 0) return null;
    const agentsPart = p.agentCount > 0 ? ` · ${pluralize(p.agentCount, "agent")}` : "";
    const durationPart = p.durationMs !== undefined ? ` · ${formatDuration(p.durationMs)}` : "";
    return `▸ ${pluralize(p.toolCount, "tool")}${agentsPart}${durationPart}`;
  }

  /**
   * phaseCollapse-mode rendering of a closed phase: the collapsed line (if
   * any) above the reply text. A phase with no line (see
   * phaseCollapsedLine) renders as plain replyText — identical to
   * phaseFullText for a phase whose toolHeader was already empty, which is
   * exactly the restore()d-phase case.
   */
  private static phaseCollapsedText(p: Phase): string {
    const line = TurnView.phaseCollapsedLine(p);
    return line ? `${line}\n${p.replyText}` : p.replyText;
  }

  /** Drop history except the newest phase — used when starting a new Telegram message. */
  /**
   * The live message was frozen and output continues in a new one (an
   * ask_user question was posted in between): drop what that frozen message
   * already shows — completed phases, the open phase's main tool lines and
   * narration. Tasks and agent rows are live status, not history, so they
   * carry over to the new message.
   */
  dropShown(): void {
    this.completedPhases.length = 0;
    this.toolLines = this.nonMainLines();
    this.narrationMsgs.clear();
  }

  keepLastPhase(): void {
    const last = this.completedPhases[this.completedPhases.length - 1];
    this.completedPhases.length = 0;
    if (last !== undefined) this.completedPhases.push(last);
  }

  /**
   * Full reset on new inbound user message. Agent state is NOT wiped like
   * everything else: a still-running agent row survives into a detached
   * "background" section (its late events keep updating it); anything
   * already resolved — a row that finished during the turn just ending, or
   * a background row that has since stopped — is dropped now, one reset()
   * after it stopped.
   */
  reset(): void {
    this.completedPhases.length = 0;
    this.taskList.clear();
    this.narrationMsgs.clear();
    this.currentPromptId = null;
    this.seenPrompts.clear();

    for (const [id, row] of this.agents) {
      if (row.background) {
        if (!row.running) this.agents.delete(id);
      } else if (row.running) {
        row.background = true;
      } else {
        this.agents.delete(id);
      }
    }
    this.toolLines = this.toolLines.filter(
      (l) => l.scope !== MAIN_SCOPE && this.agents.get(l.scope)?.background === true,
    );
  }

  /** Wire shape unchanged (ask-relay contract): flat, already-combined phase strings. */
  snapshot(): ReplySnapshot {
    return {
      phases: this.completedPhases.map(TurnView.phaseFullText),
      tools: this.mainLines().map((l) => l.line + (l.outcome ?? "")),
    };
  }

  /**
   * A restored phase's tool header is unrecoverable from the flat wire
   * shape (see the Phase interface doc) — it's kept whole as replyText
   * with an empty toolHeader, which reproduces render()'s prior output
   * exactly. Restore is a rollback path (failed send retry), not a
   * summary path, so this doesn't affect renderFinal("summary")'s
   * contract for phases closed normally via closePhase().
   */
  restore(s: ReplySnapshot): void {
    this.completedPhases = s.phases.map((text) => ({ toolHeader: "", replyText: text, toolCount: 0, agentCount: 0 }));
    this.toolLines = this.nonMainLines();
    this.toolLines.push(...s.tools.map((line) => ({ line, scope: MAIN_SCOPE, fingerprint: "" })));
  }

  // ---- tasks --------------------------------------------------------------

  /** Track a new task (pinned at the top of the rendered message). */
  taskCreated(key: string, subject: string): void {
    this.taskList.set(key, { subject, status: "pending" });
  }

  /** Mark a task done (upserts if unknown). */
  taskCompleted(key: string, subject: string): void {
    const existing = this.taskList.get(key);
    if (existing) existing.status = "done";
    else this.taskList.set(key, { subject, status: "done" });
  }

  get phaseCount(): number { return this.completedPhases.length; }
  get toolCount(): number { return this.mainLines().length; }
  get taskCount(): number { return this.taskList.size; }

  /**
   * Builds the same layout render() has always produced, but from explicit
   * working copies of the trimmable sections (main tool lines, nested agent
   * tool lines, completed phases) plus a narration on/off switch — so
   * applyBudget() can shrink those copies and re-render without touching
   * real state. Task list, agent header rows, and the "+N more"/background
   * sections are NOT trimmable per the budget's spec and always come from
   * live state.
   */
  private composeRender(
    mainLines: ToolLine[],
    nestedLines: ToolLine[],
    phases: Phase[],
    includeNarration: boolean,
  ): string {
    const nestedOf = (agentId: string) => nestedLines.filter((l) => l.scope === agentId);
    const parts: string[] = [];
    if (this.taskList.size > 0) {
      parts.push([...this.taskList.values()]
        .map((t) => (t.status === "done" ? `✅ ${t.subject}` : `📋 ${t.subject}`))
        .join("\n"));
    }
    const phaseText = this.phaseCollapse ? TurnView.phaseCollapsedText : TurnView.phaseFullText;
    parts.push(...phases.map(phaseText));
    if (includeNarration) {
      const tail = this.narrationTail();
      if (tail !== null) parts.push(`💬 ${tail}`);
    }

    const backgroundExists = [...this.agents.values()].some((row) => row.background);
    const { currentVisible, backgroundVisible, hiddenCount } = this.selectVisibleAgents();
    const currentAgentLines = this.renderAgentLines(currentVisible, nestedOf);
    const backgroundAgentLines = this.renderAgentLines(backgroundVisible, nestedOf);
    // One combined "+N more" line for the whole (global) cap — attached to
    // whichever section renders last, so it always appears exactly once.
    if (hiddenCount > 0) {
      const moreLine = `+${hiddenCount} more agents`;
      if (backgroundExists) backgroundAgentLines.push(moreLine);
      else currentAgentLines.push(moreLine);
    }

    const currentBlock = [
      ...mainLines.map((l) => l.line + (l.outcome ?? "")),
      ...currentAgentLines,
    ];
    if (currentBlock.length > 0) parts.push(currentBlock.join("\n"));

    if (backgroundExists) {
      parts.push(["— background —", ...backgroundAgentLines].join("\n"));
    }

    return parts.join("\n\n");
  }

  /**
   * Enforces the MAX_RENDER_CHARS budget by trimming, in order, WHOLE
   * lines/sections only (never mid-entity): narration tail → oldest nested
   * agent lines (one at a time, across all agents in original insertion
   * order) → oldest main tool lines (one at a time) → oldest completed
   * phases (one at a time). Each step is exhausted before the next begins.
   * Length is measured on the composed source text — TurnView has no HTML
   * awareness, so this is deliberately pre-escaping.
   */
  private applyBudget(): string {
    const mainLines = this.mainLines();
    const nestedLines = this.nonMainLines();
    const phases = this.completedPhases;

    let out = this.composeRender(mainLines, nestedLines, phases, true);
    if (out.length <= MAX_RENDER_CHARS) return out;

    out = this.composeRender(mainLines, nestedLines, phases, false);
    if (out.length <= MAX_RENDER_CHARS) return out;

    let nested = nestedLines;
    while (nested.length > 0) {
      nested = nested.slice(1); // drop oldest
      out = this.composeRender(mainLines, nested, phases, false);
      if (out.length <= MAX_RENDER_CHARS) return out;
    }

    let main = mainLines;
    while (main.length > 0) {
      main = main.slice(1);
      out = this.composeRender(main, nested, phases, false);
      if (out.length <= MAX_RENDER_CHARS) return out;
    }

    let remainingPhases = phases;
    while (remainingPhases.length > 0) {
      remainingPhases = remainingPhases.slice(1);
      out = this.composeRender(main, nested, remainingPhases, false);
      if (out.length <= MAX_RENDER_CHARS) return out;
    }

    return out; // everything trimmable is gone — best effort, over budget
  }

  render(): string {
    return this.applyBudget();
  }

  /**
   * Uncapped composition — for actual message DELIVERY (ReplyDelivery),
   * never for the live activity view. render()'s MAX_RENDER_CHARS budget
   * exists to keep an in-progress live status line bounded; it must never
   * silently truncate — or, worse, empty out entirely when a single phase
   * alone exceeds the budget — the actual reply text a user is waiting on.
   * ReplyDelivery's own "> htmlSafeLen → roll over to a new message" logic
   * and sendLong's chunk-splitting are what bound delivery output; this
   * method must stay uncapped so that logic ever sees the true length.
   */
  renderFull(): string {
    return this.composeRender(this.mainLines(), this.nonMainLines(), this.completedPhases, true);
  }

  /**
   * Turn-end rendering. "full" is render() as-is — full detail is meant to
   * be full, budget cap included. "summary" collapses to just the reply
   * text of every completed phase this turn (scaffolding — task list, tool
   * lines, narration, agent rows — all dropped) plus a one-line receipt.
   */
  renderFinal(mode: "full" | "summary", now: number): string {
    if (mode === "full") return this.render();
    const body = this.completedPhases
      .map((p) => p.replyText)
      .filter((t) => t.length > 0)
      .join("\n\n");
    const receipt = this.receiptLine(now);
    return body.length > 0 ? `${body}\n\n${receipt}` : receipt;
  }

  private receiptLine(now: number): string {
    const duration = formatDuration(now - this.turnStartedAtMs);
    const agents = this.turnAgentIds.size;
    const agentsSuffix = agents > 0 ? ` · 🤖 ${pluralize(agents, "agent")}` : "";
    return `⏱ ${duration} · 🔧 ${pluralize(this.turnToolCountValue, "tool")}${agentsSuffix}`;
  }
}
