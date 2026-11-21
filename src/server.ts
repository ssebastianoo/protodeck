// HTTP server: gallery, screens, injected assets, live reload and the chat bridge.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, resolve, sep, extname, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { BINARY, TEXT, VERSION } from "./assets.generated.js";
import { renderPage } from "./render.js";
import { AgentRunner, providerAgents, type AgentChoice, type AgentEvent, type AgentInfo, type AgentOptions, type ChatContext } from "./agent.js";
import { activeProviders, loadConfig, saveProviders, type ConfigState } from "./config.js";

export interface ServerOptions {
  root: string; // absolute prototype folder
  port: number;
  host: string;
  /** `agent.agents` holds the built-in agents; providers from `.protodeck/config.json` are added after them. */
  agent: AgentOptions;
  /** False with `--agent none`: chat stays off even if the config file lists providers. */
  providers?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const SKIP_DIRS = new Set(["components", "node_modules"]);

export interface Screen {
  path: string; // "home/" or "settings/profile/"
  title: string;
}

/** Lists every folder under root that holds an index.html, except components and hidden folders. */
export function listScreens(root: string): Screen[] {
  const out: Screen[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_") || (rel === "" && SKIP_DIRS.has(name))) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const index = join(p, "index.html");
      if (existsSync(index)) {
        const html = readFileSync(index, "utf8");
        const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
        out.push({ path: `${rel}${name}/`, title: t || `${rel}${name}` });
      }
      walk(p, `${rel}${name}/`);
    }
  };
  walk(root, "");
  return out;
}

