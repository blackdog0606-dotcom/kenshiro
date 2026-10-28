"use strict";

// Exercise the actual panel controller. Only UXP/Premiere, image I/O and
// algorithms are mocked; this does not claim native-host integration coverage.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");

function element() {
  let content = "";
  return {
    disabled: false, value: "", className: "", children: [], listeners: {},
    get textContent() { return content; },
    set textContent(value) { content = String(value); this.children = []; },
    appendChild(child) { this.children.push(child); },
    addEventListener(name, callback) {
      (this.listeners[name] ||= []).push(callback);
    }
  };
}

function fullText(node) {
  return [node.textContent, ...node.children.map(fullText)].join(" ");
}

function detection(mode) {
  const margin = mode === "panel-frame" ? 12 : 1;
  return {
    status: "ok", mode, width: 1000, height: 500,
    pixels: { left: margin * 10, right: 10, top: 5, bottom: 5 },
    percentages: { left: margin, right: 1, top: 1, bottom: 1 }
  };
}

function fixture(options = {}) {
  const nodes = new Map(["analyze", "apply", "cancel", "mode", "status", "results", "diagnose", "diagnostics"].map(id => [id, element()]));
  nodes.get("mode").value = "panel-frame";
  const items = Array.from({ length: options.count || 1 }, (_, index) => ({
    name: `sample-${index + 1}.tif`, path: `/images/sample-${index + 1}.tif`, trackItem: { index }
  }));
  const calls = { read: [], verify: [], apply: [], panel: 0, edges: 0, diagnostics: 0 };
  let panel;
  let api;
  const context = {
    project: { guid: "project" },
    sequence: { getFrameSize: async () => ({ width: 1920, height: 1080 }) }, items
  };
  const detectPanelFrame = () => { calls.panel++; return detection("panel-frame"); };
  const detectBlackBorders = () => { calls.edges++; return detection("edge-bands"); };
  const imports = {
    uxp: { entrypoints: { setup(value) { panel = value.panels.blackCropPanel; } }, storage: {} },
    premierepro: {},
    "../manifest.json": { version: "0.1.1" },
    "./premiere-diagnostics": { collectPremiereDiagnostics: async () => {
      calls.diagnostics++;
      if (options.diagnosticsError) throw new Error("診断APIを読み取れません。");
      return "Crop候補: AE.ADBE Crop\n構成: ADBE Motion";
    } },
    "./premiere-host": { createPremiereHost: () => ({
      getSelection: async () => {
        if (options.selectionWait) await options.selectionWait;
        if (options.selectionError) throw new Error(options.selectionError);
        return context;
      },
      applyCrop: async (currentContext, record) => {
        assert.equal(currentContext, context);
        calls.apply.push(record);
        if ((options.hostFailPaths || []).includes(record.path)) {
          throw new Error("解析後にシーケンスが変更されました。再解析してください。");
        }
      }
    }) },
    "./source-file": {
      readSource: async (storage, path) => {
        calls.read.push(path);
        if ((options.readFailPaths || []).includes(path)) throw new Error("元画像を読み込めません。");
        return { bytes: new Uint8Array([1, 2]), signature: `signature:${path}` };
      },
      verifySource: async (storage, path, signature) => {
        calls.verify.push(path);
        assert.equal(signature, `signature:${path}`);
        if ((options.sourceFailPaths || []).includes(path)) {
          throw new Error("解析後に元画像が変更されました。再解析してください。");
        }
      }
    },
    "./image-reader": { decodeImage: (bytes, extension) => {
      assert.equal(extension, "tif");
      return { width: 1000, height: 500, data: new Uint8Array(4) };
    } },
    "./black-borders": { detectBlackBorders },
    "./panel-frame": { detectPanelFrame },
    "./fit-geometry": { calculateFit: () => ({ scalePercent: 100, positionPixels: { x: 960, y: 540 } }) }
  };
  const sandbox = {
    require(name) {
      assert.ok(imports[name], `Unmocked panel dependency: ${name}`);
      return imports[name];
    },
    document: { getElementById: id => nodes.get(id), createElement: () => element() },
    setTimeout(callback) {
      queueMicrotask(() => {
        if (options.onYield) options.onYield(api);
        callback();
      });
      return 0;
    },
    console
  };
  vm.runInNewContext(readFileSync(resolve(__dirname, "../src/main.js"), "utf8"), sandbox,
    { filename: "main.js" });
  api = {
    nodes, calls, context,
    show: () => panel.show(),
    event: async (id, name = "click") => {
      for (const callback of nodes.get(id).listeners[name] || []) await callback();
    },
    status: () => nodes.get("status").textContent,
    results: () => fullText(nodes.get("results"))
  };
  api.show();
  return api;
}

