"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the independent startup guard exactly as a plain HTML script. No UXP,
// Premiere, CommonJS loader or bundled application is supplied to this VM.
function fixture(options = {}) {
  const nodes = new Map();
  let domAvailable = !options.loading;
  function addNodes() {
    nodes.set("startup-status", { textContent: "", className: "" });
    nodes.set("diagnostics", { value: "" });
  }
  if (!options.missingNodes) addNodes();
  const windowEvents = new Map();
  const documentEvents = new Map();
  function listen(target, name, callback) {
    if (!target.has(name)) target.set(name, []);
    target.get(name).push(callback);
  }
  const timers = [];
  const logs = [];
  const errors = [];
  const document = {
    readyState: options.loading ? "loading" : "complete",
    getElementById(id) { return domAvailable ? nodes.get(id) || null : null; },
    addEventListener(name, callback) { listen(documentEvents, name, callback); }
  };
  const sandbox = {
    document,
    console: {
      log(...values) { logs.push(values.map(String).join(" ")); },
      error(...values) { errors.push(values.map(String).join(" ")); }
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay, cancelled: false });
      return timers.length;
    },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cancelled = true; }
  };
  if (!options.noWindowEvents) {
    sandbox.addEventListener = (name, callback) => listen(windowEvents, name, callback);
  }
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "bootstrap.js"), "utf8"), sandbox,
    { filename: "bootstrap.js" });
  return {
    boot: sandbox.__kenshiroBoot,
    logs, errors, timers,
    status: () => nodes.get("startup-status")?.textContent || "",
    diagnostics: () => nodes.get("diagnostics")?.value || "",
    fireWindow(name, event) {
      for (const callback of windowEvents.get(name) || []) callback(event);
    },
    domReady() {
      domAvailable = true;
      document.readyState = "complete";
      for (const callback of documentEvents.get("DOMContentLoaded") || []) callback({ type: "DOMContentLoaded" });
    },
    watchdog() {
      for (const timer of timers) if (!timer.cancelled) timer.callback();
    }
  };
}

test("standalone bootstrap loads without an SDK or require and announces its version", () => {
  const f = fixture();
  assert.equal(f.boot.initialized, false);
  assert.equal(typeof f.boot.markReady, "function");
  assert.equal(typeof f.boot.reportError, "function");
  assert.ok(f.logs.some(line => /\[Kenshiro\].*bootstrap v0\.1\.2/.test(line)));
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 2000);
});

test("markReady displays initialized status and cancels the stalled-start watchdog", () => {
  const f = fixture();
  f.boot.markReady();
  assert.equal(f.boot.initialized, true);
  assert.match(f.status(), /起動済み v0\.1\.2/);
  assert.equal(f.timers[0].cancelled, true);
  f.watchdog();
  assert.match(f.status(), /起動済み v0\.1\.2/);
  assert.equal(f.diagnostics(), "");
  assert.equal(f.errors.length, 0);
});

test("a bundle that never initializes produces visible startup diagnostics after two seconds", () => {
  const f = fixture();
  f.watchdog();
  assert.equal(f.boot.initialized, false);
  assert.match(f.status(), /起動処理が完了していません/);
  assert.match(f.diagnostics(), /APP LOGS/);
  assert.ok(f.errors.some(line => /\[Kenshiro\]/.test(line)));
});

test("global native load errors are visible and retain their useful reason after the watchdog", () => {
  const f = fixture();
  f.fireWindow("error", { error: new Error("Cannot load premierepro native module"),
    message: "Cannot load premierepro native module", filename: "dist/main.js", lineno: 7 });
  assert.match(f.status(), /Cannot load premierepro native module/);
  assert.match(f.diagnostics(), /Cannot load premierepro native module/);
  f.watchdog();
  assert.match(f.diagnostics(), /Cannot load premierepro native module/);
  assert.ok(f.errors.some(line => /Cannot load premierepro native module/.test(line)));
});

test("an unhandled rejected Error surfaces its native message", () => {
  const f = fixture();
  f.fireWindow("unhandledrejection", { reason: new Error("Native entrypoint registration rejected") });
  assert.match(f.status(), /Native entrypoint registration rejected/);
  assert.match(f.diagnostics(), /Native entrypoint registration rejected/);
});

test("an unhandled rejected string still yields readable diagnostics", () => {
  const f = fixture();
  f.fireWindow("unhandledrejection", { reason: "Native bridge unavailable" });
  assert.match(f.diagnostics(), /Native bridge unavailable/);
});

test("errors before the DOM exists are retained and rendered when the DOM becomes ready", () => {
  const f = fixture({ loading: true });
  f.boot.reportError(new Error("Early bundle syntax failure"));
  assert.equal(f.status(), "");
  assert.equal(f.diagnostics(), "");
  f.domReady();
  assert.match(f.status(), /Early bundle syntax failure/);
  assert.match(f.diagnostics(), /Early bundle syntax failure/);
  f.domReady();
  assert.match(f.diagnostics(), /Early bundle syntax failure/);
});

test("missing diagnostic DOM nodes do not make the startup guard itself throw", () => {
  const f = fixture({ missingNodes: true });
  assert.doesNotThrow(() => f.boot.reportError(new Error("DOM nodes missing")));
  assert.doesNotThrow(() => f.domReady());
  assert.doesNotThrow(() => f.boot.markReady());
});

test("missing window event registration still permits explicit startup reporting", () => {
  const f = fixture({ noWindowEvents: true });
  f.boot.reportError(new Error("Direct initialize failure"));
  assert.match(f.diagnostics(), /Direct initialize failure/);
});
