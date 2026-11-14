/*
 * control.js: connects a web app to the ENG-MD-HUB control center.
 * https://eng-md-hub.github.io/control/
 *
 * Usage (once, at app start):
 *   import { startControl } from "./control.js";   // or <script src="control.js"> then window.Control.start(...)
 *   startControl({ key: "ck_...", version: "1.2.3" });
 *
 * Rules this file follows:
 * - Fail-open: if the control center is down, slow (3 s) or unreachable, the app keeps working.
 * - Offline: counters are kept in localStorage and sent on the next successful call.
 * - Privacy: random install ID only. No names, emails, IP, ad IDs or user content.
 * - Opt-out: setControlOptOut(true) stops usage numbers; only the minimal "may this app run" check stays.
 * - Stop: a stop from the control center is remembered on the device until a later check lifts it.
 */
const URL_ = "https://lfdngkibdnkwhqeasmuw.supabase.co/rest/v1/rpc/app_heartbeat";
// Publishable key: public by design. The function only accepts reports and returns the app's state.
const PUB = "sb_publishable_B738d43Eg2U1A9jkqymAwQ_QF11RD9s";
const NS = "control.";
const TIMEOUT_MS = 3000;
const EVERY_MS = 5 * 60 * 1000;

const store = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch { /* storage full or blocked: ignore */ } },
};

function installId() {
  let id = store.get("install", null);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
    store.set("install", id);
  }
  return id;
}

function deviceInfo() {
  const ua = navigator.userAgent || "";
  const os = /Android ([\d.]+)/.exec(ua)?.[0] || /Windows NT [\d.]+/.exec(ua)?.[0] || /iPhone OS [\d_]+/.exec(ua)?.[0]?.replace(/_/g, ".") ||
    /Mac OS X [\d_]+/.exec(ua)?.[0]?.replace(/_/g, ".") || (/Linux/.test(ua) ? "Linux" : "");
  const model = /Android [\d.]+; ([^;)]+)/.exec(ua)?.[1]?.trim() || (/iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : "Browser");
  const standalone = matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
  const inApp = /; wv\)/.test(ua) || /Capacitor/i.test(ua);
  return { os, model, platform: inApp ? "android-app" : standalone ? "pwa" : "web" };
}

let cfg = null, timer = null, visibleSince = null, sending = false;

function addPending(field, n) {
  const p = store.get("pending", { opens: 0, seconds: 0, errors: 0, lastError: null });
  p[field] = (p[field] || 0) + n;
  store.set("pending", p);
}
function flushVisible() {
  if (visibleSince) { addPending("seconds", Math.round((Date.now() - visibleSince) / 1000)); visibleSince = document.visibilityState === "visible" ? Date.now() : null; }
}

function applyState(res) {
  if (!res || !res.ok) return;
  const was = store.get("state", { state: "active" });
  store.set("state", { state: res.state, message: res.message || "", at: Date.now() });
  store.set("next", Date.now() + (res.next_check_seconds || 21600) * 1000);
  if (res.state === "stopped") (cfg.onStop || showStop)(res.message || "");
  else if (was.state === "stopped") (cfg.onResume || hideStop)();
  if (res.min_version && cfg.version && cmp(cfg.version, res.min_version) < 0) cfg.onUpdateRequired?.(res.min_version);
}
function cmp(a, b) {
  const x = String(a).split(/[.-]/).map(Number), y = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

async function send(beacon) {
  if (!cfg || sending) return;
  flushVisible();
  const optOut = store.get("optout", false);
  const p = store.get("pending", { opens: 0, seconds: 0, errors: 0, lastError: null });
  const d = deviceInfo();
  const body = {
    p_key: cfg.key, p_install: installId(), p_version: cfg.version || null, p_platform: d.platform,
    p_model: optOut ? null : d.model, p_os: optOut ? null : d.os,
    p_tz: optOut ? null : (Intl.DateTimeFormat().resolvedOptions().timeZone || null),
    p_opens: optOut ? 0 : p.opens, p_seconds: optOut ? 0 : p.seconds, p_errors: optOut ? 0 : p.errors,
    p_last_error: optOut ? null : p.lastError,
  };
  sending = true;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(URL_, {
      method: "POST", keepalive: !!beacon, signal: ctrl.signal,
      headers: { "Content-Type": "application/json", apikey: PUB, Authorization: "Bearer " + PUB },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const res = await r.json();
      if (res && res.ok && !res.throttled) {
        // Recorded: remove only what was sent (new counts may have arrived meanwhile).
        const now = store.get("pending", p);
        store.set("pending", { opens: Math.max(0, now.opens - body.p_opens), seconds: Math.max(0, now.seconds - body.p_seconds), errors: Math.max(0, now.errors - body.p_errors), lastError: null });
      }
      applyState(res);
    }
  } catch { /* offline or slow: keep counters, try later */ }
  finally { clearTimeout(t); sending = false; }
}

// Default stop screen (an app can pass onStop / onResume to use its own UI).
function showStop(message) {
  if (document.getElementById("control-stop")) { document.querySelector("#control-stop p").textContent = message || ""; return; }
  const el = document.createElement("div");
  el.id = "control-stop"; el.setAttribute("role", "alertdialog"); el.dir = "auto";
  el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#F3F5F8;color:#18202E;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;font:16px/1.6 system-ui,sans-serif";
  el.innerHTML = '<strong style="font-size:20px">التطبيق متوقف مؤقتاً</strong><p style="margin:0;max-width:420px"></p>';
  el.querySelector("p").textContent = message || "";
  document.body.appendChild(el);
}
function hideStop() { document.getElementById("control-stop")?.remove(); }

export function startControl(options) {
  if (cfg || !options || !options.key) return;
  cfg = options;
  try {
    const st = store.get("state", null);
    if (st && st.state === "stopped") (cfg.onStop || showStop)(st.message || ""); // remembered stop
    addPending("opens", 1);
    visibleSince = document.visibilityState === "visible" ? Date.now() : null;
    addEventListener("error", e => { addPending("errors", 1); const p = store.get("pending", {}); p.lastError = String(e.message || "error").slice(0, 300); store.set("pending", p); });
    addEventListener("unhandledrejection", e => { addPending("errors", 1); const p = store.get("pending", {}); p.lastError = String(e.reason?.message || e.reason || "rejection").slice(0, 300); store.set("pending", p); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { send(true); }
      else { visibleSince = Date.now(); if (Date.now() > store.get("next", 0)) send(false); }
    });
    addEventListener("online", () => send(false));
    setTimeout(() => send(false), 1500);
    timer = setInterval(() => { if (document.visibilityState === "visible") send(false); }, EVERY_MS);
  } catch { /* never break the host app */ }
}

export function setControlOptOut(on) { store.set("optout", !!on); }
export function isControlOptOut() { return store.get("optout", false); }

if (typeof window !== "undefined") window.Control = { start: startControl, setOptOut: setControlOptOut, isOptOut: isControlOptOut };
