import { describe, expect, it, beforeEach } from "vitest";
import { TurnView, makeFingerprint } from "./turn-view.js";

const bash = (cmd: string) => ({
  toolName: "Bash",
  fingerprint: makeFingerprint("Bash", { command: cmd }),
  line: `🔧 Bash: ${cmd}`,
});

// -----------------------------------------------------------------------
// Ported from reply-state.test.ts: TurnView must preserve ReplyState's
// existing phase/task/tool behavior verbatim (via toolStarted instead of
// addTool, using dummy fingerprints since these tests never call
// toolFinished).
// -----------------------------------------------------------------------
describe("TurnView — ported ReplyState behaviors", () => {
  let state: TurnView;
  let n = 0;
  const tool = (line: string) => ({ toolName: "X", fingerprint: `fp${n++}`, line });
  // These tests assert ReplyState's classic, uncollapsed phase rendering —
  // exactly what phaseCollapse=false (the "off" mode contract) reproduces.
  beforeEach(() => { state = new TurnView(5); state.phaseCollapse = false; n = 0; });

  it("renders tools then freezes them into a phase on closePhase", () => {
    state.toolStarted(tool("⚙️ Bash: ls"));
    state.toolStarted(tool("📖 Reading: foo.ts"));
    expect(state.render()).toBe("⚙️ Bash: ls\n📖 Reading: foo.ts");

    state.closePhase("Done looking.");
    expect(state.render()).toBe("⚙️ Bash: ls\n📖 Reading: foo.ts\n\nDone looking.");
    expect(state.toolCount).toBe(0);
  });

  it("keeps phases in order and renders live tools last", () => {
    state.closePhase("Phase one.");
    state.toolStarted(tool("⚙️ Bash: npm test"));
    expect(state.render()).toBe("Phase one.\n\n⚙️ Bash: npm test");
  });

  it("caps live tools at the configured max", () => {
    for (let i = 1; i <= 7; i++) state.toolStarted(tool(`tool ${i}`));
    expect(state.render()).toBe("tool 3\ntool 4\ntool 5\ntool 6\ntool 7");
  });

  it("closePhase without tools is just the text", () => {
    state.closePhase("Hello.");
    expect(state.render()).toBe("Hello.");
  });

  it("keepLastPhase drops history except the newest phase", () => {
    state.closePhase("One.");
    state.closePhase("Two.");
    state.closePhase("Three.");
    state.keepLastPhase();
    expect(state.render()).toBe("Three.");
    expect(state.phaseCount).toBe(1);
  });

  it("snapshot/restore round-trips for rollback", () => {
    state.closePhase("Kept.");
    state.toolStarted(tool("live tool"));
    const snap = state.snapshot();

    state.closePhase("Failed send.");
    state.restore(snap);
    expect(state.render()).toBe("Kept.\n\nlive tool");
  });

  it("renders task list pinned on top", () => {
    state.taskCreated("a", "Build it");
    state.taskCompleted("b", "Ship it");
    state.closePhase("Working.");
    expect(state.render()).toBe("📋 Build it\n✅ Ship it\n\nWorking.");
  });

  it("taskCompleted marks an existing task done", () => {
    state.taskCreated("a", "Build it");
    state.taskCompleted("a", "Build it");
    expect(state.render()).toBe("✅ Build it");
  });

  it("reset clears everything", () => {
    state.taskCreated("a", "X");
    state.closePhase("One.");
    state.toolStarted(tool("t"));
    state.reset();
    expect(state.render()).toBe("");
    expect(state.taskCount).toBe(0);
  });

  it("clearTools drops live tools but keeps phases", () => {
    state.closePhase("Done.");
    state.toolStarted(tool("t"));
    state.clearTools();
    expect(state.render()).toBe("Done.");
  });
});

