// Export dialog: renders screens in hidden frames and saves them as HTML pages or PNG images.
// Several files are saved as one .zip. gallery.js opens it through window.__protodeckExport.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const prefs = (() => {
    const d = { html: false, png: true, scale: 2, fullPage: false };
    try {
      return { ...d, ...JSON.parse(localStorage.getItem("protodeck:export") || "{}") };
    } catch {
      return d;
    }
  })();
  const savePrefs = () => {
    try {
      localStorage.setItem("protodeck:export", JSON.stringify(prefs));
    } catch {}
  };

  // ---------- zip (stored entries, no compression: PNGs are compressed already) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** files: [{ name, data: Uint8Array }] */
  function zip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      parts.push(local.buffer, name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(12, time, true);
      c.setUint16(14, date, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, size, true);
      c.setUint32(24, size, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }

  // ---------- inlining assets ----------
  let cache = new Map();
  function toDataUrl(url) {
    if (!url || url.startsWith("data:")) return Promise.resolve(url || null);
    let p = cache.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
        .then(
          (b) =>
            new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = rej;
              fr.readAsDataURL(b);
            }),
        )
        .catch(() => null);
      cache.set(url, p);
    }
    return p;
  }

  const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  async function inlineCssUrls(css, base) {
    const found = new Set();
    for (const m of css.matchAll(URL_RE)) if (!/^(data:|#)/.test(m[2])) found.add(m[2]);
    const map = new Map();
    await Promise.all(
      [...found].map(async (u) => {
        let abs;
        try {
          abs = new URL(u, base).href;
        } catch {
          return;
        }
        const d = await toDataUrl(abs);
        if (d) map.set(u, d);
      }),
    );
    return css.replace(URL_RE, (all, _q, u) => (map.has(u) ? `url("${map.get(u)}")` : all));
  }

  function sheetText(sheet) {
    // <style> text is kept as written; linked sheets are read rule by rule (@import followed).
    if (sheet.ownerNode && sheet.ownerNode.tagName === "STYLE") return sheet.ownerNode.textContent;
    try {
      return [...sheet.cssRules].map((r) => (r.type === 3 && r.styleSheet ? sheetText(r.styleSheet) : r.cssText)).join("\n");
    } catch {
      return "";
    }
  }

  /** All CSS that applies to the document, with url() references inlined. `skip(ownerNode)` leaves sheets out. */
  async function collectCss(doc, skip) {
    const out = [];
    for (const sheet of doc.styleSheets) {
      if (skip && skip(sheet.ownerNode)) continue;
      const media = sheet.media && sheet.media.mediaText;
      let text = await inlineCssUrls(sheetText(sheet), sheet.href || doc.baseURI);
      if (media && media !== "all") text = `@media ${media} {\n${text}\n}`;
      out.push(text);
    }
    return out.join("\n");
  }

  async function inlineStyleAttrs(root, base) {
    await Promise.all(
      [...root.querySelectorAll('[style*="url("]')].map(async (n) => n.setAttribute("style", await inlineCssUrls(n.getAttribute("style"), base))),
    );
  }

  // ---------- rendering frames ----------
  function loadFrame(host, path, w, h) {
    return new Promise((resolve, reject) => {
      const f = document.createElement("iframe");
      f.width = w;
      f.height = h;
      f.style.cssText = `display:block;width:${w}px;height:${h}px;border:0`;
      f.tabIndex = -1;
      const timer = setTimeout(() => reject(new Error(`/${path} took too long to load`)), 20000);
      f.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          settle(f).then(() => resolve(f), reject);
        },
        { once: true },
      );
      f.src = "/" + path;
      host.appendChild(f);
    });
  }

  /** Waits for fonts, images and Tailwind's compiled styles inside a loaded frame. */
  async function settle(f) {
    const d = f.contentDocument;
    if (!d) throw new Error("Could not read the frame");
    for (const img of d.images) if (img.loading === "lazy") img.loading = "eager";
    await Promise.race([
      Promise.all(
        [...d.images].map((img) =>
          img.complete ? null : new Promise((r) => (img.addEventListener("load", r, { once: true }), img.addEventListener("error", r, { once: true }))),
        ),
      ),
      sleep(5000),
    ]);
    try {
      await d.fonts.ready;
    } catch {}
    // Tailwind compiles in the frame after load; wait until its output stops changing.
    let last = -1;
    for (let i = 0; i < 30; i++) {
      await sleep(80);
      let n = 0;
      for (const s of d.querySelectorAll("style")) n += s.textContent.length;
      if (n === last) break;
      last = n;
    }
  }

  function copyFormState(live, clone) {
    const a = live.querySelectorAll("input, textarea, select");
    const b = clone.querySelectorAll("input, textarea, select");
    a.forEach((el, i) => {
      const c = b[i];
      if (!c) return;
      if (el.tagName === "INPUT") {
        if (el.type === "checkbox" || el.type === "radio") el.checked ? c.setAttribute("checked", "") : c.removeAttribute("checked");
        else if (el.type !== "file" && el.type !== "password") c.setAttribute("value", el.value);
      } else if (el.tagName === "TEXTAREA") c.textContent = el.value;
      else [...el.options].forEach((o, j) => (o.selected ? c.options[j].setAttribute("selected", "") : c.options[j].removeAttribute("selected")));
    });
  }

  const transparent = (c) => !c || c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);

  async function renderPng(frame, w, h, scale, fullPage) {
    const doc = frame.contentDocument;
    const live = doc.documentElement;
    const height = fullPage ? Math.max(h, live.scrollHeight, doc.body ? doc.body.scrollHeight : 0) : h;
    // Browsers cap canvas size; lower the scale for very tall pages.
    const s = Math.max(0.25, Math.min(scale, 16000 / height, 16000 / w));

    const css = await collectCss(doc);
    const clone = live.cloneNode(true);
    copyFormState(live, clone);
    const liveCanvases = live.querySelectorAll("canvas");
    clone.querySelectorAll("canvas").forEach((c, i) => {
      try {
        const img = doc.createElement("img");
        for (const a of c.attributes) img.setAttribute(a.name, a.value);
        img.src = liveCanvases[i].toDataURL();
        c.replaceWith(img);
      } catch {}
    });
    const liveImgs = live.querySelectorAll("img");
    const cloneImgs = [...clone.querySelectorAll("img")];
    await Promise.all(
      cloneImgs.map(async (img, i) => {
        const src = (liveImgs[i] && liveImgs[i].currentSrc) || img.src;
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
        img.removeAttribute("loading");
        const d = await toDataUrl(src);
        if (d) img.setAttribute("src", d);
        else img.removeAttribute("src");
      }),
    );
    await inlineStyleAttrs(clone, doc.baseURI);
    for (const n of clone.querySelectorAll("script, noscript, link, style, picture > source, [data-protodeck-overlay]")) n.remove();

    let head = clone.querySelector("head");
    if (!head) clone.prepend((head = doc.createElement("head")));
    const style = doc.createElement("style");
    style.textContent = css;
    head.appendChild(style);
    clone.style.width = w + "px";
    clone.style.minHeight = height + "px";

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await new Promise((res, rej) => {
      if (img.complete && img.naturalWidth) return res();
      img.onload = res;
      img.onerror = () => rej(new Error("The browser could not render this screen as an image"));
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * s);
    canvas.height = Math.round(height * s);
    const ctx = canvas.getContext("2d");
    const view = doc.defaultView;
    let bg = doc.body ? view.getComputedStyle(doc.body).backgroundColor : "";
    if (transparent(bg)) bg = view.getComputedStyle(live).backgroundColor;
    if (transparent(bg)) bg = live.getAttribute("data-protodeck-scheme") === "dark" ? "#121212" : "#ffffff";
    const draw = () => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    // Safari can paint the first draw before the inlined fonts are ready; drawing again fixes it.
    draw();
    await sleep(40);
    draw();
    const blob = await new Promise((res, rej) => {
      try {
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode the PNG"))), "image/png");
      } catch (e) {
        rej(new Error("This browser blocks reading the rendered image. Try Chrome or Firefox."));
      }
    });
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** A standalone page: the screen's source (components expanded) with the compiled CSS, fonts and images inlined. */
  async function renderHtml(frame, path, theme) {
    const doc = frame.contentDocument;
    const res = await fetch("/" + path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not load /${path} (${res.status})`);
    const out = new DOMParser().parseFromString(await res.text(), "text/html");
    const base = new URL("/" + path, location.href).href;

    // Inline <style> tags stay where they are; everything else (base.css, Tailwind's output, linked sheets) is inlined.
    const sourceStyles = new Set([...out.querySelectorAll("style")].map((s) => s.textContent));
    const css = await collectCss(doc, (n) => n && n.tagName === "STYLE" && sourceStyles.has(n.textContent));

    for (const n of out.querySelectorAll('link[rel~="stylesheet"], style[type="text/tailwindcss"], script[src^="/__protodeck/"]')) n.remove();
    for (const n of out.querySelectorAll("script:not([src])")) if (n.textContent.includes("__protodeckTheme")) n.remove();

    const style = out.createElement("style");
    style.textContent = css;
    const viewport = out.head.querySelector('meta[name="viewport"]');
    if (viewport) viewport.after(style);
    else out.head.prepend(style);

    await Promise.all([
      ...[...out.querySelectorAll("img[src], link[rel~='icon'][href]")].map(async (n) => {
        const attr = n.tagName === "LINK" ? "href" : "src";
        let abs;
        try {
          abs = new URL(n.getAttribute(attr), base).href;
        } catch {
          return;
        }
        const d = await toDataUrl(abs);
        if (d) {
          n.setAttribute(attr, d);
          n.removeAttribute("srcset");
        }
      }),
      ...[...out.querySelectorAll("script[src]")].map(async (n) => {
        let abs;
        try {
          abs = new URL(n.getAttribute("src"), base);
        } catch {
          return;
        }
        if (abs.origin !== location.origin) return;
        try {
          const r = await fetch(abs.href, { cache: "no-store" });
          if (!r.ok) return;
          n.textContent = (await r.text()).replace(/<\/script/gi, "<\\/script");
          n.removeAttribute("src");
        } catch {}
      }),
      inlineStyleAttrs(out, base),
    ]);

    // Drop the <!--x:name--> component markers.
    const walker = out.createTreeWalker(out, NodeFilter.SHOW_COMMENT);
    const markers = [];
    while (walker.nextNode()) if (/^\/?x:[\w-]+$/.test(walker.currentNode.data.trim())) markers.push(walker.currentNode);
    for (const m of markers) m.remove();

    const root = out.documentElement;
    root.setAttribute("data-protodeck-theme", theme);
    const scheme = doc.documentElement.getAttribute("data-protodeck-scheme");
    if (scheme) root.setAttribute("data-protodeck-scheme", scheme);
    return new TextEncoder().encode("<!doctype html>\n" + root.outerHTML + "\n");
  }

  // ---------- running an export ----------
  const slug = (s) =>
    String(s)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "screen";
  const routeName = (path) => slug(path.replace(/\/+$/, "").replace(/\//g, "-") || "index");

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  /** job: { screens, devices, html, png, scale, fullPage, theme }. Returns the file list. */
  async function runExport(job, onProgress, signal) {
    cache = new Map();
    const tasks = [];
    for (const screen of job.screens) {
      if (job.png) job.devices.forEach((d, i) => tasks.push({ screen, device: d, png: true, html: job.html && i === 0 }));
      else tasks.push({ screen, device: job.devices[0] || { name: "Desktop", w: 1280, h: 800 }, png: false, html: true });
    }
    const total = tasks.reduce((n, t) => n + (t.png ? 1 : 0) + (t.html ? 1 : 0), 0);
    const files = [];
    let done = 0;
    onProgress(done, total);

    // Frames sit behind the page, in the viewport, so the browser keeps rendering them.
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:0;top:0;z-index:-1;opacity:0;pointer-events:none;contain:layout paint";
    document.body.appendChild(host);
    const multiDevice = job.deviceInName || job.devices.length > 1 || job.screens.length > 1;
    try {
      let next = 0;
      let failed = false;
      const stopped = () => failed || signal.aborted;
      const worker = async () => {
        while (next < tasks.length && !stopped()) {
          const t = tasks[next++];
          let frame;
          try {
            frame = await loadFrame(host, t.screen.path, t.device.w, t.device.h);
            if (stopped()) return;
            const base = routeName(t.screen.path);
            if (t.html) {
              files.push({ name: `${base}.html`, data: await renderHtml(frame, t.screen.path, job.theme), order: [t.screen.path, -1] });
              onProgress(++done, total);
            }
            if (t.png) {
              const name = multiDevice || job.html ? `${base}-${slug(t.device.name)}.png` : `${base}.png`;
              files.push({ name, data: await renderPng(frame, t.device.w, t.device.h, job.scale, job.fullPage), order: [t.screen.path, job.devices.indexOf(t.device)] });
              onProgress(++done, total);
            }
          } catch (e) {
            failed = true;
            throw e;
          } finally {
            if (frame) frame.remove();
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } finally {
      host.remove();
    }
    const rank = new Map(job.screens.map((s, i) => [s.path, i]));
    files.sort((a, b) => rank.get(a.order[0]) - rank.get(b.order[0]) || a.order[1] - b.order[1]);
    // Keep names unique if two devices share a name.
    const seen = new Map();
    for (const f of files) {
      const n = seen.get(f.name) || 0;
      seen.set(f.name, n + 1);
      if (n) f.name = f.name.replace(/(\.\w+)$/, `-${n + 1}$1`);
    }
    return files;
  }

  /** Downloads one file as is, or several as a .zip. Returns the saved name. */
  function save(files) {
    if (files.length === 1) {
      const f = files[0];
      download(new Blob([f.data], { type: f.name.endsWith(".png") ? "image/png" : "text/html" }), f.name);
      return f.name;
    }
    const name = `protodeck-export-${new Date().toISOString().slice(0, 10)}.zip`;
    download(zip(files), name);
    return name;
  }

  // ---------- single frame (frame context menu) ----------
  let toastEl = null;
  let toastTimer = 0;
  function toast(text, kind) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.className = "toast" + (kind ? " " + kind : "");
    toastEl.hidden = false;
    if (kind !== "busy") toastTimer = setTimeout(() => (toastEl.hidden = true), kind === "error" ? 6000 : 2200);
  }

  /** opts: { screen: {path,title}, device: {id,name,w,h}, format: "png" | "html", theme }. Uses the dialog's scale and full page settings. */
  async function exportFrame(opts) {
    const job = {
      screens: [opts.screen],
      devices: [opts.device],
      html: opts.format === "html",
      png: opts.format === "png",
      scale: prefs.scale,
      fullPage: prefs.fullPage,
      theme: opts.theme,
      deviceInName: true,
    };
    toast(`Exporting ${opts.screen.title} as ${opts.format.toUpperCase()}…`, "busy");
    try {
      const files = await runExport(job, () => {}, new AbortController().signal);
      toast(`Saved ${save(files)}`);
    } catch (e) {
      toast(`Export failed: ${e && e.message ? e.message : e}`, "error");
    }
  }

  // ---------- dialog ----------
  let ctx = null; // { screens, devices, theme }
  let running = null; // AbortController while exporting

  function checkRow(name, label, hint, value, checked) {
    const row = document.createElement("label");
    row.className = "check-row";
    row.innerHTML = '<input type="checkbox"><span class="name"></span><span class="hint"></span>';
    const input = row.querySelector("input");
    input.name = name;
    input.value = value;
    input.checked = checked;
    row.querySelector(".name").textContent = label;
    row.querySelector(".hint").textContent = hint;
    return row;
  }

  const checked = (name) => [...$("exportForm").querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

  function readJob() {
    const routes = new Set(checked("route"));
    const devices = new Set(checked("device"));
    return {
      screens: ctx.screens.filter((s) => routes.has(s.path)),
      devices: ctx.devices.filter((d) => devices.has(d.id)),
      html: $("exportHtml").checked,
      png: $("exportPng").checked,
      scale: Number($("exportScale").value) || 2,
      fullPage: $("exportFull").checked,
      theme: ctx.theme,
    };
  }

  function update() {
    const job = readJob();
    $("exportDevices").disabled = !job.png;
    $("exportPngOpts").disabled = !job.png;
    for (const id of ["route", "device"]) {
      const all = $("exportForm").querySelectorAll(`input[name="${id}"]`);
      const on = [...all].filter((i) => i.checked).length;
      const btn = $("exportForm").querySelector(`[data-toggle="${id}"]`);
      btn.textContent = on === all.length ? "None" : "All";
    }
    const pngs = job.png ? job.screens.length * job.devices.length : 0;
    const htmls = job.html ? job.screens.length : 0;
    const n = pngs + htmls;
    const parts = [];
    if (pngs) parts.push(`${pngs} PNG`);
    if (htmls) parts.push(`${htmls} HTML`);
    let msg;
    if (!job.html && !job.png) msg = "Pick a format";
    else if (!job.screens.length) msg = "Pick at least one route";
    else if (job.png && !job.devices.length) msg = "Pick at least one device";
    else msg = parts.join(" + ") + (n > 1 ? " · saved as a .zip" : "");
    const err = $("exportError");
    if (!running) {
      err.hidden = true;
      $("exportSummary").textContent = msg;
      $("exportGo").textContent = "Export";
    }
    $("exportGo").disabled = !!running || !(n > 0 && (!job.png || job.devices.length));
  }

  function setRunning(on) {
    for (const el of $("exportForm").querySelectorAll(".modal-body input, .modal-body select, .modal-body button")) el.disabled = on;
    if (!on) update();
  }

  async function start() {
    const job = readJob();
    Object.assign(prefs, { html: job.html, png: job.png, scale: job.scale, fullPage: job.fullPage });
    savePrefs();
    running = new AbortController();
    const signal = running.signal;
    setRunning(true);
    $("exportGo").disabled = true;
    $("exportError").hidden = true;
    try {
      const files = await runExport(
        job,
        (done, total) => {
          $("exportGo").textContent = total > 1 ? `Exporting ${Math.min(done + 1, total)} of ${total}…` : "Exporting…";
          $("exportSummary").textContent = "";
        },
        signal,
      );
      if (signal.aborted) return;
      save(files);
      running = null;
      $("exportDialog").close();
    } catch (e) {
      if (signal.aborted) return;
      running = null;
      setRunning(false);
      $("exportError").textContent = e && e.message ? e.message : String(e);
      $("exportError").hidden = false;
      $("exportSummary").textContent = "";
    } finally {
      if (running && running.signal === signal) {
        running = null;
        setRunning(false);
      }
    }
  }

  function cancel() {
    if (running) running.abort();
    running = null;
    $("exportDialog").close();
  }

  /** opts: { screens: [{path,title}], selectedRoutes: [path], devices: [{id,name,w,h}], selectedDevices: [id], theme } */
  function open(opts) {
    if (running) return $("exportDialog").showModal();
    ctx = { screens: opts.screens, devices: opts.devices, theme: opts.theme };
    const routes = new Set(opts.selectedRoutes);
    const devices = new Set(opts.selectedDevices);
    const rl = $("exportRouteList");
    rl.textContent = "";
    for (const s of opts.screens) rl.appendChild(checkRow("route", s.title, "/" + s.path, s.path, routes.has(s.path)));
    if (!opts.screens.length) rl.innerHTML = '<p class="menu-empty">No screens yet.</p>';
    const dl = $("exportDeviceList");
    dl.textContent = "";
    for (const d of opts.devices) dl.appendChild(checkRow("device", d.name, `${d.w}×${d.h}`, d.id, devices.has(d.id)));
    $("exportHtml").checked = prefs.html;
    $("exportPng").checked = prefs.png;
    $("exportScale").value = String(prefs.scale);
    $("exportFull").checked = prefs.fullPage;
    update();
    $("exportDialog").showModal();
  }

  function init() {
    const form = $("exportForm");
    if (!form) return;
    form.addEventListener("change", update);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!running && !$("exportGo").disabled) start();
    });
    for (const b of form.querySelectorAll("[data-close]")) b.addEventListener("click", cancel);
    for (const b of form.querySelectorAll("[data-toggle]"))
      b.addEventListener("click", () => {
        const all = [...form.querySelectorAll(`input[name="${b.dataset.toggle}"]`)];
        const on = !all.every((i) => i.checked);
        for (const i of all) i.checked = on;
        update();
      });
    // Esc closes the dialog; stop the export with it.
    $("exportDialog").addEventListener("cancel", () => running && running.abort());
    $("exportDialog").addEventListener("close", () => {
      if (running) running.abort();
      running = null;
      setRunning(false);
    });
  }

  window.__protodeckExport = { open, exportFrame };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