test("panel initialization is idempotent and TIFF analyze/apply changes button states", async () => {
  const f = fixture();
  f.show();
  assert.equal(f.nodes.get("analyze").listeners.click.length, 1);
  assert.equal(f.nodes.get("apply").disabled, true);
  assert.equal(f.nodes.get("cancel").disabled, true);
  await f.event("analyze");
  assert.match(f.status(), /適用待ち 1/);
  assert.equal(f.nodes.get("apply").disabled, false);
  await f.event("apply");
  assert.equal(f.calls.read.length, 1);
  assert.equal(f.calls.verify.length, 1);
  assert.equal(f.calls.apply.length, 1);
  assert.match(f.status(), /成功 1 件、失敗 0/);
  assert.match(f.results(), /適用済み/);
  assert.equal(f.nodes.get("apply").disabled, true);
  assert.equal(f.nodes.get("analyze").disabled, false);
});

test("ten selected clips are each analyzed, rechecked and applied", async () => {
  const f = fixture({ count: 10 });
  await f.event("analyze");
  await f.event("apply");
  assert.equal(new Set(f.calls.read).size, 10);
  assert.equal(new Set(f.calls.verify).size, 10);
  assert.equal(new Set(f.calls.apply.map(record => record.path)).size, 10);
  assert.match(f.status(), /成功 10 件、失敗 0/);
});

test("a pending analysis disables mode changes and duplicate actions until completion", async () => {
  let release;
  const selectionWait = new Promise(resolve => { release = resolve; });
  const f = fixture({ selectionWait });
  const running = f.event("analyze");
  assert.equal(f.nodes.get("mode").disabled, true);
  assert.equal(f.nodes.get("analyze").disabled, true);
  assert.equal(f.nodes.get("apply").disabled, true);
  assert.equal(f.nodes.get("cancel").disabled, false);
  await f.event("analyze");
  assert.equal(f.calls.read.length, 0);
  release();
  await running;
  assert.equal(f.calls.read.length, 1);
  assert.equal(f.nodes.get("mode").disabled, false);
  assert.equal(f.nodes.get("analyze").disabled, false);
});

test("one apply failure is displayed and processing continues with remaining clips", async () => {
  const f = fixture({ count: 3, hostFailPaths: ["/images/sample-2.tif"] });
  await f.event("analyze");
  await f.event("apply");
  assert.equal(f.calls.apply.length, 3);
  assert.match(f.status(), /成功 2 件、失敗 1/);
  assert.match(f.results(), /シーケンスが変更/);
  assert.match(f.status(), /失敗理由:.*シーケンスが変更/);
  assert.equal(f.calls.diagnostics, 1);
  assert.match(f.nodes.get("diagnostics").value, /Kenshiro v0\.1\.1/);
  assert.match(f.nodes.get("diagnostics").value, /Crop候補/);
  assert.match(f.nodes.get("diagnostics").value, /シーケンスが変更/);
  assert.equal(f.nodes.get("analyze").disabled, false);
});

