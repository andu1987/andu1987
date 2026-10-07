// Tiny DOM helpers (no framework, no build step).
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else if (k in el && k !== "list" && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function mount(el, ...children) { el.replaceChildren(); append(el, children); return el; }

let toastWrap;
export function toast(msg, kind = "ok", ms = 4500) {
  if (!toastWrap) { toastWrap = h("div", { class: "toast-wrap", role: "status", "aria-live": "polite" }); document.body.append(toastWrap); }
  const t = h("div", { class: "toast " + (kind === "ok" ? "" : kind) }, (kind === "bad" ? "⚠ " : kind === "ok" ? "✓ " : "") + msg);
  toastWrap.append(t);
  while (toastWrap.children.length > 3) toastWrap.firstChild.remove();
  setTimeout(() => t.remove(), ms);
}

// Modal dialog. build(close) returns the content; resolves with the value passed to close().
export function modal(build, { wide = false } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const back = h("div", { class: "modal-back" });
    const box = h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" });
    const close = (v) => { back.remove(); document.removeEventListener("keydown", onKey); prevFocus?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(undefined); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(undefined); });
    mount(box, build(close));
    back.append(box);
    document.body.append(back);
    // Focus the first field, unless the user has already clicked into the dialog.
    setTimeout(() => { if (!box.contains(document.activeElement)) box.querySelector("input:not([type=checkbox]),select,textarea,button.ink-btn")?.focus(); }, 30);
  });
}

export function confirmBox(title, text, { okLabel = "Confirm", danger = false } = {}) {
  return modal((close) => [
    h("h2", null, title),
    h("p", { style: { lineHeight: 1.5 } }, text),
    h("div", { class: "modal-actions" },
      h("button", { class: "ink-btn-ghost plain", onclick: () => close(false) }, "Back"),
      h("button", { class: "ink-btn" + (danger ? "" : " ok"), onclick: () => close(true) }, okLabel)),
  ]);
}

export function promptBox(title, label, { okLabel = "OK", required = true, value = "", help = "" } = {}) {
  return modal((close) => {
    const input = h("input", { class: "ink-input", value });
    const err = h("div", { class: "err" });
    const ok = () => { const v = input.value.trim(); if (required && !v) { err.textContent = "This is required."; return; } close(v); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
    return [h("h2", null, title), help && h("p", { class: "muted small", style: { marginBottom: "10px" } }, help), h("label", { class: "field" }, h("span", null, label), input), err,
      h("div", { class: "modal-actions" }, h("button", { class: "ink-btn-ghost plain", onclick: () => close(undefined) }, "Back"), h("button", { class: "ink-btn", onclick: ok }, okLabel))];
  });
}

export function field(label, input, help) {
  return h("label", { class: "field" }, h("span", null, label), input, help && h("div", { class: "muted small", style: { marginTop: "4px" } }, help));
}

export const badge = (status) => h("span", { class: "badge st-" + status }, status);

export function localISODate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function downloadUrl(url) {
  const a = h("a", { href: url, download: "" });
  document.body.append(a);
  a.click();
  a.remove();
}
