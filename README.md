<img src="assets/logo.svg" alt="" width="72" height="72">

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

## Gallery

- **Move around:** scroll or swipe with two fingers to pan, drag the background, or hold Space and drag. Arrow keys pan too (Shift for bigger steps).
- **Zoom:** pinch, Ctrl/⌘ + scroll, ⌘ + `+`/`-`, or the slider. ⌘ + `0` resets.
- **Devices:** pick frames from the Devices menu, or add your own width and height with "Add custom size…". Custom sizes are saved in the browser.
- **View:** show or hide the components section (hidden by default) and switch between same-height and true relative frame sizes.
- **Light and dark:** the button at the top right switches the gallery and the previews. Screens follow it through Tailwind's `dark:` variant (a `data-protodeck-theme` attribute on `<html>`). Screens that use `dark:` classes also get the native dark color scheme for form controls and scrollbars.

## Chat bar

The bar at the bottom of the gallery sends an instruction to your agent along with:

- the current screen and device frame (click a frame to choose them)
- the selected element's selector, HTML and the component it comes from (use the picker button, then click an element in any frame)

The agent edits the files in `protodeck/` and the frames reload by themselves. Everything runs locally: the server spawns the agent in the folder that contains `protodeck/`.

Pick the agent, model and reasoning level from the selector in the bar. It lists every installed agent: Claude Code (Default, Opus, Sonnet, Haiku, Fable, passed as `--model` and `--effort`) and Codex (the models in its local cache, passed as `--model` and `model_reasoning_effort`). "Default" leaves the agent's own setting alone. Use **+** to start a new conversation. Switching to a different agent also starts one.

| `--agent` | What runs |
| --- | --- |
| `claude` (default if installed) | `claude -p … --output-format stream-json --permission-mode acceptEdits`. The conversation continues until you start a new chat. |
| `codex` | `codex exec --json --full-auto …`. Each instruction starts a fresh run. |
| `"cmd … {prompt}"` | Any CLI, listed first in the selector. `{prompt}` is replaced with the full prompt (it is appended if missing). Its stdout is shown as text. |
| `none` | Gallery only. |

`--agent` sets which agent is selected by default.
Pass extra flags with `--agent-args "--max-turns 20"`.

## CLI

```
protodeck [dir]              Serve the prototype folder (default ./protodeck)
protodeck init [dir]         Create a starter prototype and install the skill
protodeck skill [--global]   Install the skill into .claude/skills and .agents/skills
protodeck kill [port]        Stop servers left running in the background (all, or the one on [port])

-p, --port <n>       default 4321 (the next free port is used if it is taken)
--host <host>        default 127.0.0.1
-a, --agent <agent>  claude | codex | none | "<command> {prompt}"
--agent-args <args>  extra args for claude/codex
-o, --open           open the browser
```

If an agent started the server in the background and it is still running, `protodeck kill` stops it. Pass a port to stop only that one.

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
