import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Running servers record themselves as `<pid>.json` in a small folder so that
 * `protodeck kill` can find servers an agent left running in the background.
 */
export interface ServerInfo {
  pid: number;
  port: number;
  host: string;
  root: string;
  startedAt: number;
}

export function registryDir(): string {
  return process.env.PROTODECK_HOME ?? join(homedir(), ".protodeck", "servers");
}

const file = (pid: number) => join(registryDir(), `${pid}.json`);

export function register(info: ServerInfo): () => void {
  try {
    mkdirSync(registryDir(), { recursive: true });
    writeFileSync(file(info.pid), JSON.stringify(info));
  } catch {
    // Not being listed only means `protodeck kill` cannot find this server.
  }
  return () => unregister(info.pid);
}

export function unregister(pid: number): void {
  try {
    rmSync(file(pid), { force: true });
  } catch {}
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

/** Guards against a recycled pid: the process must still look like protodeck. */
function looksLikeProtodeck(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /protodeck/i.test(cmd);
  } catch {
    return false;
  }
}

/** Lists servers that are still running and removes the entries of ones that are gone. */
export function listServers(): ServerInfo[] {
  let names: string[];
  try {
    names = readdirSync(registryDir());
  } catch {
    return [];
  }
  const out: ServerInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const info = JSON.parse(readFileSync(join(registryDir(), name), "utf8")) as ServerInfo;
      if (Number.isInteger(info.pid) && info.pid > 0 && isAlive(info.pid) && looksLikeProtodeck(info.pid)) out.push(info);
      else rmSync(join(registryDir(), name), { force: true });
    } catch {
      rmSync(join(registryDir(), name), { force: true });
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops a server: SIGTERM first, SIGKILL if it is still running after `graceMs`. */
export async function stopServer(info: ServerInfo, graceMs = 2000): Promise<boolean> {
  try {
    process.kill(info.pid, "SIGTERM");
  } catch (e: any) {
    if (e.code === "ESRCH") {
      unregister(info.pid);
      return true;
    }
    return false;
  }
  for (let waited = 0; waited < graceMs; waited += 50) {
    if (!isAlive(info.pid)) break;
    await sleep(50);
  }
  if (isAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {}
    await sleep(100);
  }
  const stopped = !isAlive(info.pid);
  if (stopped) unregister(info.pid);
  return stopped;
}