// -----------------------------------------------------------------------
// New TurnView behaviors: narration accumulation + tool-outcome matching.
// -----------------------------------------------------------------------
describe("narration", () => {
  it("assembles chunks by index and shows the newest message's tail", () => {
    const v = new TurnView();
    v.turnStarted(0);
    v.narration({ delta: "world", index: 1, final: true, messageId: "m1", promptId: "p1" });
    v.narration({ delta: "hello ", index: 0, final: false, messageId: "m1", promptId: "p1" });
    expect(v.render()).toContain("💬 hello world");
    v.narration({ delta: "newer", index: 0, final: true, messageId: "m2", promptId: "p1" });
    expect(v.render()).toContain("💬 newer");
    expect(v.render()).not.toContain("hello world");
  });
  it("drops stale-prompt chunks and duplicate indices", () => {
    const v = new TurnView();
    v.narration({ delta: "old segment", index: 0, final: true, messageId: "m0", promptId: "p1" });
    v.narration({ delta: "current", index: 0, final: true, messageId: "m1", promptId: "p2" });
    v.narration({ delta: "stale late chunk", index: 1, final: true, messageId: "m0", promptId: "p1" });
    v.narration({ delta: "dupe", index: 0, final: true, messageId: "m1", promptId: "p2" });
    expect(v.render()).toContain("current");
    expect(v.render()).not.toContain("stale late chunk");
    expect(v.render()).not.toContain("dupe");
  });
  it("closePhase drops narration, keeps reply text", () => {
    const v = new TurnView();
    v.narration({ delta: "thinking out loud", index: 0, final: true, messageId: "m1", promptId: "p1" });
    v.closePhase("the polished answer");
    expect(v.render()).toContain("the polished answer");
    expect(v.render()).not.toContain("thinking out loud");
  });
  it("truncates a long narration to the last 400 chars, with an ellipsis prefix", () => {
    const v = new TurnView();
    const long = "x".repeat(500);
    v.narration({ delta: long, index: 0, final: true, messageId: "m1", promptId: "p1" });
    const rendered = v.render();
    expect(rendered).toContain("💬 …" + "x".repeat(400));
    expect(rendered).not.toContain("x".repeat(401));
  });
  it("a blank/whitespace-only assembled message renders nothing", () => {
    const v = new TurnView();
    v.narration({ delta: "   ", index: 0, final: true, messageId: "m1", promptId: "p1" });
    expect(v.render()).toBe("");
  });
});

describe("outcome matching", () => {
  it("matches by fingerprint, not order, for concurrent same-name tools", () => {
    const v = new TurnView();
    v.toolStarted(bash("slow-a"));
    v.toolStarted(bash("fast-b"));
    v.toolFinished({ toolName: "Bash", fingerprint: makeFingerprint("Bash", { command: "fast-b" }), ok: false, errorSnippet: "boom" });
    expect(v.render()).toContain("🔧 Bash: fast-b · ❌ boom");
    expect(v.render()).toMatch(/🔧 Bash: slow-a$/m); // untouched — no outcome appended
  });
  it("hides fast successes, shows slow ones", () => {
    const v = new TurnView();
    v.toolStarted(bash("quick"));
    v.toolFinished({ toolName: "Bash", fingerprint: makeFingerprint("Bash", { command: "quick" }), ok: true, durationMs: 300 });
    expect(v.render()).not.toContain("✓");
    v.toolStarted(bash("slow"));
    v.toolFinished({ toolName: "Bash", fingerprint: makeFingerprint("Bash", { command: "slow" }), ok: true, durationMs: 4200 });
    expect(v.render()).toContain("· ✓ (4s)");
  });
  it("falls back to 'failed' when errorSnippet is an empty string, not just undefined", () => {
    const v = new TurnView();
    v.toolStarted(bash("empty-snippet"));
    v.toolFinished({ toolName: "Bash", fingerprint: makeFingerprint("Bash", { command: "empty-snippet" }), ok: false, errorSnippet: "" });
    expect(v.render()).toContain("🔧 Bash: empty-snippet · ❌ failed");
  });
  it("unmatched or unknown outcomes render nothing and never throw", () => {
    const v = new TurnView();
    v.toolFinished({ toolName: "Bash", fingerprint: "Bash:{}", ok: false });   // before any start
    v.toolStarted(bash("x"));
    v.toolFinished({ toolName: "Read", fingerprint: "Read:{}", ok: false });   // wrong fingerprint
    expect(v.render()).toBe("🔧 Bash: x");
  });
  it("toolFinished before any toolStarted is a no-op", () => {
    const v = new TurnView();
    expect(() => v.toolFinished({ toolName: "Bash", fingerprint: "Bash:{}", ok: true, durationMs: 5000 })).not.toThrow();
    expect(v.render()).toBe("");
  });
  it("duplicate toolFinished for the same line is a no-op (second is dropped)", () => {
    const v = new TurnView();
    v.toolStarted(bash("once"));
    const fp = makeFingerprint("Bash", { command: "once" });
    v.toolFinished({ toolName: "Bash", fingerprint: fp, ok: false, errorSnippet: "first" });
    v.toolFinished({ toolName: "Bash", fingerprint: fp, ok: false, errorSnippet: "second" });
    expect(v.render()).toBe("🔧 Bash: once · ❌ first");
  });
  it("ok === undefined renders no outcome", () => {
    const v = new TurnView();
    v.toolStarted(bash("pending-ish"));
    v.toolFinished({ toolName: "Bash", fingerprint: makeFingerprint("Bash", { command: "pending-ish" }) });
    expect(v.render()).toBe("🔧 Bash: pending-ish");
  });
});

