import { test } from "node:test";
import assert from "node:assert/strict";
import { expandComponents, fillTemplate, renderPage } from "../dist/render.js";
import { buildPrompt, splitArgs } from "../dist/agent.js";

const lib = {
  button: '<button class="btn {{class}}">{{label | Go}}</button>',
  card: '<div class="card"><h2>{{title}}</h2><slot></slot></div>',
  loop: "<x-loop />",
};
const load = (n) => lib[n];

test("self-closing component with attributes and fallback", () => {
  assert.equal(expandComponents('<x-button label="Save" />', load), '<!--x:button--><button class="btn ">Save</button><!--/x:button-->');
  assert.equal(expandComponents("<x-button></x-button>", load), '<!--x:button--><button class="btn ">Go</button><!--/x:button-->');
});

test("children go into the slot and nested components expand", () => {
  const out = expandComponents('<x-card title="Hi"><p>a</p><x-button label=\'B\' class="w-full"/></x-card>', load);
  assert.equal(
    out,
    '<!--x:card--><div class="card"><h2>Hi</h2><p>a</p><!--x:button--><button class="btn w-full">B</button><!--/x:button--></div><!--/x:card-->'
  );
});

test("nested same-name components close correctly", () => {
  const out = expandComponents('<x-card title="1"><x-card title="2">in</x-card>after</x-card>', load);
  assert.match(out, /<h2>1<\/h2><!--x:card--><div class="card"><h2>2<\/h2>in<\/div><!--\/x:card-->after/);
});

test("unknown components render a visible placeholder; recursion is bounded", () => {
  assert.match(expandComponents("<x-nope />", load), /Unknown component &lt;x-nope&gt;/);
  assert.ok(expandComponents("<x-loop />", load).length > 0);
});

test("attribute values with > and quotes", () => {
  assert.equal(fillTemplate("{{a}}|{{b}}", [{ name: "a", value: "1 > 0" }, { name: "b", value: "it's" }], ""), "1 > 0|it's");
  assert.match(expandComponents('<x-button label="a > b" />', load), />a > b</);
});

test("renderPage wraps fragments and injects into existing heads", () => {
  const frag = renderPage("<p>hi</p>", load, { version: "1" });
  assert.match(frag, /^<!doctype html><html lang="en"><head>.*tailwind\.js.*<\/head><body><p>hi<\/p><\/body><\/html>$/s);
  const full = renderPage('<!doctype html><html><head><title>t</title></head><body></body></html>', load, { version: "1", theme: "@theme{--color-x:red}" });
  assert.match(full, /<head><meta charset="utf-8">.*--color-x:red.*<title>t<\/title>/s);
});

test("renderPage sets data-protodeck-theme early and maps dark: to it", () => {
  const page = renderPage("<p>hi</p>", load, { version: "1" });
  assert.match(page, /@custom-variant dark \(&:where\(\[data-protodeck-theme=dark\]/);
  assert.match(page, /__protodeckTheme.*setAttribute\("data-protodeck-theme",t\)/s);
  assert.ok(page.indexOf("data-protodeck-theme\",t") < page.indexOf("client.js"));
});

test("splitArgs and prompt", () => {
  assert.deepEqual(splitArgs(`aider --message "{prompt}" --x 'a b'`), ["aider", "--message", "{prompt}", "--x", "a b"]);
  const p = buildPrompt(
    { message: "Make it blue", screen: "home/", device: { name: "iPhone", width: 402, height: 874 }, element: { selector: "main > a", html: "<a>x</a>", components: ["button"] } },
    "protodeck"
  );
  assert.match(p, /Current screen: protodeck\/home\/index\.html/);
  assert.match(p, /component <x-button> \(protodeck\/components\/button\.html\)/);
  assert.match(p, /Instruction:\nMake it blue$/);
});

test("agent choices are checked against the discovered models", async () => {
  const { AgentRunner } = await import("../dist/agent.js");
  const agents = [
    { id: "claude", kind: "claude", label: "Claude Code", models: [{ id: "", label: "Default", efforts: ["low", "high"] }, { id: "opus", label: "Opus", efforts: ["low", "high"] }] },
    { id: "codex", kind: "codex", label: "Codex", models: [{ id: "", label: "Default", efforts: [] }] },
  ];
  const r = new AgentRunner({ agents, cwd: ".", protoRel: "protodeck" }, () => {});
  const plain = ({ info, ...c }) => c;
  assert.deepEqual(plain(r.resolve(undefined)), { agent: "claude", model: "", effort: "" });
  assert.deepEqual(plain(r.resolve({ agent: "claude", model: "opus", effort: "high" })), { agent: "claude", model: "opus", effort: "high" });
  assert.throws(() => r.resolve({ agent: "claude", model: "--dangerous" }), /Unknown model/);
  assert.throws(() => r.resolve({ agent: "codex", effort: "high" }), /does not support/);
  // A provider that was renamed or removed must not fall back to another account.
  assert.throws(() => r.resolve({ agent: "claude:Gone" }), /Gone is no longer/);
});

test("codex models come from its local cache, listed ones only", async () => {
  const { codexModels } = await import("../dist/agent.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "protodeck-codex-"));
  writeFileSync(
    join(dir, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "b", display_name: "B", visibility: "list", priority: 2, supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" },
        { slug: "hidden", visibility: "hide", priority: 0 },
        { slug: "a", display_name: "A", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "high" }, { effort: "bad value" }] },
      ],
    })
  );
  assert.deepEqual(codexModels(dir).map((m) => m.id), ["", "a", "b"]);
  assert.deepEqual(codexModels(dir)[1].efforts, ["high"]);
  assert.deepEqual(codexModels(join(dir, "missing")).map((m) => m.id), [""]);
});
