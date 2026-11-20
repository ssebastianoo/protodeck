import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { TEMPLATES, TEXT, VERSION } from "./assets.generated.js";
import { ProtoServer } from "./server.js";
import { discoverAgents, splitArgs } from "./agent.js";

const HELP = `protodeck ${VERSION}: prototype server for coding agents

Usage
  protodeck [dir]              Serve the prototype folder (default: ./protodeck)
  protodeck init [dir]         Create a starter prototype folder and install the agent skill
  protodeck skill [--global]   Install the agent skill (.claude/skills and .agents/skills)

Options
  -p, --port <n>        Port (default 4321, the next free one is used if taken)
  --host <host>         Interface to bind (default 127.0.0.1)
  -a, --agent <agent>   Default agent: claude | codex | none | a command such as "aider --message {prompt}"
                        (default: claude if installed, else codex). Installed agents and their
                        models can be switched from the chat bar.
  --agent-args <args>   Extra arguments for claude/codex, e.g. "--max-turns 20"
  -o, --open            Open the browser
  -v, --version         Print the version
  -h, --help            Show this help
`;

interface Args {
  command: "serve" | "init" | "skill";
  dir?: string;
  port: number;
  host: string;
  agent?: string;
  agentArgs?: string;
  open: boolean;
  global: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: "serve", port: Number(process.env.PORT) || 4321, host: "127.0.0.1", open: false, global: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "-p":
      case "--port":
        a.port = Number(next());
        if (!Number.isInteger(a.port) || a.port < 0 || a.port > 65535) fail("Invalid port");
        break;
      case "--host":
        a.host = next();
        break;
      case "-a":
      case "--agent":
        a.agent = next();
        break;
      case "--agent-args":
        a.agentArgs = next();
        break;
      case "-o":
      case "--open":
        a.open = true;
        break;
      case "-g":
      case "--global":
        a.global = true;
        break;
      case "-v":
      case "--version":
        console.log(VERSION);
        process.exit(0);
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
      default:
        if (arg.startsWith("-")) fail(`Unknown option ${arg}`);
        positional.push(arg);
    }
  }
  if (positional[0] === "init" || positional[0] === "skill") a.command = positional.shift() as Args["command"];
  a.dir = positional[0];
  return a;
}

function fail(msg: string): never {
  console.error(`protodeck: ${msg}\n\n${HELP}`);
  process.exit(1);
}

function write(path: string, content: string, force = false): boolean {
  if (existsSync(path) && !force) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

function installSkill(global: boolean): void {
  const base = global ? (process.env.HOME ?? process.env.USERPROFILE ?? ".") : process.cwd();
  for (const dir of [".claude/skills", ".agents/skills"]) {
    const p = join(base, dir, "prototype", "SKILL.md");
    write(p, TEXT["SKILL.md"], true);
    console.log(`  skill  ${global ? p : relative(process.cwd(), p)}`);
  }
}

function init(dirArg: string | undefined): void {
  const root = resolve(dirArg ?? "protodeck");
  console.log(`Creating prototype in ${relative(process.cwd(), root) || "."}`);
  for (const [rel, content] of Object.entries(TEMPLATES)) {
    if (!rel.startsWith("protodeck/")) continue;
    const p = join(root, rel.slice("protodeck/".length));
    console.log(`  ${write(p, content) ? "create" : "exists"} ${relative(process.cwd(), p)}`);
  }
  installSkill(false);
  console.log(`\nStart it with: npx protodeck${dirArg ? " " + dirArg : ""}`);
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function serve(a: Args): Promise<void> {
  const root = resolve(a.dir ?? "protodeck");
  if (!existsSync(root)) {
    console.error(`protodeck: ${relative(process.cwd(), root) || root} does not exist. Run \`npx protodeck init\` to create it.`);
    process.exit(1);
  }
  const { agents, command } = discoverAgents(a.agent ?? process.env.PROTODECK_AGENT);
  // The agent works from the folder that contains the prototype folder (usually the project root).
  const cwd = dirname(root);
  const server = new ProtoServer({
    root,
    port: a.port,
    host: a.host,
    agent: { agents, command, extraArgs: a.agentArgs ? splitArgs(a.agentArgs) : [], cwd, protoRel: relative(cwd, root) },
  });
  const port = await server.listen();
  const url = `http://${a.host === "0.0.0.0" || a.host === "::" ? "localhost" : a.host}:${port}/`;
  console.log(`\n  protodeck ${VERSION}`);
  console.log(`  ➜ ${url}`);
  console.log(`  serving ${relative(process.cwd(), root) || "."} · agents: ${agents.map((x) => x.label).join(", ") || "none"}\n`);
  if (a.open) openBrowser(url);
  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "init") init(args.dir);
else if (args.command === "skill") installSkill(args.global);
else await serve(args);