describe("makeFingerprint", () => {
  it("is deterministic for the same tool name + input", () => {
    expect(makeFingerprint("Bash", { command: "ls" })).toBe(makeFingerprint("Bash", { command: "ls" }));
  });
  it("differs for different inputs", () => {
    expect(makeFingerprint("Bash", { command: "ls" })).not.toBe(makeFingerprint("Bash", { command: "pwd" }));
  });
});

describe("subagent rows", () => {
  it("agentStarted renders a running row; agentLabel upgrades it retroactively", () => {
    const v = new TurnView();
    v.agentStarted("a1", "general-purpose");
    expect(v.render()).toContain("🤖 general-purpose — running");
    v.agentLabel("a1", "audit");
    expect(v.render()).toContain("🤖 general-purpose: audit — running");
  });

  it("agentStopped collapses the row to a one-liner and drops nested lines", () => {
    const v = new TurnView();
    v.agentStarted("a1", "t");
    v.toolStarted({ toolName: "X", fingerprint: "fp1", line: "nested-line", agentId: "a1" });
    expect(v.render()).toContain("nested-line");
    v.agentStopped("a1", "done here\nextra detail");
    expect(v.render()).toContain("✓ done here");
    expect(v.render()).not.toContain("nested-line");
    expect(v.render()).not.toContain("extra detail");
  });

  it("agentStopped excerpt is the first line, truncated to 100 chars", () => {
    const v = new TurnView();
    v.agentStarted("a1", "t");
    const long = "x".repeat(150);
    v.agentStopped("a1", `${long}\nsecond line`);
    const out = v.render();
    expect(out).toContain("x".repeat(100));
    expect(out).not.toContain("x".repeat(101));
    expect(out).not.toContain("second line");
  });

  it("stop-before-start creates an already-stopped row", () => {
    const v = new TurnView();
    v.agentStopped("ghost", "done early");
    expect(v.render()).toContain("✓ done early");
    expect(v.runningAgentCount).toBe(0);
  });

  it("duplicate agentStarted is a no-op", () => {
    const v = new TurnView();
    v.agentStarted("a1", "type-a");
    v.agentLabel("a1", "L");
    v.agentStarted("a1", "type-b");
    expect(v.render()).toContain("🤖 type-a: L — running");
    expect(v.render()).not.toContain("type-b");
  });

  it("duplicate agentStopped keeps the first result", () => {
    const v = new TurnView();
    v.agentStarted("a1", "t");
    v.agentStopped("a1", "first");
    v.agentStopped("a1", "second");
    expect(v.render()).toContain("✓ first");
    expect(v.render()).not.toContain("second");
  });

  it("tool events for an unknown agent auto-create a placeholder running row", () => {
    const v = new TurnView();
    v.toolStarted({ toolName: "Bash", fingerprint: "fp1", line: "🔧 Bash: x", agentId: "ghost" });
    expect(v.render()).toContain("🤖 agent — running");
    expect(v.render()).toContain("🔧 Bash: x");
    expect(v.runningAgentCount).toBe(1);
  });

  it("caps nested agent tool lines at 3, oldest evicted", () => {
    const v = new TurnView();
    v.agentStarted("a1", "t");
    for (let i = 1; i <= 5; i++) v.toolStarted({ toolName: "X", fingerprint: `fp${i}`, line: `n${i}`, agentId: "a1" });
    const out = v.render();
    expect(out).not.toContain("n1");
    expect(out).not.toContain("n2");
    expect(out).toContain("n3");
    expect(out).toContain("n4");
    expect(out).toContain("n5");
  });

  it("agent-scoped tool lines never render among main-scope lines", () => {
    const v = new TurnView();
    v.toolStarted({ toolName: "X", fingerprint: "m1", line: "main-line" });
    v.agentStarted("a1", "t");
    v.toolStarted({ toolName: "X", fingerprint: "a1", line: "agent-line", agentId: "a1" });
    const out = v.render();
    const mainIdx = out.indexOf("main-line");
    const agentIdx = out.indexOf("🤖");
    expect(mainIdx).toBeGreaterThanOrEqual(0);
    expect(agentIdx).toBeGreaterThan(mainIdx);
    expect(out.indexOf("agent-line")).toBeGreaterThan(agentIdx);
  });

  it("running agents survive reset in a background section", () => {
    const v = new TurnView();
    v.agentStarted("a1", "general-purpose");
    v.agentLabel("a1", "audit call sites");
    v.reset();                                   // new user message arrives
    expect(v.render()).toContain("— background —");
    expect(v.render()).toContain("🤖 general-purpose: audit call sites — running");
    v.agentStopped("a1", "found 3 sites\nmore detail");
    expect(v.render()).toContain("✓ found 3 sites");
  });

  it("a background agent still running keeps updating from late tool events", () => {
    const v = new TurnView();
    v.agentStarted("a1", "t");
    v.reset();
    v.toolStarted({ toolName: "X", fingerprint: "fp1", line: "late-tool", agentId: "a1" });
    expect(v.render()).toContain("— background —");
    expect(v.render()).toContain("late-tool");
  });

  it("a stopped background row is dropped at the next reset", () => {
    const v = new TurnView();
    v.agentStarted("a1", "t");
    v.reset();
    v.agentStopped("a1", "wrapped up");
    expect(v.render()).toContain("wrapped up");
    v.reset();
    expect(v.render()).not.toContain("wrapped up");
    expect(v.render()).not.toContain("— background —");
  });

  it("never evicts a running agent for a completed one", () => {
    const v = new TurnView();
    for (let i = 0; i < 4; i++) { v.agentStarted(`done${i}`, "t"); v.agentStopped(`done${i}`, "ok"); }
    v.agentStarted("live", "t");
    expect(v.render()).toContain("live" /* via type row */);
    expect(v.render()).toContain("+1 more agents");
    expect(v.runningAgentCount).toBe(1);
  });

  it("the ≤4 cap spans BOTH sections combined, not 4 each: running beats completed, current beats background", () => {
    const v = new TurnView();
    // 2 running agents that will become background survivors.
    v.agentStarted("b1", "t");
    v.agentStarted("b2", "t");
    v.reset();
    // 3 running current agents.
    v.agentStarted("c1", "t");
    v.agentStarted("c2", "t");
    v.agentStarted("c3", "t");
    // 2 completed current agents.
    v.agentStarted("d1", "t"); v.agentStopped("d1", "ok");
    v.agentStarted("d2", "t"); v.agentStopped("d2", "ok");
    // 7 agents total (3 running-current + 2 running-background + 2 completed-current);
    // only 4 rows may render.

    const out = v.render();
    const headerCount = (out.match(/🤖/g) || []).length;
    expect(headerCount).toBe(4);
    expect(out).toContain("+3 more agents");
    expect(v.runningAgentCount).toBe(5); // hidden rows still count as running

    // All 3 running-current rows render...
    expect(out).toContain("· c1");
    expect(out).toContain("· c2");
    expect(out).toContain("· c3");
    // ...plus exactly one running-background row (newest; oldest evicted)...
    expect(out).toContain("· b2");
    expect(out).not.toContain("· b1");
    // ...and the completed-current rows are hidden entirely (running always wins).
    expect(out).not.toContain("d1");
    expect(out).not.toContain("d2");
  });
});

