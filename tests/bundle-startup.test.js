"use strict";

// Compile the real production entry and all image/diagnostic dependencies.
// Only the native SDK and DOM are simulated; no entrypoint.show() is required
// for the assertions below. This is bundle/startup coverage, not a UXP host test.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");

const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const bootstrap = readFileSync(resolve(root, "bootstrap.js"), "utf8");
const version = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")).version;
const bundle = esbuild.buildSync({
  absWorkingDir: root, entryPoints: ["src/main.js"], bundle: true,
  platform: "browser", format: "iife", external: ["uxp", "premierepro"],
  write: false, logLevel: "silent"
}).outputFiles[0].text;

function element(attributes) {
  let text = "";
  return {
    disabled: /\bdisabled\b/.test(attributes),
    readOnly: /\breadonly\b/.test(attributes),
    value: "", className: "", children: [], listeners: {},
    get textContent() { return text; },
    set textContent(value) { text = String(value); this.children = []; },
    appendChild(child) { this.children.push(child); },
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  };
}

function fixture({ loading = false, sdkImportError = false } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<[a-z]+\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    nodes.set(match[2], element(match[1]));
  }
  nodes.get("mode").value = "panel-frame";
  const documentEvents = {};
  const windowEvents = {};
  const timers = new Map();
  const logs = [];
  let nextTimer = 0;
  let showHandler;
  let showCalls = 0;
  const calls = { factory: 0, project: 0, writes: 0 };
  const forbiddenWrite = () => { calls.writes++; throw new Error("unexpected native write"); };
  const ppro = {
    VideoFilterFactory: {
      getMatchNames: async () => { calls.factory++; return ["AE.ADBE Crop"]; },
      createComponent: forbiddenWrite
    },
    Project: { getActiveProject: async () => { calls.project++; return null; } }
  };
  const document = {
    readyState: loading ? "loading" : "complete",
    getElementById: id => nodes.get(id),
    createElement: () => element(""),
    addEventListener(name, callback) { (documentEvents[name] ||= []).push(callback); }
  };
  const window = {
    addEventListener(name, callback) { (windowEvents[name] ||= []).push(callback); }
  };
  const context = vm.createContext({
    window, document,
    require(name) {
      if (name === "uxp") return {
        storage: {}, entrypoints: { setup(value) { showHandler = value.panels.blackCropPanel.show; } }
      };
      if (name === "premierepro") {
        if (sdkImportError) throw new Error("premierepro SDK import failed");
        return ppro;
      }
      throw new Error(`Unexpected external require: ${name}`);
    },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: {
      log: (...values) => logs.push(values.join(" ")),
      error: (...values) => logs.push(values.join(" "))
    }
  });
  vm.runInContext(bootstrap, context, { filename: "bootstrap.js" });
  return {
    nodes, context, document, calls, logs, timers,
    boot: () => window.__kenshiroBoot,
    runBundle: () => vm.runInContext(bundle, context, { filename: "production-main.js" }),
    domReady: async () => {
      document.readyState = "complete";
      for (const callback of documentEvents.DOMContentLoaded || []) await callback();
    },
    click: async id => {
      for (const callback of nodes.get(id).listeners.click || []) await callback();
    },
    emitWindowError: error => {
      for (const callback of windowEvents.error || []) callback({ error });
    },
    show: () => { showCalls++; return showHandler(); },
    showCalls: () => showCalls
  };
}

test("production bundle eagerly initializes without host show and real diagnostics updates readonly output", async () => {
  assert.ok(html.indexOf('src="bootstrap.js"') < html.indexOf('src="dist/main.js"'));
  const f = fixture();
  assert.equal(f.nodes.get("analyze").disabled, true);
  f.runBundle();
  assert.equal(f.showCalls(), 0);
  assert.equal(f.boot().initialized, true);
  assert.equal(f.nodes.get("analyze").disabled, false);
  assert.equal(f.nodes.get("mode").disabled, false);
  assert.equal(f.nodes.get("diagnose").disabled, false);
  assert.equal(f.nodes.get("apply").disabled, true);
  assert.match(f.nodes.get("startup-status").textContent, new RegExp(`起動済み v${version.replaceAll(".", "\\.")}`));
  assert.ok(f.logs.some(line => line.includes("[Kenshiro] panel handlers ready")));
  assert.equal(f.timers.size, 0, "successful startup cancels the bootstrap watchdog");
  await f.click("diagnose");
  assert.equal(f.nodes.get("diagnostics").readOnly, true);
  assert.match(f.nodes.get("diagnostics").value, /候補 matchName: AE\.ADBE Crop/);
  assert.match(f.nodes.get("diagnostics").value, /アクティブなプロジェクト: なし/);
  assert.equal(f.calls.factory, 1);
  assert.equal(f.calls.project, 1);
  assert.equal(f.calls.writes, 0);
  assert.equal(f.nodes.get("diagnose").disabled, false);
  assert.equal(f.nodes.get("mode").disabled, false);
  assert.equal(f.timers.size, 0, "completed read-only diagnostics clears its timers");
});

test("production bundle binds on DOM readiness and later host show does not duplicate handlers", async () => {
  const f = fixture({ loading: true });
  f.runBundle();
  assert.equal(f.boot().initialized, false);
  assert.equal(f.nodes.get("analyze").listeners.click, undefined);
  await f.domReady();
  assert.equal(f.showCalls(), 0);
  assert.equal(f.boot().initialized, true);
  assert.equal(f.nodes.get("analyze").listeners.click.length, 1);
  assert.equal(f.nodes.get("diagnose").listeners.click.length, 1);
  f.show();
  assert.equal(f.nodes.get("analyze").listeners.click.length, 1);
  await f.click("diagnose");
  assert.equal(f.calls.factory, 1);
});

test("bootstrap remains available to display an SDK import failure before panel initialization", () => {
  const f = fixture({ sdkImportError: true });
  let importError;
  try { f.runBundle(); } catch (error) { importError = error; }
  assert.match(importError.message, /premierepro SDK import failed/);
  // vm does not dispatch browser events itself: emulate UXP's global error
  // event for the real bundle exception, using the listener bootstrap installed.
  f.emitWindowError(importError);
  assert.equal(f.boot().initialized, false);
  assert.match(f.nodes.get("startup-status").textContent, /起動・実行エラー: premierepro SDK import failed/);
  assert.match(f.nodes.get("diagnostics").value, /premierepro SDK import failed/);
  assert.equal(f.nodes.get("analyze").disabled, true);
  assert.equal(f.nodes.get("diagnose").disabled, true);
  assert.ok(f.logs.some(line => line.includes("[Kenshiro] premierepro SDK import failed")));
});
