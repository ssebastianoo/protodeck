// Injected into every screen: live reload, scroll restore and the element picker used by the gallery.
(() => {
  "use strict";
  if (window.__protodeckClient) return;
  window.__protodeckClient = true;

  let inGallery = false;
  try {
    inGallery = window.parent !== window && !!window.parent.__protodeckGallery;
  } catch {}

  // ---------- scroll restore across reloads ----------
  const scrollKey = "protodeck:scroll:" + window.name + ":" + location.pathname;
  try {
    const saved = sessionStorage.getItem(scrollKey);
    if (saved) {
      sessionStorage.removeItem(scrollKey);
      const [x, y] = JSON.parse(saved);
      const restore = () => window.scrollTo(x, y);
      if (document.readyState === "complete") restore();
      else window.addEventListener("load", restore, { once: true });
      setTimeout(restore, 120);
    }
  } catch {}
  window.addEventListener("beforeunload", () => {
    try {
      sessionStorage.setItem(scrollKey, JSON.stringify([window.scrollX, window.scrollY]));
    } catch {}
  });

  // ---------- theme (data-theme on <html> drives Tailwind's dark: variant) ----------
  // Pages that use dark: classes also get the native dark color scheme (form controls, scrollbars, canvas).
  let theme = document.documentElement.getAttribute("data-protodeck-theme") === "dark" ? "dark" : "light";
  const paintScheme = () => {
    const root = document.documentElement;
    if (theme === "dark" && document.querySelector('[class*="dark:"]')) root.setAttribute("data-protodeck-scheme", "dark");
    else root.removeAttribute("data-protodeck-scheme");
  };
  const setTheme = (t) => {
    theme = t === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-protodeck-theme", theme);
    paintScheme();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paintScheme, { once: true });
  else paintScheme();

  // ---------- live reload (standalone tabs only; the gallery reloads its frames itself) ----------
  if (!inGallery) {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => setTheme(mq.matches ? "dark" : "light"));
    const es = new EventSource("/__protodeck/events");
    let down = false;
    es.addEventListener("change", (e) => {
      const { files } = JSON.parse(e.data);
      // Skip reloads caused only by other screens' index.html files.
      const here = location.pathname.replace(/^\//, "");
      if (files.length === 0 || files.some((f) => !f.endsWith("index.html") || f.startsWith(here))) location.reload();
    });
    es.addEventListener("hello", () => {
      if (down) location.reload();
    });
    es.onerror = () => {
      down = true;
    };
    return;
  }

  // ---------- gallery bridge ----------
  const parent = window.parent;
  const send = (msg) => parent.postMessage(msg, location.origin);

  function selectorFor(node) {
    const parts = [];
    let el = node;
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id) {
        parts.unshift("#" + CSS.escape(el.id));
        break;
      }
      let part = el.tagName.toLowerCase();
      const p = el.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = p;
    }
    return parts.join(" > ");
  }

  /** Component names wrapping the element, innermost first, from the <!--x:name--> markers. */
  function componentsFor(node) {
    const out = [];
    let n = node;
    while (n && n !== document.body && n !== document.documentElement) {
      let depth = 0;
      for (let s = n.previousSibling; s; s = s.previousSibling) {
        if (s.nodeType !== 8) continue;
        const t = s.data.trim();
        if (t.startsWith("/x:")) depth++;
        else if (t.startsWith("x:")) {
          if (depth === 0) out.push(t.slice(2));
          else depth--;
        }
      }
      n = n.parentNode;
    }
    return out;
  }

  function label(node) {
    let s = node.tagName.toLowerCase();
    if (node.id) s += "#" + node.id;
    const cls = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += "." + cls.join(".");
    return s;
  }

  // ---------- autofill ----------
  // Password managers pop suggestions over login forms in every frame, which is noise on a canvas
  // of prototypes. iCloud Passwords even focuses the login field by itself when the page loads,
  // and the focus opens its popup. So focus that doesn't follow the user's own click, tap or key
  // press is undone here before other listeners see it. This also stops prototypes' autofocus
  // from pulling focus into a frame.
  let lastGesture = -Infinity;
  for (const type of ["pointerdown", "mousedown", "touchstart", "keydown"])
    window.addEventListener(type, () => (lastGesture = performance.now()), true);
  window.addEventListener(
    "focusin",
    (e) => {
      if (performance.now() - lastGesture < 1000) return;
      const t = e.target;
      if (!t || !t.matches || !t.matches("input, textarea, select, [contenteditable]")) return;
      e.stopImmediatePropagation();
      t.blur();
    },
    true
  );

  // Fields also opt out of autofill for managers that respect these attributes (1Password,
  // LastPass, Bitwarden). They are stripped again from the HTML sent to the agent, so they never
  // end up in the screen files.
  const AF_ATTRS = { autocomplete: "off", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" };
  const AF_MARK = "data-protodeck-af";
  const FIELDS = "form, input, textarea, select";
  function quietField(el) {
    if (el.hasAttribute(AF_MARK)) return;
    const added = Object.keys(AF_ATTRS).filter((a) => !el.hasAttribute(a));
    for (const a of added) el.setAttribute(a, AF_ATTRS[a]);
    el.setAttribute(AF_MARK, added.join(" "));
  }
  function quietAutofill(root) {
    if (root.matches && root.matches(FIELDS)) quietField(root);
    if (root.querySelectorAll) for (const el of root.querySelectorAll(FIELDS)) quietField(el);
  }
  function unquiet(root) {
    for (const el of [root, ...root.querySelectorAll("[" + AF_MARK + "]")]) {
      const added = el.getAttribute && el.getAttribute(AF_MARK);
      if (added == null) continue;
      for (const a of added.split(" ")) if (a) el.removeAttribute(a);
      el.removeAttribute(AF_MARK);
    }
    return root;
  }
  quietAutofill(document);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) quietAutofill(n);
  }).observe(document.documentElement, { childList: true, subtree: true });

  function htmlOf(node) {
    let html = unquiet(node.cloneNode(true)).outerHTML.replace(/<!--\/?x:[\w-]+-->/g, "");
    if (html.length > 4000) html = html.slice(0, 4000) + "\n<!-- … truncated … -->";
    return html;
  }

  function describe(node) {
    return { selector: selectorFor(node), html: htmlOf(node), components: componentsFor(node), label: label(node) };
  }

  function box(color, fill) {
    const b = document.createElement("div");
    b.setAttribute("data-protodeck-overlay", "");
    Object.assign(b.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483647",
      border: `2px solid ${color}`,
      background: fill,
      borderRadius: "3px",
      display: "none",
      transition: "all 60ms ease-out",
    });
    return b;
  }
  const hoverBox = box("#6366f1", "rgba(99,102,241,0.12)");
  const selectBox = box("#6366f1", "transparent");
  selectBox.style.boxShadow = "0 0 0 4px rgba(99,102,241,0.25)";
  const mount = () => document.documentElement.append(hoverBox, selectBox);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  function place(b, node) {
    if (!node) return void (b.style.display = "none");
    const r = node.getBoundingClientRect();
    Object.assign(b.style, { display: "block", left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + 4 + "px", height: r.height + 4 + "px" });
  }

  let picking = false;
  let hovered = null;
  let selected = null;

  const validTarget = (t) => t && t.nodeType === 1 && t !== document.documentElement && !t.hasAttribute("data-protodeck-overlay");

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!picking) return;
      const t = e.target;
      if (!validTarget(t) || t === hovered) return;
      hovered = t;
      place(hoverBox, t);
    },
    true
  );

  const swallow = (e) => {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  for (const type of ["mousedown", "mouseup", "pointerup", "submit", "dblclick"]) document.addEventListener(type, swallow, true);

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (picking) return swallow(e);
      send({ type: "protodeck:focus" });
    },
    true
  );

  // Right-click opens the gallery's frame menu. Shift + right-click keeps the browser's own menu.
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (e.shiftKey) return;
      e.preventDefault();
      if (picking) return;
      send({ type: "protodeck:contextmenu", x: e.clientX, y: e.clientY });
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!picking) return;
      swallow(e);
      const t = e.target;
      if (!validTarget(t)) return;
      selected = t;
      place(selectBox, selected);
      send({ type: "protodeck:picked", ...describe(t) });
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && picking) send({ type: "protodeck:cancel" });
      // Canvas zoom shortcuts work while a frame has focus too.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) {
        e.preventDefault();
        send({ type: "protodeck:key", key: e.key, mod: true });
      }
    },
    true
  );

  // Pinch and Ctrl/⌘ + wheel over a frame zoom the gallery canvas instead of the page, as they do over the background.
  let gesturing = false;
  window.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!gesturing) send({ type: "protodeck:zoom", deltaY: e.deltaY, deltaMode: e.deltaMode, x: e.clientX, y: e.clientY });
    },
    { passive: false }
  );
  // Safari reports pinches as gesture events, which don't reach the parent page on their own.
  for (const phase of ["start", "change", "end"])
    window.addEventListener("gesture" + phase, (e) => {
      e.preventDefault();
      gesturing = phase !== "end";
      send({ type: "protodeck:gesture", phase, scale: e.scale, x: e.clientX, y: e.clientY });
    });

  const follow = () => {
    if (selected) place(selectBox, selected.isConnected ? selected : null);
    if (hovered && picking) place(hoverBox, hovered);
  };
  window.addEventListener("scroll", follow, true);
  window.addEventListener("resize", follow);
  // Tailwind compiles styles after load, so keep the outline in sync with layout shifts.
  setInterval(() => selected && follow(), 400);

  window.addEventListener("message", (e) => {
    if (e.source !== parent || e.origin !== location.origin || !e.data) return;
    const d = e.data;
    if (d.type === "protodeck:pick") {
      picking = !!d.on;
      document.documentElement.style.cursor = picking ? "crosshair" : "";
      if (!picking) {
        hovered = null;
        place(hoverBox, null);
      }
    } else if (d.type === "protodeck:theme") {
      setTheme(d.theme);
    } else if (d.type === "protodeck:highlight") {
      if (!d.selector) {
        selected = null;
        return place(selectBox, null);
      }
      let node = null;
      try {
        node = document.querySelector(d.selector);
      } catch {}
      selected = node;
      place(selectBox, node);
      send(node ? { type: "protodeck:refresh", ...describe(node) } : { type: "protodeck:refresh", missing: true });
    }
  });

  const ready = () => send({ type: "protodeck:ready" });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