describe("turn counters", () => {
  it("turnStarted stamps start time and resets the per-turn tool count", () => {
    const v = new TurnView();
    v.turnStarted(100);
    v.toolStarted(bash("a"));
    v.toolStarted(bash("b"));
    expect(v.turnToolCount).toBe(2);
    v.turnStarted(200);
    expect(v.turnStartedAt).toBe(200);
    expect(v.turnToolCount).toBe(0);
  });
  it("clearTools does NOT reset the per-turn tool count", () => {
    const v = new TurnView();
    v.turnStarted(0);
    v.toolStarted(bash("a"));
    v.clearTools();
    expect(v.turnToolCount).toBe(1);
  });
});

// -----------------------------------------------------------------------
// Task 3: turn-end finalization — summary collapse, budgets, receipt.
// -----------------------------------------------------------------------
describe("renderFinal", () => {
  it("summary collapse preserves every reply text and drops scaffolding", () => {
    const v = new TurnView();
    v.turnStarted(0);
    v.taskCreated("t1", "Fix bug");
    v.toolStarted(bash("npm test"));
    v.closePhase("first answer");
    v.narration({ delta: "narrating", index: 0, final: true, messageId: "m", promptId: "p" });
    v.toolStarted(bash("git diff"));
    v.closePhase("second answer");
    const out = v.renderFinal("summary", 165_000);
    expect(out).toContain("first answer");
    expect(out).toContain("second answer");
    expect(out).toContain("⏱ 2m 45s · 🔧 2 tools");
    expect(out).not.toContain("npm test");
    expect(out).not.toContain("narrating");
    expect(out).not.toContain("Fix bug");
  });

  it("full mode is render() as-is, narration included", () => {
    const v = new TurnView();
    v.turnStarted(0);
    v.closePhase("done");
    v.narration({ delta: "thinking", index: 0, final: true, messageId: "m", promptId: "p" });
    expect(v.renderFinal("full", 5000)).toBe(v.render());
    expect(v.renderFinal("full", 5000)).toContain("thinking");
  });

  it("receipt appends agent count only when agents were seen this turn", () => {
    const v = new TurnView();
    v.turnStarted(0);
    v.closePhase("ok");
    expect(v.renderFinal("summary", 1000)).not.toContain("agents");
    v.turnStarted(0);
    v.agentStarted("a1", "general-purpose");
    v.closePhase("ok again");
    expect(v.renderFinal("summary", 1000)).toContain("· 🤖 1 agent");
    expect(v.renderFinal("summary", 1000)).not.toContain("1 agents");
  });

  it("formats duration under 60s as Ns", () => {
    const v = new TurnView();
    v.turnStarted(0);
    v.closePhase("ok");
    expect(v.renderFinal("summary", 45_000)).toContain("⏱ 45s ·");
  });
});

