---
name: prototype
description: Build UI design prototypes as plain HTML screens in a protodeck/ folder, outside the app code, and preview them in device frames with protodeck. Use when asked to prototype, mock up, sketch or explore the design of screens, flows or components.
---

# Prototyping with protodeck

Design work happens in a standalone `protodeck/` folder at the project root. Do not read or change the app's source code for prototyping unless the user asks you to match something specific in it.

## Folder structure

```
protodeck/
  home/index.html          one folder per screen, each with its own index.html
  login/index.html
  checkout/index.html
  components/button.html   one file per reusable component
  components/navbar.html
  theme.css                optional Tailwind v4 theme (@theme { ... })
```

- Folder names become URLs: `protodeck/login/index.html` is served at `/login/`. Nested folders work (`settings/profile/index.html`).
- Folders starting with `_` or `.` are ignored. Images and other assets can sit next to the screens and be linked relatively.

## What is already provided

The server injects these into every screen, so **never add them yourself**:

- Tailwind CSS v4 (bundled, works offline). Use utility classes directly.
- A base reset and the Inter font (`font-sans`).
- Live reload: saved files appear in the browser immediately.
- `<meta charset>` and the viewport meta tag.

No `<script src=...tailwind...>`, no `<link>` to fonts or CDNs, no build step, no npm installs. A screen file can be just the body content:

```html
<title>Login</title>
<main class="min-h-dvh grid place-items-center bg-zinc-50 p-6">
  <x-card title="Welcome back">
    <x-button label="Sign in" />
  </x-card>
</main>
```

Put design tokens in `protodeck/theme.css` as Tailwind v4 theme CSS, for example `@theme { --color-brand: #4f46e5; }`, then use `bg-brand`.

## Components

`protodeck/components/<name>.html` is used as `<x-<name>>` in any screen or other component. Do not import components.

- Attributes become parameters: `{{label}}`, with a fallback `{{label | Continue}}`.
- Children go where the component has `<slot></slot>`.
- Both `<x-button label="Save" />` and `<x-card title="Hi">...</x-card>` work.

```html
<!-- components/button.html -->
<button class="inline-flex h-10 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white {{class}}">
  {{label | Continue}}
</button>
```

Extract a component as soon as a piece of UI repeats across screens. An unknown `<x-name>` renders as a red placeholder that names the missing file.

## Running the server

Start it once, in the background, from the project root:

```
npx protodeck
```

(`bunx protodeck` works too.) It prints a URL, by default http://127.0.0.1:4321/. Tell the user to open it: every screen is shown side by side in MacBook, iPhone and Samsung frames, with a chat bar at the bottom that sends instructions back to an agent. If the server is already running, do not start a second one: saving files is enough. Run `npx protodeck init` first if `protodeck/` does not exist yet.

## Working style

- Design for every frame: screens are shown at desktop, iPhone and Android widths at the same time, so use responsive classes (`sm:`, `md:`, `lg:`).
- Use realistic content, not lorem ipsum. Give each screen a `<title>`; the gallery uses it as the screen name.
- Link screens to each other with normal links (`<a href="/checkout/">`) so flows can be clicked through.
- Keep JavaScript minimal and inline, only for interactions that matter to the design.
- When a request comes from the protodeck chat bar, it includes the current screen, the device frame and the selected element. Edit the file that renders that element: if it comes from a component, edit the component file.
