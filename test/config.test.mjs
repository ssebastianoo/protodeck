import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeProviders, changeProviders, expandPath, loadConfig, parseProviders, saveProviders } from "../dist/config.js";
import { providerAgents } from "../dist/agent.js";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "protodeck-config-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  mkdirSync(home);
  mkdirSync(project);
  // os.homedir() reads these on every call.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, project };
}

const work = { name: "Work", agent: "claude", configDir: "~/.claude-work" };

test("expandPath handles ~, both separators and relative paths", () => {
  const { home } = sandbox();
  assert.equal(expandPath("~", "/base"), home);
  assert.equal(expandPath("~/.claude-work", "/base"), join(home, ".claude-work"));
  assert.equal(expandPath("~\\.claude-work", "/base"), join(home, ".claude-work"));
  assert.equal(expandPath("cfg", "/base"), join("/base", "cfg"));
});

test("parseProviders rejects bad entries", () => {
  assert.deepEqual(parseProviders({}), []);
  assert.throws(() => parseProviders({ providers: [{ ...work, agent: "sh" }] }), /Unknown agent/);
  assert.throws(() => parseProviders({ providers: [{ ...work, name: " " }] }), /needs a name/);
  assert.throws(() => parseProviders({ providers: [{ ...work, configDir: "" }] }), /config folder/);
  assert.throws(() => parseProviders({ providers: [work, { ...work, name: "work" }] }), /Two providers/);
});

test("the local file wins, the global one is the fallback", () => {
  const { home, project } = sandbox();
  assert.equal(loadConfig(project).active, null);

  saveProviders("global", project, [work]);
  assert.ok(existsSync(join(home, ".protodeck", "config.json")));
  let cfg = loadConfig(project);
  assert.equal(cfg.active, "global");
  assert.deepEqual(activeProviders(cfg, project).map((p) => p.dir), [join(home, ".claude-work")]);

  saveProviders("local", project, [{ name: "Alt", agent: "codex", configDir: "codex-alt" }]);
  cfg = loadConfig(project);
  assert.equal(cfg.active, "local");
  assert.equal(cfg.local.path, join(".protodeck", "config.json"));
  assert.deepEqual(activeProviders(cfg, project).map((p) => [p.name, p.dir]), [["Alt", join(project, "codex-alt")]]);

  // Emptying the local file removes it, so the global file is used again.
  saveProviders("local", project, []);
  assert.ok(!existsSync(join(project, ".protodeck")));
  assert.equal(loadConfig(project).active, "global");
});

test("saving keeps other keys and refuses to overwrite broken JSON", () => {
  const { project } = sandbox();
  const file = join(project, ".protodeck", "config.json");
  mkdirSync(join(project, ".protodeck"));
  writeFileSync(file, JSON.stringify({ other: 1 }));
  saveProviders("local", project, [work]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { other: 1, providers: [work] });
  saveProviders("local", project, []);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { other: 1, providers: [] });

  writeFileSync(file, "{nope");
  assert.match(loadConfig(project).local.error, /config\.json/);
  assert.throws(() => saveProviders("local", project, [work]), /not valid JSON/);
});

test("providerAgents gives each provider its own id and config folder", () => {
  const { agents, dirs } = providerAgents([
    { ...work, dir: "/h/.claude-work" },
    { name: "Alt", agent: "codex", configDir: "x", dir: "/nowhere" },
  ]);
  assert.deepEqual(agents.map((a) => [a.id, a.kind, a.label]), [["claude:Work", "claude", "Work"], ["codex:Alt", "codex", "Alt"]]);
  assert.deepEqual(dirs, { "claude:Work": "/h/.claude-work", "codex:Alt": "/nowhere" });
  assert.equal(agents[1].models[0].id, ""); // no cached models in that folder: Default only
});

test("changeProviders applies to the current file and refuses a broken one", () => {
  const { project } = sandbox();
  const file = join(project, ".protodeck", "config.json");
  changeProviders("local", project, { add: work });
  // Edited elsewhere after the gallery loaded it: the next change keeps that edit.
  writeFileSync(file, JSON.stringify({ providers: [work, { name: "Side", agent: "codex", configDir: "~/.codex-side" }] }));
  changeProviders("local", project, { remove: "work" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).providers.map((p) => p.name), ["Side"]);

  // One invalid entry: adding must not replace the valid ones.
  writeFileSync(file, JSON.stringify({ providers: [work, { name: "Bad", agent: "claud", configDir: "x" }] }));
  assert.throws(() => changeProviders("local", project, { add: { name: "New", agent: "claude", configDir: "y" } }), /Fix or delete it first/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).providers.length, 2);
});