describe("shouldCollapse / noteDone", () => {
  it("collapse defers while agents run, caps at 10 minutes", () => {
    const v = new TurnView();
    v.agentStarted("a1", "t");
    v.noteDone(1000);
    expect(v.shouldCollapse(1000)).toBe(false);
    expect(v.shouldCollapse(1000 + 10 * 60_000)).toBe(true);
    v.agentStopped("a1");
    expect(v.shouldCollapse(2000)).toBe(true);
  });

  it("collapses immediately with no running agents regardless of lastDoneAt", () => {
    const v = new TurnView();
    expect(v.shouldCollapse(0)).toBe(true);
  });
});

describe("render() budget", () => {
  it("stays untrimmed under the 3500-char cap", () => {
    const v = new TurnView();
    v.closePhase("short");
    expect(v.render()).toBe("short");
  });

  it("trims narration tail first, before touching tool lines or phases", () => {
    const v = new TurnView(50);
    // A phase that alone fits comfortably, but not alongside a full narration tail.
    v.closePhase("kept-phase-" + "p".repeat(3200));
    v.narration({ delta: "n".repeat(4000), index: 0, final: true, messageId: "m", promptId: "p" });
    v.toolStarted(bash("still here"));
    const out = v.render();
    expect(out.length).toBeLessThanOrEqual(3500);
    expect(out).not.toContain("💬"); // narration dropped entirely
    expect(out).toContain("kept-phase-");
    expect(out).toContain("still here"); // tool line untouched — narration alone was enough
  });

  it("drops oldest nested agent lines before oldest main tool lines", () => {
    const v = new TurnView(50);
    v.agentStarted("a1", "t");
    // Nested lines are already capped at 3 per agent (MAX_AGENT_NESTED); pad the
    // survivors so even 3 of them blow the budget, forcing further trimming.
    for (let i = 0; i < 6; i++) {
      v.toolStarted({ toolName: "X", fingerprint: `nfp${i}`, line: `nested-${i}-`.padEnd(1300, "x"), agentId: "a1" });
    }
    // A main tool line that must survive as long as any nested line remains to trim.
    v.toolStarted({ toolName: "Y", fingerprint: "mfp0", line: "MAIN-SURVIVOR" });
    const out = v.render();
    expect(out.length).toBeLessThanOrEqual(3500);
    expect(out).toContain("MAIN-SURVIVOR");
    expect(out).toContain("nested-5-"); // newest nested line kept over the main line
  });

  it("drops oldest completed phases last, after tool lines are exhausted", () => {
    const v = new TurnView(50);
    v.closePhase("old-phase-" + "p".repeat(3600));
    v.closePhase("new-phase-marker");
    const out = v.render();
    expect(out.length).toBeLessThanOrEqual(3500);
    expect(out).toContain("new-phase-marker");
    expect(out).not.toContain("old-phase-");
  });

  it("never cuts mid-line: output lines are a subset of the untrimmed lines", () => {
    const v = new TurnView(50);
    v.closePhase("phase-one");
    for (let i = 0; i < 10; i++) {
      v.toolStarted({ toolName: "X", fingerprint: `fp${i}`, line: `tool-line-${i}-`.padEnd(500, "z") });
    }
    const out = v.render();
    expect(out.length).toBeLessThanOrEqual(3500);
    for (const line of out.split("\n")) {
      expect(line === "" || /^tool-line-\d+-z+$/.test(line) || line === "phase-one").toBe(true);
    }
  });

  it("live budget trimming never deletes the answer — summary sees phases render() dropped", () => {
    const v = new TurnView(50);
    v.turnStarted(0);
    // Oversized alone: render()'s budget must drop this phase entirely to fit.
    const oldReply = "OLD-ANSWER-" + "o".repeat(3600);
    v.closePhase(oldReply);
    const newReply = "NEW-ANSWER-marker";
    v.closePhase(newReply);

    const rendered = v.render();
    expect(rendered.length).toBeLessThanOrEqual(3500);
    expect(rendered).not.toContain("OLD-ANSWER-"); // proves render()'s budget dropped the oldest phase
    expect(rendered).toContain("NEW-ANSWER-marker");

    // Same instance, no further mutation — renderFinal("summary") must still
    // have the phase render() just dropped: applyBudget() only trims local
    // working copies, never this.completedPhases itself.
    const summary = v.renderFinal("summary", 5000);
    expect(summary).toContain("OLD-ANSWER-");
    expect(summary).toContain("NEW-ANSWER-marker");
  });
});

