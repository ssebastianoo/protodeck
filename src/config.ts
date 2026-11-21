// User settings in `.protodeck/config.json`: extra agent providers, such as a second Claude account.
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** `local` is `<project>/.protodeck/config.json`, `global` is `~/.protodeck/config.json`. */
export type Scope = "local" | "global";

export interface Provider {
  /** Shown in the agent picker, e.g. "Work". */
  name: string;
  agent: "claude" | "codex";
  /** Passed as CLAUDE_CONFIG_DIR (claude) or CODEX_HOME (codex). `~` is the home folder. */
  configDir: string;
}

export interface ScopeInfo {
  /** Path for display, with the home folder shortened to `~`. */
  path: string;
  exists: boolean;
  providers: Provider[];
  error?: string;
}

export interface ConfigState {
  /** The file in use: the local one when it exists, otherwise the global one, otherwise none. */
  active: Scope | null;
  local: ScopeInfo;
  global: ScopeInfo;
}

/** os.homedir() is %USERPROFILE% on Windows and $HOME elsewhere. */
export function configPath(scope: Scope, projectDir: string): string {
  return join(scopeBase(scope, projectDir), ".protodeck", "config.json");
}

/** Folder that relative paths in a scope's file resolve against. */
function scopeBase(scope: Scope, projectDir: string): string {
  return scope === "global" ? homedir() : projectDir;
}

export function displayPath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + "/") || p.startsWith(home + "\\") ? "~" + p.slice(home.length) : p;
}

/** Expands `~`, then resolves relative paths against `base`. Works with `/` and `\` separators. */
export function expandPath(p: string, base: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Checks one provider entry. Returns an error message, or null when it is valid. */
export function providerError(p: any): string | null {
  if (!p || typeof p !== "object") return "Each provider must be an object";
  if (p.agent !== "claude" && p.agent !== "codex") return `Unknown agent "${p.agent}": use claude or codex`;
  if (typeof p.name !== "string" || !p.name.trim()) return "Each provider needs a name";
  if (p.name.length > 40) return "Provider names can be at most 40 characters";
  if (typeof p.configDir !== "string" || !p.configDir.trim()) return `${p.name} needs a config folder`;
  if (p.configDir.length > 500 || p.configDir.includes("\0")) return `${p.name} has an invalid config folder`;
  return null;
}

/** Validates a parsed config file and returns its providers. Throws with a readable message. */
export function parseProviders(data: any): Provider[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The file must hold a JSON object");
  const list = data.providers ?? [];
  if (!Array.isArray(list)) throw new Error('"providers" must be a list');
  const names = new Set<string>();
  return list.map((p: any) => {
    const err = providerError(p);
    if (err) throw new Error(err);
    const name = p.name.trim();
    if (names.has(name.toLowerCase())) throw new Error(`Two providers are named "${name}"`);
    names.add(name.toLowerCase());
    return { name, agent: p.agent, configDir: p.configDir.trim() };
  });
}

function readFile(path: string): any | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function readScope(scope: Scope, projectDir: string): ScopeInfo {
  const path = configPath(scope, projectDir);
  const shown = scope === "local" ? relative(projectDir, path) : displayPath(path);
  const info: ScopeInfo = { path: shown, exists: existsSync(path), providers: [] };
  if (!info.exists) return info;
  try {
    info.providers = parseProviders(readFile(path));
  } catch (e: any) {
    info.error = `${info.path}: ${e.message}`;
  }
  return info;
}

export function loadConfig(projectDir: string): ConfigState {
  const local = readScope("local", projectDir);
  const global = readScope("global", projectDir);
  return { active: local.exists ? "local" : global.exists ? "global" : null, local, global };
}

/** Providers from the file in use, with config folders expanded to absolute paths. */
export function activeProviders(state: ConfigState, projectDir: string): (Provider & { dir: string; scope: Scope })[] {
  if (!state.active) return [];
  const base = scopeBase(state.active, projectDir);
  return state[state.active].providers.map((p) => ({ ...p, dir: expandPath(p.configDir, base), scope: state.active! }));
}

/**
 * Writes the providers to one scope's file, keeping any other keys in it. An empty provider list
 * removes the file (when nothing else is in it), so the other scope is used again.
 */
export function saveProviders(scope: Scope, projectDir: string, providers: unknown): void {
  const list = parseProviders({ providers });
  const path = configPath(scope, projectDir);
  let data: any = {};
  try {
    data = readFile(path) ?? {};
  } catch {
    throw new Error(`${displayPath(path)} is not valid JSON. Fix or delete it first.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  data.providers = list;
  if (!list.length && Object.keys(data).length === 1) {
    rmSync(path, { force: true });
    try {
      rmdirSync(dirname(path)); // only succeeds when the folder is empty
    } catch {}
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}
