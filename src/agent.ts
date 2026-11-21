// Spawns the user's coding agent for chat-bar instructions and turns its output into events.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentKind = "claude" | "codex" | "custom";

export interface ModelInfo {
  /** Value passed to the CLI; "" means the agent's own default. */
  id: string;
  label: string;
  /** Reasoning levels the model accepts. The UI adds a "Default" choice that passes nothing. */
  efforts: string[];
  defaultEffort?: string;
}

export interface AgentInfo {
  /** Unique key: the kind for the built-in agents, `<kind>:<name>` for providers from the config file. */
  id: string;
  kind: AgentKind;
  label: string;
  models: ModelInfo[];
  /** Set for providers from `.protodeck/config.json`. */
  provider?: { name: string; configDir: string };
}

export interface AgentChoice {
  /** An AgentInfo id. */
  agent: string;
  model?: string;
  effort?: string;
}

export interface AgentEvent {
  kind: "start" | "text" | "tool" | "error" | "done";
  text?: string;
  at: number;
}

export interface ChatContext {
  message: string;
  screen?: string;
  device?: { name: string; width: number; height: number };
  element?: { selector: string; html: string; components?: string[] };
}

export interface AgentOptions {
  /** Agents the user can pick from in the gallery. Empty turns chat off. */
  agents: AgentInfo[];
  /** Absolute config folders of provider agents, by agent id. Never sent to the browser as env. */
  dirs?: Record<string, string>;
  /** Command template for `custom`, e.g. `aider --message {prompt}`. */
  command?: string;
  /** Extra args appended to the claude/codex command line. */
  extraArgs?: string[];
  cwd: string;
  /** Prototype folder relative to cwd, e.g. `protodeck`. */
  protoRel: string;
}

export function hasCommand(cmd: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function claudeAgent(): AgentInfo {
  const m = (id: string, label: string): ModelInfo => ({ id, label, efforts: CLAUDE_EFFORTS });
  return {
    id: "claude",
    kind: "claude",
    label: "Claude Code",
    models: [m("", "Default"), m("opus", "Opus"), m("sonnet", "Sonnet"), m("haiku", "Haiku"), m("fable", "Fable")],
  };
}

/** Reads the model list Codex caches locally. Falls back to the default model only. */
export function codexModels(home = process.env.CODEX_HOME || join(homedir(), ".codex")): ModelInfo[] {
  const models: ModelInfo[] = [{ id: "", label: "Default", efforts: ["low", "medium", "high"] }];
  try {
    const data = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8"));
    const list = (Array.isArray(data?.models) ? data.models : [])
      .filter((x: any) => typeof x?.slug === "string" && x.visibility === "list")
      .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99));
    for (const x of list) {
      const efforts = (Array.isArray(x.supported_reasoning_levels) ? x.supported_reasoning_levels : [])
        .map((l: any) => l?.effort)
        .filter((e: unknown): e is string => typeof e === "string" && /^[\w-]+$/.test(e));
      models.push({ id: x.slug, label: String(x.display_name || x.slug), efforts, defaultEffort: x.default_reasoning_level });
    }
  } catch {}
  return models;
}

function codexAgent(home?: string): AgentInfo {
  return { id: "codex", kind: "codex", label: "Codex", models: codexModels(home) };
}

/** Env var that points each agent at another config folder, i.e. another account. */
export const CONFIG_ENV: Record<"claude" | "codex", string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

/** Turns config-file providers into agents. `dir` is the expanded config folder. */
export function providerAgents(providers: { name: string; agent: "claude" | "codex"; configDir: string; dir: string }[]): {
  agents: AgentInfo[];
  dirs: Record<string, string>;
} {
  const agents: AgentInfo[] = [];
  const dirs: Record<string, string> = {};
  for (const p of providers) {
    const base = p.agent === "claude" ? claudeAgent() : codexAgent(p.dir);
    const id = `${p.agent}:${p.name}`;
    agents.push({ ...base, id, label: p.name, provider: { name: p.name, configDir: p.configDir } });
    dirs[id] = p.dir;
  }
  return { agents, dirs };
}

/**
 * Lists the agents to offer. `preferred` is the --agent value: claude/codex are included even if
 * not on PATH, any other value is a custom command. Returns the list and the default agent.
 */
export function discoverAgents(preferred?: string): { agents: AgentInfo[]; command?: string } {
  if (preferred === "none") return { agents: [] };
  const agents: AgentInfo[] = [];
  let command: string | undefined;
  if (preferred && preferred !== "claude" && preferred !== "codex") {
    command = preferred;
    agents.push({ id: "custom", kind: "custom", label: splitArgs(preferred)[0] ?? "Custom", models: [{ id: "", label: "Default", efforts: [] }] });
  }
  const claude = preferred === "claude" || hasCommand("claude");
  const codex = preferred === "codex" || hasCommand("codex");
  if (preferred === "codex" && codex) agents.push(codexAgent());
  if (claude) agents.push(claudeAgent());
  if (codex && preferred !== "codex") agents.push(codexAgent());
  return { agents, command };
}

