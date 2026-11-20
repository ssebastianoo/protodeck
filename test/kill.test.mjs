import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function start(env, port) {
  const child = spawn(process.execPath, [cli, "--agent", "none", "-p", String(port), join(env.cwd, "protodeck")], {
    cwd: env.cwd,
    env: { ...process.env, PROTODECK_HOME: env.home },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((ok, fail) => {
    child.once("error", fail);
    child.stdout.on("data", (d) => String(d).includes("serving") && ok(child));
    child.once("exit", () => fail(new Error("server exited early")));
  });
}

// Async on purpose: a blocked event loop cannot reap the server children, which would leave zombies.
const kill = (env, ...args) =>
  new Promise((ok) => {
    const c = spawn(process.execPath, [cli, "kill", ...args], { cwd: env.cwd, env: { ...process.env, PROTODECK_HOME: env.home } });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.on("close", (status) => ok({ stdout, status }));
  });
const exited = (child) => new Promise((ok) => (child.exitCode !== null || child.signalCode ? ok() : child.once("exit", ok)));

test("kill stops background servers, optionally by port", async () => {
  const base = mkdtempSync(join(tmpdir(), "protodeck-kill-"));
  mkdirSync(join(base, "protodeck"));
  const env = { cwd: base, home: join(base, "registry") };

  assert.match((await kill(env)).stdout, /No protodeck servers are running/);

  const a = await start(env, 47411);
  const b = await start(env, 47421);
  assert.equal(readdirSync(env.home).length, 2);

  assert.match((await kill(env, "47499")).stdout, /No protodeck server is running on port 47499/);
  assert.equal((await kill(env, "nope")).status, 1);

  const one = await kill(env, "47411");
  assert.match(one.stdout, /stopped port 47411/);
  await exited(a);
  assert.equal(b.exitCode, null);

  const all = await kill(env);
  assert.match(all.stdout, /stopped port 47421/);
  await exited(b);
  assert.equal(readdirSync(env.home).length, 0);
});
