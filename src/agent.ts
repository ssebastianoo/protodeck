// Spawns the user's coding agent for chat-bar instructions and turns its output into events.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";

export type AgentKind = "claude" | "codex" | "custom" | "none";

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
  kind: AgentKind;
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

export function detectAgent(): AgentKind {
  if (hasCommand("claude")) return "claude";
  if (hasCommand("codex")) return "codex";
  return "none";
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
    "Tailwind CSS v4, a CSS reset, the Inter font and live reload are injected automatically: never add <script>, <link> or CDN imports for them, and do not start or restart the server.",
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
  readonly history: AgentEvent[] = [];

  constructor(private opts: AgentOptions, private emit: Emit) {}

  get kind(): AgentKind {
    return this.opts.kind;
  }

  get busy(): boolean {
    return this.child !== null;
  }

  reset(): void {
    this.sessionId = null;
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

  private command(prompt: string): { cmd: string; args: string[] } {
    const extra = this.opts.extraArgs ?? [];
    switch (this.opts.kind) {
      case "claude": {
        const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
        if (this.sessionId) args.push("--resume", this.sessionId);
        return { cmd: "claude", args: [...args, ...extra] };
      }
      case "codex":
        return { cmd: "codex", args: ["exec", "--json", "--full-auto", "--skip-git-repo-check", ...extra, prompt] };
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

  run(ctx: ChatContext): void {
    if (this.child) throw new Error("The agent is still working on the previous instruction");
    const prompt = buildPrompt(ctx, this.opts.protoRel);
    const { cmd, args } = this.command(prompt);
    this.push({ kind: "start", text: ctx.message });

    const child = spawn(cmd, args, {
      cwd: this.opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, PROTODECK: "1" },
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
    if (this.opts.kind === "custom") return this.push({ kind: "text", text: line });
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.push({ kind: "text", text: line });
    }
    if (this.opts.kind === "claude") this.handleClaude(msg);
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
