# AGENTS.md

protodeck is an npm package (run with `npx`/`bunx protodeck`). It serves HTML prototype screens from a `protodeck/` folder with Tailwind, components and live reload, shows them in device frames, and has a chat bar that spawns the user's coding agent. Read `README.md` for the user-facing behavior.

## Layout

- `src/cli.ts`: argument parsing and the `init`, `skill` and serve commands.
- `src/server.ts`: HTTP server. It serves the gallery (`/`), screens and static files, internal routes under `/__protodeck/`, SSE live reload, and the chat endpoints.
- `src/render.ts`: `<x-name>` component expansion and `<head>` injection. Pure functions, with no file system access.
- `src/agent.ts`: builds the prompt, spawns claude, codex or a custom command, and parses their output into events.
- `ui/`: browser code, plain JS and CSS with no build step.
  - `gallery.html`, `gallery.js` and `gallery.css` make up the gallery page.
  - `client.js` is injected into every screen and handles reload, scroll restore and the element picker.
  - `base.css` is the reset.
- `skill/SKILL.md`: the skill installed into users' projects.
- `templates/protodeck/`: starter files written by `protodeck init`.
- `scripts/gen-assets.mjs`: generates `src/assets.generated.ts`.
- `test/`: `node:test` tests, run against `dist/`.

## Commands

```sh
npm run build      # gen assets + tsc + shebang/chmod on dist/cli.js
npm test           # build, then node --test test/
npm run build:bin  # standalone Bun binary at bin/protodeck
```

Manual check: `node dist/cli.js init` and then `node dist/cli.js --agent none` in a scratch folder.

## Things to know

- **Everything in `ui/`, `skill/` and `templates/`, plus Tailwind and the font, is embedded** into `src/assets.generated.ts` at build time. Nothing is read from the package folder at runtime, so the npm build and the Bun binary behave the same. After editing any of those files, run `npm run build` before testing. Never edit `assets.generated.ts` by hand, and don't add runtime `fs` reads of package files.
- **No runtime dependencies.** Startup speed through `npx` matters. Add dev dependencies only, and embed anything needed at runtime through `gen-assets.mjs`.
- **Internal routes live under `/__protodeck/`.** Everything else maps to files in the prototype folder, so don't add top-level routes other than `/` (the gallery).
- **Security invariants:**
  - Keep the `Host` check, which blocks DNS rebinding.
  - Keep the per-session token on every POST endpoint, because chat spawns an agent.
  - Keep the path traversal check on file serving.
  - The default bind address stays `127.0.0.1`.
- **Gallery frames do not open their own SSE connection.** Browsers cap HTTP/1.1 connections per host, so `client.js` connects only when it is not inside the gallery, and the gallery reloads its iframes itself. Keep it that way.
- **Gallery ↔ frame communication uses `postMessage`** with `protodeck:*` message types (`ready`, `focus`, `pick`, `picked`, `highlight`, `refresh`, `cancel`). Update both `gallery.js` and `client.js` when changing a message.
- **Component markers:** expanded components are wrapped in `<!--x:name-->…<!--/x:name-->`. The picker uses them to tell the agent which component file renders an element, so keep them if you change the expansion.
- **Agent output formats:** `claude` uses `--output-format stream-json`, and the session id is kept for `--resume`. `codex exec --json` handles both the current `item.*` events and the older `msg` events. Check the CLIs' current output before changing these parsers.
- Device definitions are the `DEVICES` list in `ui/gallery.js`.
- The prompt sent to agents is built in `buildPrompt` (`src/agent.ts`). Keep it consistent with `skill/SKILL.md`.

## Style

- TypeScript strict mode and ES modules. Imports inside `src/` use `.js` extensions (NodeNext).
- Browser code is plain modern JS in an IIFE, with no frameworks.
- Write user-facing text plainly and briefly. CLI output and errors should say what to run next.
- Add or update tests in `test/` when changing `render.ts` or the prompt and argument helpers in `agent.ts`.
