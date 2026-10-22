/**
 * Everything after the command word: `/rename my session` → "my session".
 * Handles the `@botname` suffix Telegram appends in groups, and returns ""
 * (not undefined) for a bare command so callers can tell "no argument" from
 * "an argument that sanitizes away to nothing".
 */
export function commandArgument(text: string): string {
  return text.trim().replace(/^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?\s*/, "").trim();
}

export function parseNewCommand(text: string): { name: string; path: string } | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;
  let path = parts.slice(2).join(" ");
  // Expand ~ to home directory (Node.js doesn't do this automatically)
  if (path.startsWith("~/")) {
    path = path.replace("~", process.env.HOME ?? "");
  }
  return { name: parts[1], path };
}

export function parseDeleteCommand(text: string): { name: string } | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return { name: parts[1] };
}

/**
 * Parse a project-routing message: "/projectname rest of message".
 * Used for direct messages to the bot (and the general topic) to wire
 * the message into that project's topic session.
 * Tolerates Telegram's "@botname" command suffix.
 */
export function parseRouteCommand(text: string): { name: string; content: string } | null {
  const match = text.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:@\w+)?\s+([\s\S]+)/);
  if (!match) return null;
  const content = match[2].trim();
  if (!content) return null;
  return { name: match[1], content };
}

export interface RouteProject { name: string; path: string; chatId?: number; topicId: number; }

export type RouteResolution =
  | { status: "ok"; target: RouteProject }       // routable — has a known chat
  | { status: "no-chat"; target: RouteProject }  // matched, but no chat known yet
  | { status: "unknown" };                       // no project by that name

/**
 * Canonical form of a project name for routing and for Telegram's command menu.
 * Telegram only accepts [a-z0-9_] in a command name, so a project called
 * "Game-Template" or "Café" has to be reachable as /game_template and
 * /cafe — which means route matching must normalize the same way: lowercase,
 * strip diacritics, and treat "-" and "_" as the same character.
 */
export function normalizeRouteName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/-/g, "_");
}

/**
 * Resolve a parsed route name against the project list (case-insensitive, and
 * tolerant of the -/_ and diacritic folding above).
 * Pure so the routing decision can be tested without Telegram/state.
 */
export function resolveRoute(projects: RouteProject[], name: string): RouteResolution {
  const wanted = normalizeRouteName(name);
  const target = projects.find((p) => normalizeRouteName(p.name) === wanted);
  if (!target) return { status: "unknown" };
  if (!target.chatId) return { status: "no-chat", target };
  return { status: "ok", target };
}