/** Splits a command template into argv, honoring single and double quotes. */
export function splitArgs(cmd: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  return out;
}

export function buildPrompt(ctx: ChatContext, protoRel: string): string {
  const lines = [
    "You are editing an HTML design prototype through the protodeck prototype server.",
    `The prototype lives in ${protoRel}/: one folder per screen with an index.html, and reusable components in ${protoRel}/components/<name>.html used as <x-name attr="..."> tags (fill with {{attr}} / {{attr | default}}, children go into <slot></slot>).`,
    "Tailwind CSS v4, a CSS reset, the Inter font and live reload are injected automatically: never add <script>, <link> or CDN imports for them, and do not start or restart the server. Tailwind's dark: variant follows the gallery's light/dark toggle.",
    `Only edit files inside ${protoRel}/. The browser reloads by itself when you save.`,
    "",
  ];
  if (ctx.screen) lines.push(`Current screen: ${protoRel}/${ctx.screen}index.html (URL /${ctx.screen})`);
  if (ctx.device) lines.push(`Device frame: ${ctx.device.name} (${ctx.device.width}×${ctx.device.height} CSS px)`);
  if (ctx.element) {
    lines.push(`Selected element: ${ctx.element.selector}`);
    if (ctx.element.components?.length) {
      const list = ctx.element.components.map((c) => `<x-${c}> (${protoRel}/components/${c}.html)`).join(" inside ");
      lines.push(`The element is rendered by component ${list}.`);
    }
    lines.push("Rendered HTML of the element (components already expanded):", "```html", ctx.element.html, "```");
  }
  lines.push("", "Instruction:", ctx.message);
  return lines.join("\n");
}

type Emit = (e: AgentEvent) => void;

function shortJson(v: unknown, max = 160): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;
  const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url;
  return target ? `${name} ${shortJson(target, 400)}` : name;
}

export class AgentRunner {
  private child: ChildProcess | null = null;
  private sessionId: string | null = null;
  /** Agent id of the current conversation; switching agents (or accounts) starts a new one. */
  private sessionAgent: string | null = null;
  private runningKind: AgentKind | null = null;
  readonly history: AgentEvent[] = [];

  constructor(private opts: AgentOptions, private emit: Emit) {}

  get agents(): AgentInfo[] {
    return this.opts.agents;
  }

  /** Replaces the agent list, e.g. after the config file changed. */
  setAgents(agents: AgentInfo[], dirs: Record<string, string>): void {
    this.opts.agents = agents;
    this.opts.dirs = dirs;
  }

  get busy(): boolean {
    return this.child !== null;
  }

  reset(): void {
    this.sessionId = null;
    this.sessionAgent = null;
    this.history.length = 0;
  }

