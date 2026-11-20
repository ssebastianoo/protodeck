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

  // ---------- live reload (standalone tabs only; the gallery reloads its frames itself) ----------
  if (!inGallery) {
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

  function htmlOf(node) {
    let html = node.outerHTML.replace(/<!--\/?x:[\w-]+-->/g, "");
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
    },
    true
  );

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