// -----------------------------------------------------------------------
// Task 5 fix (CRITICAL): render()'s live-activity budget (3500 chars, below
// HTML_SAFE_LEN) must never be what ReplyDelivery uses to build the actual
// delivered reply — a single phase over budget would render as "" (Telegram
// then rejects the empty send outright) instead of reaching the
// > htmlSafeLen rollover-to-new-message path. renderFull() is the uncapped
// escape hatch for that delivery seam.
// -----------------------------------------------------------------------
describe("renderFull (uncapped, delivery path)", () => {
  it("keeps a single 4000-char phase whole, past the live-view budget", () => {
    const v = new TurnView();
    const long = "A".repeat(4000);
    v.closePhase(long);
    const out = v.renderFull();
    expect(out).toBe(long);
    expect(out.length).toBe(4000);
  });

  it("render() drops that same oversized phase entirely — renderFull() must not", () => {
    const v = new TurnView(50);
    const long = "B".repeat(4000);
    v.closePhase(long);
    expect(v.render()).toBe(""); // the CRITICAL bug: budget can't fit one 4000-char phase, drops it
    expect(v.renderFull()).toBe(long); // uncapped: the reply is never lost
  });

  it("renderFull includes everything render() does when well under budget", () => {
    const v = new TurnView();
    v.taskCreated("t1", "Fix bug");
    v.toolStarted({ toolName: "X", fingerprint: "fp1", line: "tool-line" });
    v.closePhase("short answer");
    expect(v.renderFull()).toBe(v.render());
  });
});