  /** Shortens absolute paths under the working folder so tool lines stay readable. */
  private relPaths(text: string): string {
    let real = this.opts.cwd;
    try {
      real = realpathSync(this.opts.cwd);
    } catch {}
    for (const base of new Set([this.opts.cwd, real, real.replace(/^\/private\//, "/")])) text = text.split(base + "/").join("");
    return text;
  }

  private push(e: Omit<AgentEvent, "at">): void {
    const ev = { ...e, at: Date.now() };
    if (ev.kind === "tool" && ev.text) ev.text = this.relPaths(ev.text);
    this.history.push(ev);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    this.emit(ev);
  }

  /** Checks a choice from the browser against the discovered agents, so only known values reach argv. */
  resolve(choice: Partial<AgentChoice> | undefined): Required<AgentChoice> & { info: AgentInfo } {
    // An unknown id means the provider was renamed or removed: don't quietly run another account.
    const agent = choice?.agent ? this.opts.agents.find((a) => a.id === choice.agent) : this.opts.agents[0];
    if (!agent) throw new Error(choice?.agent ? `${choice.agent.replace(/^\w+:/, "")} is no longer in the provider list. Pick another agent.` : "No agent configured");
    const model = agent.models.find((m) => m.id === (choice?.model ?? ""));
    if (!model) throw new Error(`Unknown model for ${agent.label}: ${choice?.model}`);
    const effort = choice?.effort ?? "";
    if (effort && !model.efforts.includes(effort)) throw new Error(`${model.label} does not support reasoning level ${effort}`);
    return { agent: agent.id, model: model.id, effort, info: agent };
  }

  private command(prompt: string, c: Required<AgentChoice> & { info: AgentInfo }): { cmd: string; args: string[] } {
    const extra = this.opts.extraArgs ?? [];
    switch (c.info.kind) {
      case "claude": {
        const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
        if (this.sessionId) args.push("--resume", this.sessionId);
        if (c.model) args.push("--model", c.model);
        if (c.effort) args.push("--effort", c.effort);
        return { cmd: "claude", args: [...args, ...extra] };
      }
      case "codex": {
        const args = ["exec", "--json", "--full-auto", "--skip-git-repo-check"];
        if (c.model) args.push("--model", c.model);
        if (c.effort) args.push("-c", `model_reasoning_effort="${c.effort}"`);
        return { cmd: "codex", args: [...args, ...extra, prompt] };
      }
      case "custom": {
        const parts = splitArgs(this.opts.command ?? "");
        let used = false;
        const args = parts.slice(1).map((p) => {
          if (!p.includes("{prompt}")) return p;
          used = true;
          return p.split("{prompt}").join(prompt);
        });
        if (!used) args.push(prompt);
        return { cmd: parts[0], args };
      }
      default:
        throw new Error("No agent configured");
    }
  }

  run(ctx: ChatContext, choice?: Partial<AgentChoice>): void {
    if (this.child) throw new Error("The agent is still working on the previous instruction");
    const c = this.resolve(choice);
    // A session lives in one config folder, so a provider pointed at a new folder starts fresh.
    const sessionKey = `${c.agent}\0${this.opts.dirs?.[c.agent] ?? ""}`;
    if (this.sessionAgent !== sessionKey) {
      this.sessionId = null;
      this.sessionAgent = sessionKey;
    }
    this.runningKind = c.info.kind;
    const prompt = buildPrompt(ctx, this.opts.protoRel);
    const { cmd, args } = this.command(prompt, c);
    this.push({ kind: "start", text: ctx.message });

    const child = spawn(cmd, args, {
      cwd: this.opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: this.env(c.info),
    });
    this.child = child;

    let buf = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handleLine(line);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (err) => {
      this.push({ kind: "error", text: `Could not start ${cmd}: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      if (buf.trim()) this.handleLine(buf.trim());
      this.child = null;
      if (signal) this.push({ kind: "done", text: "Stopped" });
      else if (code !== 0) {
        this.push({ kind: "error", text: stderr.trim() || `${cmd} exited with code ${code}` });
        this.push({ kind: "done" });
      } else this.push({ kind: "done" });
    });
  }

  private env(agent: AgentInfo): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PROTODECK: "1" };
    const dir = this.opts.dirs?.[agent.id];
    if (dir && agent.kind !== "custom") env[CONFIG_ENV[agent.kind]] = dir;
    return env;
  }

  stop(): void {
    const c = this.child;
    if (!c || c.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-c.pid, "SIGTERM");
      else c.kill();
    } catch {
      c.kill();
    }
  }

  private handleLine(line: string): void {
    if (this.runningKind === "custom") return this.push({ kind: "text", text: line });
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.push({ kind: "text", text: line });
    }
    if (this.runningKind === "claude") this.handleClaude(msg);
    else this.handleCodex(msg);
  }

  private handleClaude(msg: any): void {
    if (msg.session_id) this.sessionId = msg.session_id;
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const part of msg.message.content) {
        if (part.type === "text" && part.text?.trim()) this.push({ kind: "text", text: part.text.trim() });
        else if (part.type === "tool_use") this.push({ kind: "tool", text: describeTool(part.name, part.input) });
      }
    } else if (msg.type === "result" && msg.is_error) {
      this.push({ kind: "error", text: String(msg.result ?? msg.subtype ?? "The agent reported an error") });
    }
  }

  private handleCodex(msg: any): void {
    // Current `codex exec --json` emits {type:"item.*", item:{...}}; older versions emit {msg:{type,...}}.
    const item = msg.item;
    if (item && msg.type === "item.completed") {
      if (item.type === "agent_message" && item.text) this.push({ kind: "text", text: item.text });
      else if (item.type === "command_execution") this.push({ kind: "tool", text: `Run ${shortJson(item.command, 120)}` });
      else if (item.type === "file_change" && Array.isArray(item.changes))
        for (const c of item.changes) this.push({ kind: "tool", text: `${c.kind ?? "edit"} ${c.path}` });
      else if (item.type === "error") this.push({ kind: "error", text: item.message });
      return;
    }
    if (msg.type === "error" || msg.type === "turn.failed")
      return this.push({ kind: "error", text: msg.message ?? msg.error?.message ?? "Codex error" });
    const m = msg.msg;
    if (!m) return;
    if (m.type === "agent_message" && m.message) this.push({ kind: "text", text: m.message });
    else if (m.type === "exec_command_begin") this.push({ kind: "tool", text: `Run ${shortJson(m.command, 120)}` });
    else if (m.type === "patch_apply_begin" && m.changes)
      for (const p of Object.keys(m.changes)) this.push({ kind: "tool", text: `edit ${p}` });
    else if (m.type === "error") this.push({ kind: "error", text: m.message });
  }
}
