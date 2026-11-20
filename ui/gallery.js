(() => {
  "use strict";
  const BOOT = window.__protodeckGallery;
  const $ = (id) => document.getElementById(id);

  const DEVICES = [
    { id: "macbook", name: "MacBook Air 13″", w: 1470, h: 956, type: "laptop", on: true },
    { id: "iphone", name: "iPhone 16 Pro", w: 402, h: 874, type: "iphone", on: true },
    { id: "galaxy", name: "Samsung Galaxy S24", w: 360, h: 780, type: "android", on: true },
    { id: "pixel", name: "Google Pixel 9", w: 412, h: 923, type: "android", on: false },
    { id: "iphone-se", name: "iPhone SE", w: 375, h: 667, type: "classic", on: false },
    { id: "ipad", name: "iPad Air 11″", w: 820, h: 1180, type: "tablet", on: false },
    { id: "desktop", name: "Desktop 1920", w: 1920, h: 1080, type: "monitor", on: false },
  ];

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("protodeck:" + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("protodeck:" + k, JSON.stringify(v));
      } catch {}
    },
  };

  const state = {
    screens: [],
    components: [],
    enabled: new Set(store.get("devices", DEVICES.filter((d) => d.on).map((d) => d.id))),
    size: store.get("size", 560),
    sameHeight: store.get("sameHeight", true),
    current: null, // { screen, device }
    selection: null, // { screen, device, selector, html, components }
    picking: false,
    busy: false,
    frames: new Map(), // iframe -> { screen, device, figure }
  };

  // ---------- device frames ----------
  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function screenEl(screen, device) {
    const wrap = el("div", "screen-el");
    wrap.style.width = device.w + "px";
    wrap.style.height = device.h + "px";
    const frame = el("iframe", "", {
      src: "/" + screen.path,
      name: "protodeck-" + device.id,
      width: device.w,
      height: device.h,
      loading: "lazy",
      title: `${screen.title} on ${device.name}`,
    });
    wrap.appendChild(frame);
    return { wrap, frame };
  }

  function buildShell(screen, device) {
    const { wrap, frame } = screenEl(screen, device);
    let shell;
    switch (device.type) {
      case "iphone":
        shell = el("div", "shell shell-phone");
        wrap.appendChild(el("div", "island"));
        shell.appendChild(wrap);
        break;
      case "android":
        shell = el("div", "shell shell-phone shell-android");
        wrap.appendChild(el("div", "punch"));
        shell.appendChild(wrap);
        break;
      case "classic":
        shell = el("div", "shell shell-phone shell-classic");
        shell.appendChild(wrap);
        break;
      case "tablet":
        shell = el("div", "shell shell-tablet");
        shell.appendChild(wrap);
        break;
      case "laptop": {
        shell = el("div", "shell shell-laptop");
        const lid = el("div", "laptop-lid");
        lid.append(el("div", "laptop-notch"), wrap);
        shell.append(lid, el("div", "laptop-base"));
        break;
      }
      default: {
        shell = el("div", "shell shell-monitor");
        const panel = el("div", "monitor-panel");
        panel.appendChild(wrap);
        shell.append(panel, el("div", "monitor-neck"), el("div", "monitor-foot"));
      }
    }
    return { shell, frame };
  }

  function scaleFor(nativeH) {
    return state.sameHeight ? state.size / nativeH : state.size / 1150;
  }

  function layoutFigure(fig) {
    const body = fig.querySelector(".body");
    const sizer = fig.querySelector(".sizer");
    const w = body.offsetWidth;
    const h = body.offsetHeight;
    const s = scaleFor(h);
    body.style.transform = `scale(${s})`;
    sizer.style.width = w * s + "px";
    sizer.style.height = h * s + "px";
  }

  function buildFigure(screen, device) {
    const fig = el("figure", "device");
    fig.dataset.device = device.id;
    const sizer = el("div", "sizer");
    const body = el("div", "body");
    const { shell, frame } = buildShell(screen, device);
    body.appendChild(shell);
    sizer.appendChild(body);
    const cap = el("figcaption");
    cap.textContent = `${device.name} · ${device.w}×${device.h}`;
    fig.append(sizer, cap);
    state.frames.set(frame, { screen: screen.path, device: device.id, figure: fig });
    fig.addEventListener("click", () => setCurrent(screen.path, device.id));
    return fig;
  }

  function buildScreenRow(screen) {
    const sec = el("section", "screen");
    sec.dataset.path = screen.path;
    const head = el("div", "screen-head");
    const h2 = el("h2");
    h2.textContent = screen.title;
    const a = el("a", "", { href: "/" + screen.path, target: "_blank", rel: "noopener" });
    a.textContent = "/" + screen.path;
    head.append(h2, a);
    const frames = el("div", "frames");
    sec.append(head, frames);
    for (const d of DEVICES) if (state.enabled.has(d.id)) frames.appendChild(buildFigure(screen, d));
    return sec;
  }

  function forgetFrames(root) {
    for (const f of root.querySelectorAll("iframe")) state.frames.delete(f);
  }

  function renderScreens(full) {
    const host = $("screens");
    if (full) {
      forgetFrames(host);
      host.textContent = "";
    }
    const existing = new Map([...host.children].map((n) => [n.dataset.path, n]));
    const wanted = new Set(state.screens.map((s) => s.path));
    for (const [path, node] of existing)
      if (!wanted.has(path)) {
        forgetFrames(node);
        node.remove();
      }
    let prev = null;
    for (const s of state.screens) {
      let node = existing.get(s.path);
      if (!node || !node.isConnected) {
        node = buildScreenRow(s);
        if (prev) prev.after(node);
        else host.prepend(node);
        for (const fig of node.querySelectorAll("figure")) layoutFigure(fig);
      } else {
        const h2 = node.querySelector("h2");
        if (h2.textContent !== s.title) h2.textContent = s.title;
        if (prev ? prev.nextSibling !== node : host.firstChild !== node) prev ? prev.after(node) : host.prepend(node);
      }
      prev = node;
    }
    $("empty").hidden = state.screens.length > 0;
    $("summary").textContent = `${state.screens.length} screen${state.screens.length === 1 ? "" : "s"}`;
    if (!state.current || !state.screens.some((s) => s.path === state.current.screen)) {
      const first = state.screens[0];
      const dev = DEVICES.find((d) => state.enabled.has(d.id));
      state.current = first && dev ? { screen: first.path, device: dev.id } : null;
    } else if (!state.enabled.has(state.current.device)) {
      const dev = DEVICES.find((d) => state.enabled.has(d.id));
      state.current = dev ? { screen: state.current.screen, device: dev.id } : null;
    }
    paintCurrent();
  }

  function renderComponents() {
    const grid = $("components");
    const have = [...grid.children].map((n) => n.dataset.name).join(",");
    if (have === state.components.join(",")) return;
    grid.textContent = "";
    for (const name of state.components) {
      const card = el("div", "component-card");
      card.dataset.name = name;
      const f = el("iframe", "", { src: `/__protodeck/component?name=${encodeURIComponent(name)}`, loading: "lazy", title: name });
      const label = el("div");
      label.textContent = `<x-${name}>`;
      card.append(f, label);
      grid.appendChild(card);
    }
    $("componentsSection").hidden = state.components.length === 0;
  }

  function relayoutAll() {
    for (const fig of document.querySelectorAll("#screens figure")) layoutFigure(fig);
  }

  function renderDeviceToggles() {
    const host = $("devices");
    host.textContent = "";
    for (const d of DEVICES) {
      const b = el("button", "", { type: "button", "aria-pressed": String(state.enabled.has(d.id)), title: `${d.w}×${d.h}` });
      b.textContent = d.name;
      b.addEventListener("click", () => {
        if (state.enabled.has(d.id)) {
          if (state.enabled.size === 1) return;
          state.enabled.delete(d.id);
        } else state.enabled.add(d.id);
        store.set("devices", [...state.enabled]);
        renderDeviceToggles();
        renderScreens(true);
      });
      host.appendChild(b);
    }
  }

  // ---------- current target & selection ----------
  function deviceById(id) {
    return DEVICES.find((d) => d.id === id);
  }
  function screenByPath(p) {
    return state.screens.find((s) => s.path === p);
  }

  function setCurrent(screen, device) {
    if (state.current && state.current.screen === screen && state.current.device === device) return;
    state.current = { screen, device };
    if (state.selection && (state.selection.screen !== screen || state.selection.device !== device)) clearSelection();
    paintCurrent();
  }

  function paintCurrent() {
    for (const [, info] of state.frames)
      info.figure.classList.toggle("current", !!state.current && info.screen === state.current.screen && info.device === state.current.device);
    const chip = $("targetChip");
    if (state.current) {
      const s = screenByPath(state.current.screen);
      const d = deviceById(state.current.device);
      chip.textContent = `${s ? s.title : state.current.screen} · ${d ? d.name : ""}`;
      chip.hidden = false;
    } else chip.hidden = true;
  }

  function frameFor(screen, device) {
    for (const [f, info] of state.frames) if (info.screen === screen && info.device === device) return f;
    return null;
  }

  function post(frame, msg) {
    try {
      frame.contentWindow && frame.contentWindow.postMessage(msg, location.origin);
    } catch {}
  }

  function setPicking(on) {
    state.picking = on;
    $("pick").setAttribute("aria-pressed", String(on));
    document.body.classList.toggle("picking", on);
    for (const f of state.frames.keys()) post(f, { type: "protodeck:pick", on });
  }

  function clearSelection() {
    if (!state.selection) return;
    const f = frameFor(state.selection.screen, state.selection.device);
    if (f) post(f, { type: "protodeck:highlight", selector: null });
    state.selection = null;
    paintSelection();
  }

  function paintSelection() {
    const chip = $("elementChip");
    if (!state.selection) return void (chip.hidden = true);
    const comp = state.selection.components && state.selection.components[0];
    $("elementLabel").textContent = (comp ? `<x-${comp}> ` : "") + state.selection.label;
    chip.title = state.selection.selector;
    chip.hidden = false;
  }

  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || typeof e.data.type !== "string") return;
    const frame = [...state.frames.keys()].find((f) => f.contentWindow === e.source);
    if (!frame) return;
    const info = state.frames.get(frame);
    const d = e.data;
    switch (d.type) {
      case "protodeck:ready":
        if (state.picking) post(frame, { type: "protodeck:pick", on: true });
        if (state.selection && state.selection.screen === info.screen && state.selection.device === info.device)
          post(frame, { type: "protodeck:highlight", selector: state.selection.selector });
        break;
      case "protodeck:focus":
        setCurrent(info.screen, info.device);
        break;
      case "protodeck:picked":
        setCurrent(info.screen, info.device);
        state.selection = { screen: info.screen, device: info.device, selector: d.selector, html: d.html, components: d.components, label: d.label };
        paintSelection();
        setPicking(false);
        $("input").focus();
        break;
      case "protodeck:refresh":
        if (state.selection && state.selection.screen === info.screen && state.selection.device === info.device) {
          if (d.missing) clearSelection();
          else Object.assign(state.selection, { html: d.html, components: d.components, label: d.label });
          paintSelection();
        }
        break;
      case "protodeck:cancel":
        setPicking(false);
        break;
    }
  });

  // ---------- live reload ----------
  function reloadFor(files) {
    const screenPaths = state.screens.map((s) => s.path);
    const affected = new Set();
    let all = false;
    for (const f of files) {
      const hit = screenPaths.filter((p) => f.startsWith(p));
      if (hit.length) hit.forEach((p) => affected.add(p));
      else all = true;
    }
    for (const [f, info] of state.frames) {
      if (all || affected.has(info.screen)) {
        try {
          f.contentWindow.location.reload();
        } catch {
          f.src = f.src;
        }
      }
    }
    if (all || files.some((f) => f.startsWith("components/"))) {
      for (const f of document.querySelectorAll("#components iframe")) {
        try {
          f.contentWindow.location.reload();
        } catch {}
      }
    }
  }

  function connect() {
    const es = new EventSource("/__protodeck/events");
    es.addEventListener("change", (e) => {
      const data = JSON.parse(e.data);
      state.screens = data.screens;
      state.components = data.components;
      renderScreens(false);
      renderComponents();
      reloadFor(data.files);
    });
    es.addEventListener("agent", (e) => onAgent(JSON.parse(e.data)));
    let wasDown = false;
    es.addEventListener("hello", () => {
      if (wasDown) loadState(true);
      wasDown = false;
    });
    es.onerror = () => {
      wasDown = true;
    };
  }

  // ---------- chat ----------
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function richText(s) {
    return escapeHtml(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }

  function addLog(ev, scroll = true) {
    const log = $("log");
    const n = el("div", "msg msg-" + (ev.kind === "start" ? "user" : ev.kind));
    if (ev.kind === "done") n.textContent = ev.text || "Done";
    else if (ev.kind === "text") n.innerHTML = richText(ev.text || "");
    else n.textContent = ev.text || "";
    log.appendChild(n);
    $("toggleLog").hidden = false;
    if (scroll) log.scrollTop = log.scrollHeight;
  }

  function setBusy(busy) {
    state.busy = busy;
    const st = $("status");
    st.classList.toggle("busy", busy);
    st.textContent = busy ? "Working…" : agentLabel();
    if ($("send")) {
      $("send").hidden = busy;
      $("stop").hidden = !busy;
    }
  }

  function agentLabel() {
    return { claude: "Claude Code", codex: "Codex", custom: "Custom agent", none: "No agent" }[BOOT.agent] || BOOT.agent;
  }

  function onAgent(ev) {
    if (ev.kind === "start") {
      setBusy(true);
      $("log").hidden = false;
    }
    addLog(ev);
    if (ev.kind === "done") setBusy(false);
  }

  async function api(path, body) {
    const res = await fetch("/__protodeck/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-protodeck-token": BOOT.token },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async function send() {
    const input = $("input");
    const message = input.value.trim();
    if (!message || state.busy) return;
    const ctx = { message };
    if (state.current) {
      ctx.screen = state.current.screen;
      const d = deviceById(state.current.device);
      if (d) ctx.device = { name: d.name, width: d.w, height: d.h };
    }
    if (state.selection) ctx.element = { selector: state.selection.selector, html: state.selection.html, components: state.selection.components };
    try {
      await api("chat", ctx);
      input.value = "";
      autosize();
    } catch (err) {
      $("log").hidden = false;
      addLog({ kind: "error", text: err.message });
    }
  }

  function autosize() {
    const t = $("input");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 160) + "px";
  }

  // ---------- boot ----------
  async function loadState(silent) {
    const data = await fetch("/__protodeck/state").then((r) => r.json());
    state.screens = data.screens;
    state.components = data.components;
    $("emptyPath").textContent = `${data.root}/home/index.html`;
    renderScreens(false);
    renderComponents();
    if (!silent) {
      $("log").textContent = "";
      for (const ev of data.agent.history) addLog(ev, false);
      $("log").scrollTop = $("log").scrollHeight;
    }
    setBusy(data.agent.busy);
  }

  function init() {
    $("zoom").value = state.size;
    $("zoom").addEventListener("input", (e) => {
      state.size = Number(e.target.value);
      store.set("size", state.size);
      relayoutAll();
    });
    const modeBtn = $("scaleMode");
    const paintMode = () => (modeBtn.textContent = state.sameHeight ? "Same height" : "True size");
    paintMode();
    modeBtn.addEventListener("click", () => {
      state.sameHeight = !state.sameHeight;
      store.set("sameHeight", state.sameHeight);
      paintMode();
      relayoutAll();
    });
    renderDeviceToggles();

    if (BOOT.agent === "none") {
      $("composer").querySelector(".row").innerHTML =
        '<p class="disabled-note">Chat is off: no agent found. Restart with <code>--agent claude</code>, <code>--agent codex</code> or <code>--agent "your-cli {prompt}"</code>.</p>';
      $("newChat").hidden = true;
    } else {
      $("composer").addEventListener("submit", (e) => {
        e.preventDefault();
        send();
      });
      $("input").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          send();
        }
      });
      $("input").addEventListener("input", autosize);
      $("pick").addEventListener("click", () => setPicking(!state.picking));
      $("clearElement").addEventListener("click", clearSelection);
      $("stop").addEventListener("click", () => api("stop").catch(() => {}));
      $("toggleLog").addEventListener("click", () => ($("log").hidden = !$("log").hidden));
      $("newChat").addEventListener("click", async () => {
        try {
          await api("reset");
          $("log").textContent = "";
          $("log").hidden = true;
          $("toggleLog").hidden = true;
        } catch (err) {
          addLog({ kind: "error", text: err.message });
        }
      });
      $("targetChip").addEventListener("click", () => {
        const f = state.current && frameFor(state.current.screen, state.current.device);
        if (f) f.closest("figure").scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.picking) setPicking(false);
    });
    setBusy(false);
    loadState(false).then(connect);
  }

  init();
})();
