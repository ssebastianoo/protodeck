// HTML processing: component expansion and head injection.

export type ComponentLoader = (name: string) => string | undefined;

const MAX_DEPTH = 24;

interface Attr {
  name: string;
  value: string;
}

/** Parses the attribute section of a tag, starting at `i`. Returns attrs and the index after `>`. */
function parseTag(src: string, i: number): { attrs: Attr[]; end: number; selfClosing: boolean } | null {
  const attrs: Attr[] = [];
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === ">") return { attrs, end: i + 1, selfClosing: false };
    if (src[i] === "/" && src[i + 1] === ">") return { attrs, end: i + 2, selfClosing: true };
    const nameStart = i;
    while (i < n && !/[\s=>]/.test(src[i]) && !(src[i] === "/" && src[i + 1] === ">")) i++;
    const name = src.slice(nameStart, i);
    if (!name) return null;
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] !== "=") {
      attrs.push({ name, value: "" });
      continue;
    }
    i++;
    while (i < n && /\s/.test(src[i])) i++;
    let value: string;
    const q = src[i];
    if (q === '"' || q === "'") {
      const close = src.indexOf(q, i + 1);
      if (close < 0) return null;
      value = src.slice(i + 1, close);
      i = close + 1;
    } else {
      const start = i;
      while (i < n && !/[\s>]/.test(src[i])) i++;
      value = src.slice(start, i);
    }
    attrs.push({ name, value });
  }
  return null;
}

/** Finds the `</x-name>` that closes the tag whose content starts at `from`, honoring nesting. */
function findClose(src: string, name: string, from: number): { start: number; end: number } | null {
  const re = new RegExp(`<(/?)x-${name.replace(/[-]/g, "\\-")}(?=[\\s/>])`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) {
      depth--;
      if (depth === 0) {
        const end = src.indexOf(">", m.index);
        return end < 0 ? null : { start: m.index, end: end + 1 };
      }
    } else {
      const tag = parseTag(src, m.index + m[0].length);
      if (tag && !tag.selfClosing) depth++;
      if (tag) re.lastIndex = tag.end;
    }
  }
  return null;
}

/**
 * Fills a component template: `{{name}}` / `{{name | fallback}}` take attribute values,
 * `<slot></slot>` or `<slot />` takes the tag's children.
 */
export function fillTemplate(template: string, attrs: Attr[], children: string): string {
  const map = new Map<string, string>();
  for (const a of attrs) map.set(a.name.toLowerCase(), a.value);
  let out = template.replace(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g, (_, key: string, fallback?: string) => {
    const v = map.get(key.toLowerCase());
    if (v !== undefined) return v;
    if (key === "children") return children;
    return fallback !== undefined ? fallback.trim() : "";
  });
  out = out.replace(/<slot\s*(?:\/>|>\s*<\/slot>)/gi, children);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Replaces every `<x-name ...>` tag with the component file `components/name.html`. */
export function expandComponents(src: string, load: ComponentLoader, depth = 0): string {
  if (depth > MAX_DEPTH) return src;
  const open = /<x-([a-z0-9][\w-]*)(?=[\s/>])/gi;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src))) {
    const name = m[1].toLowerCase();
    const tag = parseTag(src, m.index + m[0].length);
    if (!tag) continue;
    let children = "";
    let end = tag.end;
    if (!tag.selfClosing) {
      const close = findClose(src, name, tag.end);
      if (close) {
        children = src.slice(tag.end, close.start);
        end = close.end;
      }
    }
    const template = load(name);
    let replacement: string;
    if (template === undefined) {
      replacement =
        `<div data-protodeck-missing="${escapeHtml(name)}" style="border:1px dashed #e11d48;color:#e11d48;padding:6px 10px;font:12px/1.4 ui-monospace,monospace;border-radius:6px">` +
        `Unknown component &lt;x-${escapeHtml(name)}&gt;: create components/${escapeHtml(name)}.html</div>`;
    } else {
      const filled = fillTemplate(template, tag.attrs, expandComponents(children, load, depth + 1));
      replacement = `<!--x:${name}-->${expandComponents(filled, load, depth + 1)}<!--/x:${name}-->`;
    }
    out += src.slice(last, m.index) + replacement;
    last = end;
    open.lastIndex = end;
  }
  return out + src.slice(last);
}

export interface InjectOptions {
  version: string;
  theme?: string;
}

/** Builds the tags injected at the top of every screen's <head>. */
export function headTags(opts: InjectOptions): string {
  const v = encodeURIComponent(opts.version);
  const theme = opts.theme ? `\n<style type="text/tailwindcss">\n${opts.theme}\n</style>` : "";
  return (
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<link rel="stylesheet" href="/__protodeck/base.css?v=${v}">` +
    `<script src="/__protodeck/tailwind.js?v=${v}"></script>` +
    `<style type="text/tailwindcss">@theme { --font-sans: "Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif; }</style>` +
    theme +
    `<script src="/__protodeck/client.js?v=${v}" defer></script>`
  );
}

/** Expands components and injects the head tags, adding html/head wrappers when the file has none. */
export function renderPage(src: string, load: ComponentLoader, opts: InjectOptions): string {
  let html = expandComponents(src, load);
  const tags = headTags(opts);
  if (/<head[\s>]/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (h) => h + tags);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (h) => `${h}<head>${tags}</head>`);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) html = html.slice(doctype[0].length);
  // Fragments often start with <title>; move it into the generated head.
  let title = "";
  html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, (t) => ((title = t), ""));
  return `<!doctype html><html lang="en"><head>${tags}${title}</head><body>${html}</body></html>`;
}