// -----------------------------------------------------------------------
// Phase collapse: a CLOSED phase (its reply already delivered) renders as
// one collapsed "▸ N tools · M agents · Ns" line above its reply text
// instead of its full tool-line header, when phaseCollapse is true
// (default, matching full/summary live-view modes). The RUNNING phase
// keeps full detail. phaseCollapse=false ("off" mode) reproduces today's
// classic rendering exactly.
// -----------------------------------------------------------------------
describe("phase collapse", () => {
  it("closed phase collapses to a ▸ N tools · M agent(s) · Ns line above the reply; running phase keeps full tool-line detail", () => {
    const v = new TurnView();
    v.turnStarted(0);
    v.agentStarted("a1", "general-purpose");
    v.toolStarted(bash("one"));
    v.toolStarted(bash("two"));
    v.toolStarted({ toolName: "X", fingerprint: "afp1", line: "🔧 nested", agentId: "a1" });
    v.closePhase("closed reply", 14_000); // 3 tools total (2 main + 1 agent-scoped), 1 agent, now given
    v.toolStarted(bash("still-running"));
    const out = v.render();
    expect(out).toContain("▸ 3 tools · 1 agent · 14s\nclosed reply");
    expect(out).toContain("🔧 Bash: still-running");
    expect(out).not.toMatch(/🔧 Bash: one\b/); // classic header line gone — replaced by the ▸ summary
  });

  it("a pure-text phase (no tools, no agents) renders without a ▸ line — reply only", () => {
    const v = new TurnView();
    v.closePhase("just text", 5000);
    expect(v.render()).toBe("just text");
  });

  it("phaseCollapse=false reproduces today's phase rendering exactly, on both render() and renderFull()", () => {
    const v = new TurnView(5);
    v.phaseCollapse = false;
    let i = 0;
    const t = (line: string) => ({ toolName: "X", fingerprint: `pfp${i++}`, line });
    v.toolStarted(t("⚙️ Bash: ls"));
    v.toolStarted(t("📖 Reading: foo.ts"));
    v.closePhase("Done looking.", 999); // even with a duration, off/classic mode ignores it
    const expected = "⚙️ Bash: ls\n📖 Reading: foo.ts\n\nDone looking.";
    expect(v.render()).toBe(expected);
    expect(v.renderFull()).toBe(expected);
  });

  it("duplicate agentStarted upsert doesn't double-count the phase agent counter", () => {
    const v = new TurnView();
    v.agentStarted("a1", "type-a");
    v.agentStarted("a1", "type-b"); // duplicate/upsert for an existing id
    v.toolStarted(bash("x"));
    v.closePhase("done", 1000);
    expect(v.render()).toContain("▸ 1 tool · 1 agent · 1s\ndone");
    expect(v.render()).not.toContain("2 agents");
  });

  it("closePhase without now omits the duration segment", () => {
    const v = new TurnView();
    v.toolStarted(bash("x"));
    v.closePhase("done"); // no now
    expect(v.render()).toBe("▸ 1 tool\ndone");
  });

  it("pluralizes tool/agent counts at 2+ and keeps them singular at 1", () => {
    const v = new TurnView();
    v.agentStarted("a1", "t");
    v.agentStarted("a2", "t");
    v.toolStarted(bash("a"));
    v.toolStarted(bash("b"));
    v.closePhase("done", 2000);
    expect(v.render()).toContain("▸ 2 tools · 2 agents · 2s");
  });

  it("a restored phase renders as opaque full text (double-newline, no ▸ line) even though phaseCollapse defaults true", () => {
    const v = new TurnView();
    v.toolStarted(bash("x"));
    v.closePhase("kept text", 1000); // would collapse if re-rendered directly
    const snap = v.snapshot();
    v.toolStarted(bash("y"));
    v.closePhase("temp");
    v.restore(snap);
    expect(v.render()).toBe("🔧 Bash: x\n\nkept text");
  });

  it("snapshot/restore wire shape is untouched: flat strings, unaffected by phaseCollapse", () => {
    const v = new TurnView(5);
    v.closePhase("Kept.", 1000); // no tools live yet — flat "Kept." on the wire
    v.toolStarted(bash("still live"));
    const snap = v.snapshot();
    expect(snap).toEqual({ phases: ["Kept."], tools: ["🔧 Bash: still live"] });

    v.closePhase("Failed send.");
    v.restore(snap);
    expect(v.render()).toBe("Kept.\n\n🔧 Bash: still live");
  });
});
