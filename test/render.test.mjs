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