test("more than ten selected clips never read source files or apply effects", async () => {
  const f = fixture({ count: 11 });
  await f.event("analyze");
  await f.event("apply");
  assert.match(f.status(), /10クリップ/);
  assert.equal(f.calls.read.length, 0);
  assert.equal(f.calls.verify.length, 0);
  assert.equal(f.calls.apply.length, 0);
  assert.equal(f.nodes.get("apply").disabled, true);
  assert.equal(f.nodes.get("diagnostics").value, "");
});

test("manual diagnostics are read-only and do not require a preceding analysis", async () => {
  const f = fixture();
  await f.event("diagnose");
  assert.equal(f.calls.diagnostics, 1);
  assert.equal(f.calls.read.length, 0);
  assert.equal(f.calls.apply.length, 0);
  assert.match(f.nodes.get("diagnostics").value, /ADBE Motion/);
  assert.equal(f.nodes.get("diagnose").disabled, false);
});

test("diagnostic failure cannot hide the original apply error or leave controls disabled", async () => {
  const f = fixture({ hostFailPaths: ["/images/sample-1.tif"], diagnosticsError: true });
  await f.event("analyze");
  await f.event("apply");
  assert.match(f.status(), /失敗理由:.*シーケンスが変更/);
  assert.match(f.nodes.get("diagnostics").value, /シーケンスが変更/);
  assert.match(f.nodes.get("diagnostics").value, /診断APIを読み取れません/);
  assert.equal(f.nodes.get("analyze").disabled, false);
});

test("cancel stops at a clip checkpoint and leaves unprocessed clips available", async () => {
  let cancelled = false;
  const f = fixture({ count: 3, onYield(current) {
    if (!cancelled && current.calls.apply.length === 1) {
      cancelled = true;
      current.nodes.get("cancel").listeners.click[0]();
    }
  } });
  await f.event("analyze");
  await f.event("apply");
  assert.equal(f.calls.apply.length, 1);
  assert.match(f.status(), /適用中断/);
  assert.equal(f.nodes.get("apply").disabled, false);
  await f.event("apply");
  assert.equal(f.calls.apply.length, 3);
  assert.equal(f.nodes.get("apply").disabled, true);
});

test("changing detection mode invalidates pending analysis and uses the selected detector next", async () => {
  const f = fixture();
  await f.event("analyze");
  assert.equal(f.calls.panel, 1);
  assert.equal(f.calls.edges, 0);
  f.nodes.get("mode").value = "edge-bands";
  await f.event("mode", "change");
  assert.equal(f.nodes.get("apply").disabled, true);
  await f.event("apply");
  assert.equal(f.calls.apply.length, 0);
  await f.event("analyze");
  await f.event("apply");
  assert.equal(f.calls.edges, 1);
  assert.equal(f.calls.apply[0].detection.percentages.left, 1);
});

test("source verification failure is displayed and prevents a stale effect write", async () => {
  const f = fixture({ count: 2, sourceFailPaths: ["/images/sample-1.tif"] });
  await f.event("analyze");
  await f.event("apply");
  assert.equal(f.calls.verify.length, 2);
  assert.equal(f.calls.apply.length, 1);
  assert.equal(f.calls.apply[0].path, "/images/sample-2.tif");
  assert.match(f.results(), /元画像が変更/);
  assert.match(f.status(), /成功 1 件、失敗 1/);
});

test("selection and source read errors restore controls and give actionable feedback", async () => {
  const absent = fixture({ selectionError: "シーケンスを開いてください。" });
  await absent.event("analyze");
  assert.match(absent.status(), /シーケンスを開いて/);
  assert.equal(absent.nodes.get("analyze").disabled, false);
  assert.equal(absent.nodes.get("apply").disabled, true);
  const unreadable = fixture({ readFailPaths: ["/images/sample-1.tif"] });
  await unreadable.event("analyze");
  assert.match(unreadable.results(), /元画像を読み込めません/);
  assert.equal(unreadable.nodes.get("apply").disabled, true);
});
