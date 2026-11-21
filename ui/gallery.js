(() => {
  "use strict";
  const BOOT = window.__protodeckGallery;
  const $ = (id) => document.getElementById(id);

  const BUILTIN_DEVICES = [
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

  // User-defined sizes, stored per browser: { id, name, w, h }.
  const SIZE_MIN = 100;
  const SIZE_MAX = 4000;
  let customDevices = (() => {
    const list = store.get("customDevices", []);
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const d of list) {
      if (!d || typeof d.id !== "string" || !/^custom-[\w-]+$/.test(d.id) || seen.has(d.id)) continue;
      const w = Math.round(Number(d.w));
      const h = Math.round(Number(d.h));
      if (!(w >= SIZE_MIN && w <= SIZE_MAX && h >= SIZE_MIN && h <= SIZE_MAX)) continue;
      seen.add(d.id);
      out.push({ id: d.id, name: String(d.name || `Custom ${w}×${h}`).slice(0, 60), w, h, type: "custom", custom: true });
    }
    return out;
  })();
  let DEVICES = [...BUILTIN_DEVICES, ...customDevices];

  const ZOOM_MIN = 160;
  const ZOOM_MAX = 1600;
  const ZOOM_DEFAULT = 560;

  const state = {
    screens: [],
    components: [],
    enabled: new Set(store.get("devices", DEVICES.filter((d) => d.on).map((d) => d.id))),
    size: store.get("size", 560),
    sameHeight: store.get("sameHeight", true),
    showComponents: store.get("showComponents", false),
    addingDevice: false,
    routes: (() => {
      const r = store.get("routes", null);
      return Array.isArray(r) && r.length ? new Set(r) : null; // null = all routes
    })(),
    current: null, // { screen, device }
    deselected: false, // true after the user clears the target, so renders don't pick a default
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
      case "custom":
        shell = el("div", "shell shell-plain");
        shell.appendChild(wrap);
        break;
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
    // Right-clicks inside the frame arrive as protodeck:contextmenu; this covers the bezel and caption.
    fig.addEventListener("contextmenu", (e) => {
      if (e.shiftKey) return;
      e.preventDefault();
      setCurrent(screen.path, device.id);
      openFrameMenu(screen.path, device.id, e.clientX, e.clientY);
    });
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

  // Screens shown on the canvas: all of them, or the chosen routes that still exist.
  function visibleScreens() {
    if (!state.routes) return state.screens;
    const picked = state.screens.filter((s) => state.routes.has(s.path));
    return picked.length ? picked : state.screens;
  }

  function renderScreens(full) {
    const host = $("screens");
    const shown = visibleScreens();
    if (full) {
      forgetFrames(host);
      host.textContent = "";
    }
    const existing = new Map([...host.children].map((n) => [n.dataset.path, n]));
    const wanted = new Set(shown.map((s) => s.path));
    for (const [path, node] of existing)
      if (!wanted.has(path)) {
        forgetFrames(node);
        node.remove();
      }
    let prev = null;
    for (const s of shown) {
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
    const n = state.screens.length;
    $("summary").textContent = shown.length < n ? `${shown.length} of ${n} screens` : `${n} screen${n === 1 ? "" : "s"}`;
    // After the user clears the target by clicking the background, keep it cleared until a frame is clicked.
    if (!state.current && state.deselected) state.current = null;
    else if (!state.current || !shown.some((s) => s.path === state.current.screen)) {
      const first = shown[0];
      const dev = DEVICES.find((d) => state.enabled.has(d.id));
      state.current = first && dev ? { screen: first.path, device: dev.id } : null;
    } else if (!state.enabled.has(state.current.device)) {
      const dev = DEVICES.find((d) => state.enabled.has(d.id));
      state.current = dev ? { screen: state.current.screen, device: dev.id } : null;
    }
    paintCurrent();
    renderPickers();
  }

  function renderComponents() {
    const grid = $("components");
    const show = state.showComponents && state.components.length > 0;
    $("componentsSection").hidden = !show;
    if (!show) {
      // Drop the frames so hidden components don't keep loading or reloading.
      grid.textContent = "";
      return;
    }
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
  }

  function relayoutAll() {
    for (const fig of document.querySelectorAll("#screens figure")) layoutFigure(fig);
  }

  // ---------- routes & devices dropdowns ----------
  function menuItem(label, hint, checked, onClick, role = "menuitemcheckbox") {
    const b = el("button", "menu-item", { type: "button", role, "aria-checked": String(checked) });
    b.innerHTML = CHECK + '<span class="name"></span>';
    b.querySelector(".name").textContent = label;
    if (hint) {
      const h = el("span", "hint");
      h.textContent = hint;
      b.appendChild(h);
    }
    b.addEventListener("click", onClick);
    return b;
  }

  function setRoutes(set) {
    state.routes = set && set.size && set.size < state.screens.length ? set : null;
    store.set("routes", state.routes ? [...state.routes] : null);
    renderScreens(false);
    if (state.selection && !visibleScreens().some((s) => s.path === state.selection.screen)) clearSelection();
  }

  function renderRoutesMenu() {
    const menu = $("routesMenu");
    const shown = new Set(visibleScreens().map((s) => s.path));
    const all = shown.size === state.screens.length;
    menu.textContent = "";
    menu.appendChild(menuItem("All routes", String(state.screens.length), all, () => setRoutes(null)));
    if (state.screens.length) menu.appendChild(el("div", "sep"));
    for (const s of state.screens) {
      const on = !all && shown.has(s.path);
      menu.appendChild(
        menuItem(s.title, "/" + s.path, on, () => {
          // From "all", picking a route shows just that route; after that, clicks add or remove routes.
          const next = all ? new Set() : new Set(shown);
          if (on) next.delete(s.path);
          else next.add(s.path);
          setRoutes(next);
        }),
      );
    }
    const label = $("routesLabel");
    if (all) label.textContent = "All";
    else if (shown.size === 1) label.textContent = visibleScreens()[0].title;
    else label.textContent = `${shown.size} routes`;
    $("routesBtn").title = all ? "Showing all routes" : visibleScreens().map((s) => "/" + s.path).join("\n");
  }

  function saveCustomDevices() {
    store.set("customDevices", customDevices.map(({ id, name, w, h }) => ({ id, name, w, h })));
    DEVICES = [...BUILTIN_DEVICES, ...customDevices];
  }

  function removeCustomDevice(id) {
    customDevices = customDevices.filter((d) => d.id !== id);
    saveCustomDevices();
    state.enabled.delete(id);
    if (!DEVICES.some((d) => state.enabled.has(d.id))) state.enabled.add(DEVICES[0].id);
    store.set("devices", [...state.enabled]);
    renderScreens(true);
  }

  function customDeviceForm() {
    const form = el("form", "custom-form");
    form.innerHTML =
      '<input class="full" name="name" placeholder="Name (optional)" autocomplete="off" aria-label="Device name">' +
      '<input name="w" type="number" min="100" max="4000" placeholder="Width" required aria-label="Width in pixels">' +
      '<input name="h" type="number" min="100" max="4000" placeholder="Height" required aria-label="Height in pixels">' +
      '<p class="err" hidden></p>' +
      '<div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Add</button></div>';
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const w = Math.round(Number(form.elements.w.value));
      const h = Math.round(Number(form.elements.h.value));
      if (!(w >= SIZE_MIN && w <= SIZE_MAX && h >= SIZE_MIN && h <= SIZE_MAX)) {
        const err = form.querySelector(".err");
        err.textContent = "Width and height must be between 100 and 4000 px.";
        err.hidden = false;
        return;
      }
      const name = form.elements.name.value.trim().slice(0, 60) || `Custom ${w}×${h}`;
      const d = { id: "custom-" + Date.now().toString(36), name, w, h, type: "custom", custom: true };
      customDevices.push(d);
      saveCustomDevices();
      state.enabled.add(d.id);
      store.set("devices", [...state.enabled]);
      state.addingDevice = false;
      renderScreens(true);
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => {
      state.addingDevice = false;
      renderDevicesMenu();
    });
    return form;
  }

  function renderDevicesMenu() {
    const menu = $("devicesMenu");
    // Live reload re-renders this menu; keep what was typed in the custom size form.
    const oldForm = menu.querySelector(".custom-form");
    const draft = oldForm && {
      values: { name: oldForm.elements.name.value, w: oldForm.elements.w.value, h: oldForm.elements.h.value },
      focused: oldForm.contains(document.activeElement) ? document.activeElement.name : null,
      err: oldForm.querySelector(".err").hidden ? "" : oldForm.querySelector(".err").textContent,
    };
    menu.textContent = "";
    for (const d of DEVICES) {
      if (d === customDevices[0]) menu.appendChild(el("div", "sep"));
      const on = state.enabled.has(d.id);
      const b = menuItem(d.name, `${d.w}×${d.h}`, on, () => {
        if (on) state.enabled.delete(d.id);
        else state.enabled.add(d.id);
        store.set("devices", [...state.enabled]);
        renderScreens(true);
      });
      if (on && state.enabled.size === 1) b.disabled = true;
      if (d.custom) {
        const x = el("span", "remove", { role: "button", title: `Remove ${d.name}`, "aria-label": `Remove ${d.name}` });
        x.textContent = "×";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          removeCustomDevice(d.id);
        });
        b.appendChild(x);
      }
      menu.appendChild(b);
    }
    menu.appendChild(el("div", "sep"));
    if (state.addingDevice) {
      const form = customDeviceForm();
      menu.appendChild(form);
      if (draft) {
        for (const k in draft.values) form.elements[k].value = draft.values[k];
        if (draft.err) Object.assign(form.querySelector(".err"), { textContent: draft.err, hidden: false });
        if (draft.focused) form.elements[draft.focused].focus();
      } else if (!menu.hidden) requestAnimationFrame(() => form.elements.w.focus());
    } else {
      const add = el("button", "menu-item", { type: "button", role: "menuitem" });
      add.innerHTML = '<svg class="check" style="visibility:visible;color:var(--muted)" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span class="name">Add custom size…</span>';
      add.addEventListener("click", () => {
        state.addingDevice = true;
        renderDevicesMenu();
      });
      menu.appendChild(add);
    }
    const on = DEVICES.filter((d) => state.enabled.has(d.id));
    $("devicesLabel").textContent = on.length === 1 ? on[0].name : on.length === DEVICES.length ? "All" : `${on.length} devices`;
    $("devicesBtn").title = on.map((d) => d.name).join("\n");
  }

  function renderSettingsMenu() {
    const menu = $("settingsMenu");
    menu.textContent = "";
    const n = state.components.length;
    const comp = menuItem("Show components", n ? String(n) : "none yet", state.showComponents, () => {
      state.showComponents = !state.showComponents;
      store.set("showComponents", state.showComponents);
      renderComponents();
      renderSettingsMenu();
    });
    menu.appendChild(comp);
    menu.appendChild(el("div", "sep"));
    menu.appendChild(Object.assign(el("div", "menu-label"), { textContent: "Frame scale" }));
    const setScale = (same) => {
      state.sameHeight = same;
      store.set("sameHeight", same);
      relayoutAll();
      renderSettingsMenu();
    };
    menu.appendChild(menuItem("Same height", "", state.sameHeight, () => setScale(true), "menuitemradio"));
    menu.appendChild(menuItem("True relative size", "", !state.sameHeight, () => setScale(false), "menuitemradio"));
  }

  function renderPickers() {
    renderRoutesMenu();
    renderDevicesMenu();
    renderSettingsMenu();
  }

  const PICKERS = ["routes", "devices", "settings"];
  function openPicker(id) {
    if (id !== "devices" && state.addingDevice) {
      state.addingDevice = false;
      renderDevicesMenu();
    }
    for (const p of PICKERS) {
      const open = p === id;
      $(p + "Menu").hidden = !open;
      $(p + "Btn").setAttribute("aria-expanded", String(open));
    }
  }

  function initPickers() {
    for (const p of PICKERS)
      $(p + "Btn").addEventListener("click", () => openPicker($(p + "Menu").hidden ? p : null));
    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest || !e.target.closest(".picker")) openPicker(null);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = PICKERS.find((p) => !$(p + "Menu").hidden);
      if (open) {
        openPicker(null);
        $(open + "Btn").focus();
      }
    });
    window.addEventListener("blur", () => openPicker(null));
    renderPickers();
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
    state.deselected = false;
    if (state.selection && (state.selection.screen !== screen || state.selection.device !== device)) clearSelection();
    paintCurrent();
  }

  function clearCurrent() {
    if (!state.current) return;
    clearSelection();
    state.current = null;
    state.deselected = true;
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
    // Zoom input comes from screen and component frames alike.
    if (e.data.type === "protodeck:zoom" || e.data.type === "protodeck:key" || e.data.type === "protodeck:gesture") {
      const src = [...document.querySelectorAll("iframe")].find((f) => f.contentWindow === e.source);
      if (src) onFrameZoom(src, e.data);
      return;
    }
    const frame = [...state.frames.keys()].find((f) => f.contentWindow === e.source);
    if (!frame) return;
    const info = state.frames.get(frame);
    const d = e.data;
    switch (d.type) {
      case "protodeck:ready":
        // menu: this frame's right-clicks open the gallery's frame menu (component frames have none).
        post(frame, { type: "protodeck:theme", theme: currentTheme(), menu: true });
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
      case "protodeck:contextmenu": {
        // Frame coordinates are in the frame's own pixels; the frame is scaled on the canvas.
        const r = frame.getBoundingClientRect();
        const s = frame.offsetWidth ? r.width / frame.offsetWidth : 1;
        setCurrent(info.screen, info.device);
        openFrameMenu(info.screen, info.device, r.left + (Number(d.x) || 0) * s, r.top + (Number(d.y) || 0) * s);
        break;
      }

    }
  });

  // ---------- frame context menu ----------
  const MENU_ICONS = {
    png: '<path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="6.2" r="1.1" fill="currentColor"/><path d="m3 12 3.2-3.2 2.3 2.3 1.8-1.8L13 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    html: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    open: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  function closeFrameMenu() {
    const menu = $("frameMenu");
    if (menu) menu.hidden = true;
  }

  function openFrameMenu(screenPath, deviceId, x, y) {
    const screen = screenByPath(screenPath);
    const device = deviceById(deviceId);
    if (!screen || !device) return;
    openPicker(null);
    const menu = $("frameMenu");
    menu.textContent = "";
    menu.appendChild(Object.assign(el("div", "menu-label"), { textContent: `${screen.title} · ${device.name}` }));
    const item = (icon, label, hint, run) => {
      const b = el("button", "menu-item", { type: "button", role: "menuitem" });
      b.innerHTML = `<svg class="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${MENU_ICONS[icon]}</svg><span class="name"></span>`;
      b.querySelector(".name").textContent = label;
      if (hint) b.appendChild(Object.assign(el("span", "hint"), { textContent: hint }));
      b.addEventListener("click", () => {
        closeFrameMenu();
        run();
      });
      menu.appendChild(b);
      return b;
    };
    const job = (format) => () => window.__protodeckExport.exportFrame({ screen, device, format, theme: currentTheme() });
    const first = item("png", "Download PNG", `${device.w}×${device.h}`, job("png"));
    item("html", "Download HTML", "", job("html"));
    menu.appendChild(el("div", "sep"));
    item("open", "Open in new tab", "", () => window.open("/" + screen.path, "_blank", "noopener"));
    menu.hidden = false;
    // Keep the menu inside the window.
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + "px";
    first.focus({ preventScroll: true });
  }

  function initFrameMenu() {
    const menu = $("frameMenu");
    document.addEventListener("pointerdown", (e) => {
      if (!menu.hidden && !menu.contains(e.target)) closeFrameMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (menu.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeFrameMenu();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...menu.querySelectorAll(".menu-item")];
        const i = items.indexOf(document.activeElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
      }
    });
    window.addEventListener("blur", closeFrameMenu);
    window.addEventListener("resize", closeFrameMenu);
    $("canvas").addEventListener("scroll", closeFrameMenu, { passive: true });
    // The background has no menu of its own; don't show the browser's there either.
    $("canvas").addEventListener("contextmenu", (e) => {
      if (!e.shiftKey && !e.target.closest("a")) e.preventDefault();
    });
  }

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
    es.addEventListener("agents", (e) => {
      setAgents(JSON.parse(e.data).agents);
      renderMenu();
    });
    let wasDown = false;
    es.addEventListener("hello", (e) => {
      // A restarted server has a new token (and maybe new UI code): reload, or every POST fails with "Bad token".
      let hello = {};
      try {
        hello = JSON.parse(e.data);
      } catch {}
      if (hello.instance && BOOT.instance && hello.instance !== BOOT.instance) return location.reload();
      if (wasDown) loadState(true);
      wasDown = false;
    });
    es.onerror = () => {
      wasDown = true;
    };
  }

  // ---------- theme ----------
  const currentTheme = () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    window.__protodeckTheme = t;
    for (const f of document.querySelectorAll("iframe")) post(f, { type: "protodeck:theme", theme: t });
    const btn = $("themeBtn");
    const label = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  function initTheme() {
    applyTheme(currentTheme());
    $("themeBtn").addEventListener("click", () => {
      const t = currentTheme() === "dark" ? "light" : "dark";
      store.set("theme", t);
      applyTheme(t);
    });
    // Follow the system until the user picks a theme.
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => {
      const saved = store.get("theme", null);
      if (saved !== "dark" && saved !== "light") applyTheme(mq.matches ? "dark" : "light");
    });
  }

  // ---------- canvas zoom & pan ----------
  const clampSize = (n) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n)));

  /** The figure closest to a viewport point, used to keep that spot still while zooming. */
  function nearestFigure(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const fig of document.querySelectorAll("#screens figure")) {
      const r = fig.querySelector(".sizer").getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = fig;
      }
    }
    return best;
  }

  /** Sets the frame size, keeping the point (x, y) in viewport coordinates fixed. Defaults to the canvas center. */
  function zoomTo(size, x, y) {
    size = clampSize(size);
    if (size === state.size) return;
    const canvas = $("canvas");
    const cr = canvas.getBoundingClientRect();
    if (x == null) {
      x = cr.left + canvas.clientWidth / 2;
      y = cr.top + canvas.clientHeight / 2;
    }
    const anchor = nearestFigure(x, y);
    let fx = 0;
    let fy = 0;
    if (anchor) {
      const r = anchor.querySelector(".sizer").getBoundingClientRect();
      fx = r.width ? (x - r.left) / r.width : 0;
      fy = r.height ? (y - r.top) / r.height : 0;
    }
    state.size = size;
    $("zoom").value = size;
    clearTimeout(zoomTo.saveTimer);
    zoomTo.saveTimer = setTimeout(() => store.set("size", state.size), 250);
    relayoutAll();
    if (anchor && anchor.isConnected) {
      const r = anchor.querySelector(".sizer").getBoundingClientRect();
      canvas.scrollLeft += r.left + fx * r.width - x;
      canvas.scrollTop += r.top + fy * r.height - y;
    }
  }

  function wheelZoom(deltaY, deltaMode, x, y) {
    const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
    const step = Math.max(-60, Math.min(60, px));
    zoomTo(state.size * Math.exp(-step * 0.01), x, y);
  }

  /** Zoom shortcuts; returns true when the key was handled. */
  function zoomKey(key) {
    if (key === "=" || key === "+") zoomTo(state.size * 1.2);
    else if (key === "-" || key === "_") zoomTo(state.size / 1.2);
    else if (key === "0") zoomTo(ZOOM_DEFAULT);
    else return false;
    return true;
  }

  // Pinch state shared by the canvas and frames, so Safari's gesture events and any ctrl+wheel it also sends don't zoom twice.
  const gesture = { active: false, base: 0 };
  function gestureZoom(phase, scale, x, y) {
    if (phase === "start") Object.assign(gesture, { active: true, base: state.size });
    else if (phase === "change" && gesture.active) zoomTo(gesture.base * scale, x, y);
    else if (phase === "end") gesture.active = false;
  }

  /** Zoom input forwarded by client.js from inside a frame; coordinates are the frame's own. */
  function onFrameZoom(frame, d) {
    const r = frame.getBoundingClientRect();
    const k = frame.offsetWidth ? r.width / frame.offsetWidth : 1;
    const x = r.left + (Number(d.x) || 0) * k;
    const y = r.top + (Number(d.y) || 0) * k;
    if (d.type === "protodeck:key") zoomKey(d.key);
    else if (d.type === "protodeck:gesture") gestureZoom(d.phase, Number(d.scale) || 1, x, y);
    else if (!gesture.active) wheelZoom(Number(d.deltaY) || 0, Number(d.deltaMode) || 0, x, y);
  }

  // ---------- infinite canvas ----------
  // The stage gets empty slack on every side, and more is added whenever a scroll gets near an edge,
  // so panning never stops. Growing the left or top side shifts the scroll position to match.
  const SLACK = 20000;
  const ext = { t: SLACK, r: SLACK, b: SLACK, l: SLACK };
  function applyExt() {
    const st = $("stage").style;
    for (const k in ext) st.setProperty("--ext-" + k, ext[k] + "px");
  }
  function growCanvas() {
    const c = $("canvas");
    const w = c.clientWidth;
    const h = c.clientHeight;
    let dx = 0;
    let dy = 0;
    if (c.scrollLeft < w) (ext.l += SLACK), (dx = SLACK);
    if (c.scrollTop < h) (ext.t += SLACK), (dy = SLACK);
    const growR = c.scrollWidth - c.scrollLeft - w < w;
    const growB = c.scrollHeight - c.scrollTop - h < h;
    if (growR) ext.r += SLACK;
    if (growB) ext.b += SLACK;
    if (!dx && !dy && !growR && !growB) return;
    applyExt();
    if (dx) c.scrollLeft += dx;
    if (dy) c.scrollTop += dy;
  }
  /** Scrolls back to the screens' top-left corner. */
  function goHome(smooth) {
    $("canvas").scrollTo({ left: ext.l, top: ext.t, behavior: smooth ? "smooth" : "auto" });
  }

  const isTyping = (t) => !!(t && t.closest && t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));

  function initCanvas() {
    const canvas = $("canvas");
    $("zoom").value = state.size;
    $("zoom").addEventListener("input", (e) => zoomTo(Number(e.target.value)));

    applyExt();
    goHome(false);
    canvas.addEventListener("scroll", growCanvas, { passive: true });

    // Pinch on a trackpad and Ctrl/⌘ + wheel zoom; plain wheel and two-finger swipes scroll natively.
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        if (!gesture.active) wheelZoom(e.deltaY, e.deltaMode, e.clientX, e.clientY);
      },
      { passive: false },
    );
    // Safari reports pinches as gesture events instead of ctrl+wheel.
    for (const phase of ["start", "change", "end"])
      canvas.addEventListener("gesture" + phase, (e) => {
        e.preventDefault();
        gestureZoom(phase, e.scale, e.clientX, e.clientY);
      });

    // Drag to pan: on the background, with the middle button, or anywhere while Space is held.
    let space = false;
    let drag = null;
    const setSpace = (on) => {
      space = on;
      canvas.classList.toggle("can-pan", on);
    };
    canvas.addEventListener("pointerdown", (e) => {
      const onBackground = !e.target.closest("figure, .component-card, a, button, .screen-head, .empty");
      // Middle-click on a link still opens it in a new tab.
      const middle = e.button === 1 && !e.target.closest("a");
      if (!(space || middle || (e.button === 0 && onBackground))) return;
      e.preventDefault();
      // preventDefault keeps focus where it was, so a field focused inside a frame would keep
      // reopening the browser's autofill popup while the canvas pans. Move focus out of frames.
      if (document.activeElement && document.activeElement.tagName === "IFRAME") document.activeElement.blur();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, click: e.button === 0 && onBackground && !space };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("panning");
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      canvas.scrollLeft -= e.clientX - drag.x;
      canvas.scrollTop -= e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      // A plain click on the background (no pan) clears the target frame.
      if (e.type === "pointerup" && drag.click && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) clearCurrent();
      drag = null;
      canvas.classList.remove("panning");
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && zoomKeyMatches(e.key)) {
        e.preventDefault();
        zoomKey(e.key);
        return;
      }
      if (isTyping(e.target) || e.altKey || mod || PICKERS.some((p) => !$(p + "Menu").hidden) || !$("modelMenu").hidden || !$("frameMenu").hidden) return;
      if (e.key === " ") {
        if (e.target.closest && e.target.closest("button, a, [role=button]")) return;
        e.preventDefault();
        if (!e.repeat) setSpace(true);
        return;
      }
      // Shift+1 jumps back to the screens.
      if (e.shiftKey && e.code === "Digit1") {
        e.preventDefault();
        goHome(true);
        return;
      }
      const step = e.shiftKey ? 400 : 80;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const m = moves[e.key];
      if (m) {
        e.preventDefault();
        canvas.scrollBy({ left: m[0], top: m[1] });
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.key === " ") setSpace(false);
    });
    window.addEventListener("blur", () => setSpace(false));
  }
  const zoomKeyMatches = (k) => ["=", "+", "-", "_", "0"].includes(k);

  // ---------- chat ----------
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function richText(s) {
    return escapeHtml(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }

  function setLogOpen(open) {
    $("log").hidden = !open;
    $("toggleLog").setAttribute("aria-expanded", String(open));
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
    st.textContent = busy ? "Working…" : "";
    st.hidden = !busy;
    if ($("send")) {
      $("send").hidden = busy;
      $("stop").hidden = !busy;
    }
  }

  // ---------- agent and model picker ----------
  // Mutable: providers from .protodeck/config.json can be added or removed while the gallery is open.
  const AGENTS = BOOT.agents || [];
  const EFFORT_LABELS = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };
  const effortLabel = (e) => (e ? EFFORT_LABELS[e] || e[0].toUpperCase() + e.slice(1) : "Default");
  const MARKS = {
    // Claude and OpenAI marks from simple-icons (CC0).
    claude: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
    codex: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
    custom:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m5 7 1.5 1.5L5 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const CHECK = '<svg class="check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function mark(kind) {
    const m = el("span", "mark mark-" + kind);
    m.innerHTML = MARKS[kind] || MARKS.custom;
    return m;
  }
  /** Mark for an agent; providers get a letter badge so two Claude accounts can be told apart. */
  function agentMark(agent) {
    const m = mark(agent.kind);
    if (agent.provider) {
      m.classList.add("has-badge");
      m.appendChild(Object.assign(el("span", "mark-badge"), { textContent: agent.provider.name.trim()[0].toUpperCase() }));
    }
    return m;
  }
  const agentOf = (id) => AGENTS.find((a) => a.id === id);
  const modelOf = (agent, id) => agent && agent.models.find((m) => m.id === id);

  /** Keeps a stored or partial choice valid against the agents the server found. */
  function normalizeChoice(c) {
    const agent = agentOf(c && c.agent) || AGENTS[0];
    if (!agent) return null;
    const model = modelOf(agent, c && c.model) || agent.models[0];
    let effort = c && c.effort;
    if (effort && !model.efforts.includes(effort)) effort = model.efforts.includes(model.defaultEffort) ? model.defaultEffort : "";
    return { agent: agent.id, model: model.id, effort: effort || "" };
  }

  const picker = { choice: normalizeChoice(store.get("choice", null)), view: null, query: "", active: 0, mode: "models" };

  function paintChoice() {
    const c = picker.choice;
    if (!c) return;
    const agent = agentOf(c.agent);
    const model = modelOf(agent, c.model);
    $("modelMark").replaceWith(Object.assign(agentMark(agent), { id: "modelMark" }));
    const name = model.id ? (agent.provider ? `${model.label} (${agent.label})` : model.label) : agent.label;
    $("modelLabel").textContent = c.effort ? `${name} · ${effortLabel(c.effort)}` : name;
    $("modelBtn").title = `${agent.label}${model.id ? " · " + model.label : ""} · reasoning ${effortLabel(c.effort).toLowerCase()}`;
  }

  function setChoice(c) {
    picker.choice = normalizeChoice(c);
    store.set("choice", picker.choice);
    paintChoice();
    renderMenu();
  }

  function visibleModels() {
    const agent = agentOf(picker.view);
    const q = picker.query.trim().toLowerCase();
    return agent.models.filter((m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }

  function renderMenu() {
    if ($("modelMenu").hidden) return;
    const c = picker.choice;
    const rail = $("agentRail");
    rail.textContent = "";
    const settings = picker.mode === "settings";
    $("modelMenu").classList.toggle("settings", settings);
    for (const a of AGENTS) {
      const title = a.provider ? `${a.label} · ${a.provider.configDir}` : a.label;
      const b = el("button", "rail-btn", { type: "button", title, "aria-label": a.label });
      b.setAttribute("aria-current", String(!settings && a.id === picker.view));
      b.appendChild(agentMark(a));
      b.addEventListener("click", () => {
        picker.view = a.id;
        picker.active = 0;
        picker.mode = "models";
        renderMenu();
        $("modelSearch").focus();
      });
      rail.appendChild(b);
    }
    if (BOOT.providers !== false) {
      rail.appendChild(el("span", "rail-spacer"));
      const gear = el("button", "rail-btn rail-gear", { type: "button", title: "Providers: add another account or config folder", "aria-label": "Providers" });
      gear.setAttribute("aria-current", String(settings));
      gear.innerHTML = GEAR;
      gear.addEventListener("click", () => openSettings(!settings));
      rail.appendChild(gear);
    }
    if (settings) return renderSettings();

    const list = $("modelList");
    list.textContent = "";
    const models = visibleModels();
    picker.active = Math.min(picker.active, Math.max(models.length - 1, 0));
    if (!models.length) list.appendChild(Object.assign(el("p", "menu-empty"), { textContent: "No matching models" }));
    models.forEach((m, i) => {
      const selected = c.agent === picker.view && c.model === m.id;
      const b = el("button", "menu-item" + (i === picker.active ? " active" : ""), { type: "button", role: "option" });
      b.setAttribute("aria-selected", String(selected));
      b.appendChild(agentMark(agentOf(picker.view)));
      b.appendChild(Object.assign(el("span", "name"), { textContent: m.id ? m.label : `Default` }));
      if (!m.id) b.appendChild(Object.assign(el("span", "hint"), { textContent: "agent setting" }));
      b.insertAdjacentHTML("beforeend", CHECK);
      if (i < 9) b.appendChild(Object.assign(el("kbd"), { textContent: String(i + 1) }));
      b.addEventListener("click", () => pickModel(m));
      b.addEventListener("mousemove", () => {
        if (picker.active !== i) {
          picker.active = i;
          for (const [j, n] of [...list.children].entries()) n.classList.toggle("active", j === i);
        }
      });
      list.appendChild(b);
    });

    // Reasoning column describes the selected model when viewing its agent, else the agent's first model.
    const agent = agentOf(picker.view);
    const shown = c.agent === picker.view ? modelOf(agent, c.model) : agent.models[0];
    const effortBox = $("effortList");
    effortBox.textContent = "";
    $("effortFor").textContent = shown.id ? shown.label : agent.label;
    const live = c.agent === picker.view;
    $("effortList").parentElement.classList.toggle("off", !live);
    if (!shown.efforts.length) effortBox.appendChild(Object.assign(el("p", "menu-empty"), { textContent: "Not configurable" }));
    else
      for (const e of ["", ...shown.efforts]) {
        const b = el("button", "menu-item", { type: "button", role: "option" });
        b.setAttribute("aria-selected", String(live && c.effort === e));
        b.appendChild(Object.assign(el("span", "name"), { textContent: effortLabel(e) }));
        if (e && e === shown.defaultEffort) b.appendChild(Object.assign(el("span", "hint"), { textContent: "default" }));
        b.insertAdjacentHTML("beforeend", CHECK);
        b.addEventListener("click", () => {
          if (live) setChoice({ ...c, effort: e });
          else setChoice({ agent: picker.view, model: shown.id, effort: e });
        });
        effortBox.appendChild(b);
      }
  }

  function pickModel(m) {
    const c = picker.choice;
    setChoice({ agent: picker.view, model: m.id, effort: c.agent === picker.view ? c.effort : "" });
  }

  function placeMenu() {
    const r = $("modelBtn").getBoundingClientRect();
    const menu = $("modelMenu");
    const w = menu.offsetWidth;
    menu.style.left = Math.max(16, Math.min(r.right - w, innerWidth - w - 16)) + "px";
    menu.style.bottom = innerHeight - r.top + 8 + "px";
  }

  function openMenu(open) {
    const menu = $("modelMenu");
    if (open === !menu.hidden) return;
    menu.hidden = !open;
    $("modelBtn").setAttribute("aria-expanded", String(open));
    if (open) {
      picker.view = picker.choice.agent;
      picker.mode = "models";
      picker.query = "";
      picker.active = Math.max(0, agentOf(picker.view).models.findIndex((m) => m.id === picker.choice.model));
      $("modelSearch").value = "";
      renderMenu();
      placeMenu();
      $("modelSearch").focus();
      const items = $("modelList").children;
      if (items[picker.active]) items[picker.active].scrollIntoView({ block: "nearest" });
    }
  }

  // ---------- providers (.protodeck/config.json) ----------
  // Lucide "settings" (ISC).
  const GEAR =
    '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
  const KIND_LABELS = { claude: "Claude Code", codex: "Codex" };
  const DIR_HINT = { claude: "~/.claude-work", codex: "~/.codex-work" };
  const SCOPES = {
    local: { label: "This project", note: "Used only in this project." },
    global: { label: "Global", note: "Used in every project without its own file." },
  };
  // config: { active, local: {path, exists, providers, error}, global: {...} }; scope: the file being edited.
  const prov = { config: null, scope: null, error: "", draft: { agent: "claude", name: "", configDir: "" }, saving: false };

  async function openSettings(open) {
    picker.mode = open ? "settings" : "models";
    if (open) {
      prov.error = "";
      try {
        const data = await fetch("/__protodeck/config").then((r) => r.json());
        prov.config = data.config;
        setAgents(data.agents);
        prov.scope = prov.config.active; // null: nothing saved yet, so ask where to save
      } catch (err) {
        prov.error = "Could not load the config: " + err.message;
      }
    }
    renderMenu();
    if (!open) $("modelSearch").focus();
  }

  /** Replaces the agent list in place and keeps the current choice valid. */
  function setAgents(agents) {
    if (!agents) return;
    AGENTS.splice(0, AGENTS.length, ...agents);
    if (!AGENTS.length) return;
    picker.choice = normalizeChoice(picker.choice);
    store.set("choice", picker.choice);
    if (!agentOf(picker.view)) picker.view = picker.choice.agent;
    paintChoice();
  }

  /** Sends one change ({ add } or { remove }); the server applies it to the file as it is now. */
  async function saveProviders(change) {
    prov.saving = true;
    prov.error = "";
    renderMenu();
    try {
      const data = await api("config", { scope: prov.scope, ...change });
      prov.config = data.config;
      setAgents(data.agents);
      prov.saving = false;
      return true;
    } catch (err) {
      prov.error = err.message;
      prov.saving = false;
      return false;
    } finally {
      renderMenu();
    }
  }

  function renderSettings() {
    const body = $("providerBody");
    body.textContent = "";
    const cfg = prov.config;
    const add = (parent, tag, cls, props) => parent.appendChild(Object.assign(el(tag, cls), props || {}));
    if (!cfg) {
      add(body, "p", "settings-err", { textContent: prov.error || "Loading…" });
      return;
    }

    // Nothing saved anywhere yet: ask where the file should go before showing the editor.
    if (!prov.scope) {
      add(body, "p", "settings-intro", {
        textContent: "Add another account or config folder for Claude Code or Codex, e.g. a work account in ~/.claude-work. Where should protodeck save it?",
      });
      for (const scope of ["local", "global"]) {
        const b = add(body, "button", "scope-option", { type: "button" });
        add(b, "span", "name", { textContent: SCOPES[scope].label });
        add(b, "code", "", { textContent: cfg[scope].path });
        add(b, "span", "hint", { textContent: SCOPES[scope].note });
        b.addEventListener("click", () => {
          prov.scope = scope;
          renderMenu();
          const n = $("providerName");
          if (n) n.focus();
        });
      }
      return;
    }

    const tabs = add(body, "div", "scope-tabs", { role: "tablist" });
    for (const scope of ["local", "global"]) {
      const t = add(tabs, "button", "scope-tab", { type: "button", role: "tab" });
      t.setAttribute("aria-selected", String(prov.scope === scope));
      add(t, "span", "", { textContent: SCOPES[scope].label });
      if (cfg.active === scope) add(t, "span", "in-use", { textContent: "in use" });
      t.addEventListener("click", () => {
        prov.scope = scope;
        prov.error = "";
        renderMenu();
      });
    }

    const info = cfg[prov.scope];
    const where = add(body, "p", "settings-path");
    add(where, "code", "", { textContent: info.path });
    if (cfg.active && cfg.active !== prov.scope)
      add(body, "p", "settings-note", {
        textContent:
          prov.scope === "global"
            ? "Not used here: this project has its own file, which takes precedence."
            : "Saving here gives this project its own file, used instead of the global one.",
      });
    if (info.error) add(body, "p", "settings-err", { textContent: info.error });

    const list = add(body, "div", "provider-list");
    if (!info.providers.length && !info.error) add(list, "p", "menu-empty", { textContent: "No providers yet. Claude Code and Codex use their default folders." });
    info.providers.forEach((p) => {
      const row = add(list, "div", "provider-row");
      row.appendChild(agentMark({ kind: p.agent, provider: p }));
      const text = add(row, "div", "provider-text");
      add(text, "span", "name", { textContent: p.name });
      add(text, "code", "", { textContent: `${KIND_LABELS[p.agent]} · ${p.configDir}` });
      const rm = add(row, "button", "remove", { type: "button", textContent: "×", title: `Remove ${p.name}`, disabled: prov.saving });
      rm.setAttribute("aria-label", `Remove ${p.name}`);
      rm.addEventListener("click", () => saveProviders({ remove: p.name }));
    });

    const d = prov.draft;
    const form = add(body, "form", "provider-form");
    const agentSel = add(form, "select", "", { id: "providerAgent" });
    agentSel.setAttribute("aria-label", "Agent");
    for (const k of ["claude", "codex"]) agentSel.appendChild(Object.assign(el("option"), { value: k, textContent: KIND_LABELS[k], selected: d.agent === k }));
    const name = add(form, "input", "", { id: "providerName", placeholder: "Name, e.g. Work", value: d.name, maxLength: 40, autocomplete: "off", spellcheck: false });
    name.setAttribute("aria-label", "Name");
    const dir = add(form, "input", "full", { placeholder: `Config folder, e.g. ${DIR_HINT[d.agent]}`, value: d.configDir, autocomplete: "off", spellcheck: false });
    dir.setAttribute("aria-label", "Config folder");
    add(form, "p", "hint full", {
      textContent: d.agent === "claude" ? "Passed to claude as CLAUDE_CONFIG_DIR. Log in once with: CLAUDE_CONFIG_DIR=<folder> claude" : "Passed to codex as CODEX_HOME. Log in once with: CODEX_HOME=<folder> codex login",
    });
    const actions = add(form, "div", "actions full");
    if (prov.error) add(actions, "span", "settings-err", { textContent: prov.error });
    add(actions, "button", "btn primary", { type: "submit", textContent: prov.saving ? "Saving…" : "Add provider", disabled: prov.saving || !!info.error });
    agentSel.addEventListener("change", () => {
      d.agent = agentSel.value;
      renderMenu();
      $("providerAgent").focus();
    });
    name.addEventListener("input", () => (d.name = name.value));
    dir.addEventListener("input", () => (d.configDir = dir.value));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const entry = { agent: d.agent, name: d.name.trim(), configDir: d.configDir.trim() };
      if (!entry.name || !entry.configDir) {
        prov.error = "Enter a name and a config folder.";
        return renderMenu();
      }
      if (await saveProviders({ add: entry })) {
        d.name = "";
        d.configDir = "";
        renderMenu();
      }
    });
  }

  function initPicker() {
    if (!picker.choice) {
      $("modelBtn").hidden = true;
      return;
    }
    paintChoice();
    $("modelBtn").addEventListener("click", () => openMenu($("modelMenu").hidden));
    $("modelSearch").addEventListener("input", (e) => {
      picker.query = e.target.value;
      picker.active = 0;
      renderMenu();
    });
    $("modelSearch").addEventListener("keydown", (e) => {
      const models = visibleModels();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!models.length) return;
        picker.active = (picker.active + (e.key === "ArrowDown" ? 1 : -1) + models.length) % models.length;
        renderMenu();
        $("modelList").children[picker.active].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (models[picker.active]) pickModel(models[picker.active]);
        openMenu(false);
        $("input").focus();
      } else if (e.key === "Tab" && AGENTS.length > 1) {
        e.preventDefault();
        const i = AGENTS.findIndex((a) => a.id === picker.view);
        picker.view = AGENTS[(i + (e.shiftKey ? -1 : 1) + AGENTS.length) % AGENTS.length].id;
        picker.active = 0;
        renderMenu();
      } else if (/^[1-9]$/.test(e.key) && !picker.query) {
        e.preventDefault();
        const m = models[Number(e.key) - 1];
        if (m) pickModel(m);
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!$("modelMenu").hidden && !$("modelMenu").contains(e.target) && !$("modelBtn").contains(e.target)) openMenu(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("modelMenu").hidden) {
        openMenu(false);
        $("modelBtn").focus();
      }
    });
    window.addEventListener("resize", () => !$("modelMenu").hidden && placeMenu());
  }

  function onAgent(ev) {
    if (ev.kind === "start") {
      setBusy(true);
      setLogOpen(true);
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
    if (res.status === 403 && data.error === "Bad token") {
      // The server restarted since this page loaded; a reload picks up the new token.
      location.reload();
      throw new Error("The server restarted. Reloading…");
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async function send() {
    const input = $("input");
    const message = input.value.trim();
    if (!message || state.busy) return;
    const ctx = { message, agent: picker.choice };
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
      setLogOpen(true);
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
    state.size = clampSize(Number(state.size) || ZOOM_DEFAULT);
    initTheme();
    initFrameMenu();
    $("exportBtn").addEventListener("click", () => {
      openPicker(null);
      window.__protodeckExport.open({
        screens: state.screens,
        selectedRoutes: visibleScreens().map((s) => s.path),
        devices: DEVICES,
        selectedDevices: DEVICES.filter((d) => state.enabled.has(d.id)).map((d) => d.id),
        theme: currentTheme(),
      });
    });
    initCanvas();
    initPickers();

    if (!AGENTS.length) {
      $("composer").querySelector(".row").innerHTML =
        '<p class="disabled-note">Chat is off: no agent found. Restart with <code>--agent claude</code>, <code>--agent codex</code> or <code>--agent "your-cli {prompt}"</code>.</p>';
      $("newChat").hidden = true;
      $("modelBtn").hidden = true;
    } else {
      initPicker();
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
      $("toggleLog").addEventListener("click", () => setLogOpen($("log").hidden));
      $("newChat").addEventListener("click", async () => {
        try {
          await api("reset");
          $("log").textContent = "";
          setLogOpen(false);
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