export function listComponents(root: string): string[] {
  try {
    return readdirSync(join(root, "components"))
      .filter((f) => f.endsWith(".html"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

function fontFace(): string {
  const face = (file: string, range: string) =>
    `@font-face{font-family:"Inter Variable";font-style:normal;font-display:swap;font-weight:100 900;` +
    `src:url(/__protodeck/${file}?v=${VERSION}) format("woff2");unicode-range:${range}}`;
  return (
    face("inter-latin-ext.woff2", "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF") +
    face("inter-latin.woff2", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD")
  );
}

export class ProtoServer {
  private server: Server;
  private watcher: FSWatcher | null = null;
  private clients = new Set<ServerResponse>();
  private token = randomBytes(16).toString("hex");
  /** Identifies this server process, so a gallery left open across a restart knows its token is stale. Not secret. */
  private instance = randomBytes(8).toString("hex");
  private agent: AgentRunner;
  private changeTimer: NodeJS.Timeout | null = null;
  private changed = new Set<string>();
  private baseAgents: AgentInfo[];
  private configError: string | undefined;
  port: number;

  constructor(private opts: ServerOptions) {
    this.port = opts.port;
    this.baseAgents = opts.agent.agents;
    this.agent = new AgentRunner({ ...opts.agent }, (e) => this.broadcast("agent", e));
    this.refreshAgents();
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err?.stack ?? err));
      });
    });
  }

  async listen(): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await new Promise<void>((ok, fail) => {
          const onErr = (e: Error) => {
            this.server.off("listening", onOk);
            fail(e);
          };
          const onOk = () => {
            this.server.off("error", onErr);
            ok();
          };
          this.server.once("error", onErr);
          this.server.once("listening", onOk);
          this.server.listen(this.port, this.opts.host);
        });
        this.startWatching();
        return this.port;
      } catch (e: any) {
        if (e.code !== "EADDRINUSE") throw e;
        this.port++;
      }
    }
    throw new Error("No free port found");
  }

  get agents(): AgentInfo[] {
    return this.agent.agents;
  }

  /** Folder the agent runs in and the local config lives in: the one that contains the prototype folder. */
  private get projectDir(): string {
    return this.opts.agent.cwd;
  }

  /**
   * Rereads the config (local file first, global as fallback) and rebuilds the agent list.
   * Called on every gallery load and chat message, so edits to the file apply without a restart.
   */
  private refreshAgents(): ConfigState {
    const config = loadConfig(this.projectDir);
    const active = config.active ? config[config.active] : undefined;
    if (active?.error && active.error !== this.configError) console.warn(`protodeck: ${active.error}`);
    this.configError = active?.error;
    const { agents, dirs } =
      this.opts.providers === false ? { agents: [], dirs: {} } : providerAgents(activeProviders(config, this.projectDir));
    this.agent.setAgents([...this.baseAgents, ...agents], dirs);
    return config;
  }

  private configPayload(config: ConfigState) {
    return { config, agents: this.agent.agents, providers: this.opts.providers !== false };
  }

  close(): void {
    this.agent.stop();
    this.watcher?.close();
    for (const c of this.clients) c.end();
    this.server.close();
  }

  private startWatching(): void {
    try {
      this.watcher = watch(this.opts.root, { recursive: true }, (_ev, file) => {
        if (file) this.changed.add(String(file).split(sep).join("/"));
        if (this.changeTimer) clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => {
          const files = [...this.changed];
          this.changed.clear();
          this.broadcast("change", { files, screens: listScreens(this.opts.root), components: listComponents(this.opts.root) });
        }, 120);
      });
    } catch (e: any) {
      console.warn(`protodeck: live reload disabled (${e.message})`);
    }
  }

  private broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(payload);
  }

  /** Blocks DNS rebinding and cross-site requests: the host must be local and writes need our token. */
  private hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === this.opts.host;
  }

  private send(res: ServerResponse, status: number, type: string, body: string | Buffer, cache = false): void {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": cache ? "public, max-age=31536000, immutable" : "no-store",
    });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    this.send(res, status, "application/json; charset=utf-8", JSON.stringify(data));
  }

  private loadComponent = (name: string): string | undefined => {
    if (!/^[\w-]+$/.test(name)) return undefined;
    const p = join(this.opts.root, "components", `${name}.html`);
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  };

  private theme(): string | undefined {
    const p = join(this.opts.root, "theme.css");
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  private render(src: string): string {
    return renderPage(src, this.loadComponent, { version: VERSION, theme: this.theme() });
  }

  private async readBody(req: IncomingMessage): Promise<any> {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) throw new Error("Body too large");
    }
    return body ? JSON.parse(body) : {};
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostAllowed(req)) return this.send(res, 403, "text/plain", "Forbidden host");
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);

    if (path.startsWith("/__protodeck/")) return this.handleInternal(req, res, path.slice(13), url);

    if (path === "/") {
      this.refreshAgents();
      const page = TEXT["gallery.html"]
        .replaceAll("%VERSION%", VERSION)
        .replace("%BOOT%", JSON.stringify({ token: this.token, instance: this.instance, agents: this.agent.agents, providers: this.opts.providers !== false, version: VERSION }).replace(/</g, "\\u003c"));
      return this.send(res, 200, MIME[".html"], page);
    }

    const file = resolve(this.opts.root, "." + path);
    if (file !== this.opts.root && !file.startsWith(this.opts.root + sep)) return this.send(res, 403, "text/plain", "Forbidden");
    let target = file;
    let st = statSafe(target);
    if (st?.isDirectory()) {
      if (!path.endsWith("/")) {
        res.writeHead(301, { location: path + "/" + url.search });
        return void res.end();
      }
      target = join(target, "index.html");
      st = statSafe(target);
    }
    if (!st?.isFile()) return this.send(res, 404, MIME[".html"], this.render(notFound(path)));
    const ext = extname(target).toLowerCase();
    if (ext === ".html") return this.send(res, 200, MIME[".html"], this.render(readFileSync(target, "utf8")));
    return this.send(res, 200, MIME[ext] ?? "application/octet-stream", readFileSync(target));
  }

  private async handleInternal(req: IncomingMessage, res: ServerResponse, name: string, url: URL): Promise<void> {
    if (req.method === "POST") {
      if (req.headers["x-protodeck-token"] !== this.token) return this.json(res, 403, { error: "Bad token" });
      if (name === "config") {
        const body = await this.readBody(req);
        if (body.scope !== "local" && body.scope !== "global") return this.json(res, 400, { error: "scope must be local or global" });
        try {
          saveProviders(body.scope, this.projectDir, body.providers);
        } catch (e: any) {
          return this.json(res, 400, { error: e.message });
        }
        const payload = this.configPayload(this.refreshAgents());
        this.broadcast("agents", { agents: payload.agents });
        return this.json(res, 200, payload);
      }
      if (name === "chat") {
        if (!this.agent.busy) this.refreshAgents();
        if (!this.agent.agents.length) return this.json(res, 400, { error: "No agent configured. Restart with --agent claude|codex|\"<command>\"" });
        if (this.agent.busy) return this.json(res, 409, { error: "The agent is still working" });
        const body = (await this.readBody(req)) as ChatContext & { agent?: AgentChoice };
        if (!body.message?.trim()) return this.json(res, 400, { error: "Empty message" });
        try {
          this.agent.run(body, body.agent);
        } catch (e: any) {
          return this.json(res, 400, { error: e.message });
        }
        return this.json(res, 200, { ok: true });
      }
      if (name === "stop") {
        this.agent.stop();
        return this.json(res, 200, { ok: true });
      }
      if (name === "reset") {
        if (this.agent.busy) return this.json(res, 409, { error: "The agent is still working" });
        this.agent.reset();
        return this.json(res, 200, { ok: true });
      }
      return this.json(res, 404, { error: "Not found" });
    }

    switch (name) {
      case "events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`retry: 1000\nevent: hello\ndata: ${JSON.stringify({ version: VERSION, instance: this.instance })}\n\n`);
        this.clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => {
          clearInterval(ping);
          this.clients.delete(res);
        });
        return;
      }
      case "config":
        return this.json(res, 200, this.configPayload(this.refreshAgents()));
      case "state":
        return this.json(res, 200, {
          screens: listScreens(this.opts.root),
          components: listComponents(this.opts.root),
          agent: { busy: this.agent.busy, history: this.agent.history as AgentEvent[] },
          root: relative(process.cwd(), this.opts.root) || ".",
        });
      case "component": {
        const c = url.searchParams.get("name") ?? "";
        const src = this.loadComponent(c);
        if (src === undefined) return this.send(res, 404, "text/plain", "Unknown component");
        const page = `<title>${c}</title><body class="min-h-screen grid place-items-center p-8 bg-neutral-50 dark:bg-neutral-900"><div>${src.replace(/\{\{\s*([\w-]+)\s*\|([^}]*)\}\}/g, "$2").replace(/\{\{\s*([\w-]+)\s*\}\}/g, "$1")}</div></body>`;
        return this.send(res, 200, MIME[".html"], this.render(page));
      }
      case "base.css":
        return this.send(res, 200, MIME[".css"], fontFace() + TEXT["base.css"], true);
      case "tailwind.js":
      case "client.js":
      case "gallery.js":
      case "export.js":
      case "gallery.css":
        return this.send(res, 200, MIME[extname(name)], TEXT[name], name === "tailwind.js");
      case "inter-latin.woff2":
      case "inter-latin-ext.woff2":
        return this.send(res, 200, "font/woff2", Buffer.from(BINARY[name], "base64"), true);
      default:
        return this.send(res, 404, "text/plain", "Not found");
    }
  }
}

function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

function notFound(path: string): string {
  const safe = path.replace(/[<>&"]/g, "");
  return `<title>Not found</title><body class="min-h-screen grid place-items-center bg-neutral-50 text-neutral-500"><div class="text-center"><p class="text-sm font-medium text-neutral-900">Nothing at ${safe}</p><p class="mt-1 text-sm">Create <code class="font-mono">${safe.replace(/\/?$/, "/")}index.html</code> in the prototype folder.</p></div></body>`;
}
