export interface ResumeCwdInput {
  /** Which home currently holds the session's transcript (see
   *  sessions.ts's resolveSessionHome), or null if it couldn't be found. */
  home: { cwd: string } | null;
  /** The project's realpath'd root. */
  rootReal: string;
  /** Whether home.cwd exists on disk right now. Irrelevant (and safe to pass
   *  false) when home is null or home.cwd === rootReal — the root existing is
   *  a given precondition for running any command against the project. */
  cwdExists: boolean;
}

export type ResumeCwdDecision =
  | { ok: true; cwd?: string }
  | { ok: false; reason: string };

/**
 * Whether resuming a session should carry a cwd override into pm.spawn, and
 * if not, why not.
 *
 * A session homed at the project root (the common case, and every session
 * before this feature) never needs an override. A session homed in a
 * worktree/subfolder gets one — UNLESS that directory is gone (e.g. the
 * worktree was removed after a merge): resuming would try to launch Claude
 * Code with a cwd that doesn't exist. v1 refuses rather than guessing; a
 * future version could offer to relocate the transcript itself, mirroring
 * what Claude Code's own ExitWorktree does when a session voluntarily leaves
 * a worktree.
 */
export function resumeCwdDecision(input: ResumeCwdInput): ResumeCwdDecision {
  if (!input.home || input.home.cwd === input.rootReal) {
    return { ok: true, cwd: undefined };
  }
  if (!input.cwdExists) {
    return {
      ok: false,
      reason: `the worktree at ${input.home.cwd} no longer exists on disk — resume it from the project root instead, or recreate the worktree first`,
    };
  }
  return { ok: true, cwd: input.home.cwd };
}
