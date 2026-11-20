# protodeck

A prototype server for coding agents. Your agent writes plain HTML screens in a `protodeck/` folder, outside the app code. protodeck serves them with Tailwind, components and live reload, shows every screen side by side in MacBook, iPhone and Samsung frames, and adds a chat bar that sends your instructions back to the agent.

```
npx protodeck init     # starter protodeck/ folder + agent skill
npx protodeck          # serve it at http://127.0.0.1:4321/
```

`bunx protodeck` works the same way. The package has no runtime dependencies. Tailwind v4 and the Inter font ship inside it, so everything works offline.

## Folder structure

```
protodeck/
  home/index.html          one folder per screen
  login/index.html
  checkout/index.html
  components/button.html   one file per component, used as <x-button>
  theme.css                optional Tailwind v4 @theme tokens
```

Every HTML file gets Tailwind, a base reset, the Inter font and the live reload script injected into its `<head>`, so a screen can be just its body markup.

## Components

`components/card.html`:

```html
<div class="rounded-2xl p-6 shadow {{class}}">
  <h2 class="font-semibold">{{title | Untitled}}</h2>
  <slot></slot>
</div>
```

Use it in a screen as `<x-card title="Plan">…</x-card>` or `<x-card />`. Attributes fill `{{name}}` (with an optional `| fallback`), and children go into `<slot></slot>`. Components can use other components.

## Chat bar

The bar at the bottom of the gallery sends an instruction to your agent along with:

- the current screen and device frame (click a frame to choose them)
- the selected element's selector, HTML and the component it comes from (use the picker button, then click an element in any frame)

The agent edits the files in `protodeck/` and the frames reload by themselves. Everything runs locally: the server spawns the agent in the folder that contains `protodeck/`.

| `--agent` | What runs |
| --- | --- |
| `claude` (default if installed) | `claude -p … --output-format stream-json --permission-mode acceptEdits`. The conversation continues until you click **New chat**. |
| `codex` | `codex exec --json --full-auto …`. Each instruction starts a fresh run. |
| `"cmd … {prompt}"` | Any CLI. `{prompt}` is replaced with the full prompt (it is appended if missing). Its stdout is shown as text. |
| `none` | Gallery only. |

Pass extra flags with `--agent-args "--model sonnet"`.

## CLI

```
protodeck [dir]              Serve the prototype folder (default ./protodeck)
protodeck init [dir]         Create a starter prototype and install the skill
protodeck skill [--global]   Install the skill into .claude/skills and .agents/skills

-p, --port <n>       default 4321 (the next free port is used if it is taken)
--host <host>        default 127.0.0.1
-a, --agent <agent>  claude | codex | none | "<command> {prompt}"
--agent-args <args>  extra args for claude/codex
-o, --open           open the browser
```

## The skill

`skill/SKILL.md` tells the agent to build prototypes as HTML in `protodeck/`, to treat Tailwind and components as already available, and to start the server with `npx protodeck`. `protodeck init` and `protodeck skill` copy it into the project.

## Development

```
npm install
npm run build      # embeds assets, compiles TypeScript to dist/
npm test
npm run build:bin  # standalone binary with Bun (bin/protodeck), for machines without Node
```

`scripts/gen-assets.mjs` embeds Tailwind, the font, the UI files in `ui/`, the skill and the templates into one generated module. That lets the npm build and the Bun binary share the same code, without reading any files at runtime.

## Security

The server binds to 127.0.0.1, rejects requests whose `Host` is not local (to block DNS rebinding), and the chat endpoints require a per-session token that is embedded in the gallery page. Other websites therefore cannot trigger your agent.
