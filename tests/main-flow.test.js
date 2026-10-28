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
  if (options.missingId) nodes.delete(options.missingId);
  const documentEvents = new Map();
  const boot = { initialized: false, errors: [], markReady() { this.initialized = true; }, reportError(error) { this.errors.push(error.message); } };
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
    "../manifest.json": { version: "0.1.5" },
    "./border-detection": { detectBorders: (image, mode) => {
      const result = mode === "panel-frame" ? detectPanelFrame(image) : detectBlackBorders(image);
      return options.detection || result;
    } },
    "./premiere-diagnostics": { collectPremiereDiagnostics: async () => {
      calls.diagnostics++;
      if (options.diagnosticsWait) await options.diagnosticsWait;
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
    document: {
      readyState: options.readyState || "complete",
      getElementById: id => nodes.get(id), createElement: () => element(),
      addEventListener: (name, callback) => documentEvents.set(name, callback)
    },
    window: { __kenshiroBoot: boot },
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
    nodes, calls, context, boot,
    show: () => panel.show(),
    domReady: () => documentEvents.get("DOMContentLoaded")(),
    event: async (id, name = "click") => {
      for (const callback of nodes.get(id).listeners[name] || []) await callback();
    },
    status: () => nodes.get("status").textContent,
    results: () => fullText(nodes.get("results"))
  };
  if (!options.skipShow) api.show();
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
  assert.match(f.results(), /適用済み：モーションの切り抜き/);
  assert.match(f.status(), /反映先はモーションの切り抜き/);
  assert.doesNotMatch(f.status(), /Motionは未変更/);
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
  assert.match(f.nodes.get("diagnostics").value, /Kenshiro v0\.1\.5/);
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

test("white-margin fallback reports the actual method and applies crop values to Motion", async () => {
  const result = { ...detection("edge-bands"), method: "white-margin-frame-fallback" };
  const f = fixture({ detection: result });
  f.nodes.get("mode").value = "edge-bands";
  await f.event("analyze");
  assert.match(f.results(), /検出: 白い余白の内側の黒いコマ枠/);
  assert.doesNotMatch(f.results(), /拡大の目安|Scale|Position/);
  await f.event("apply");
  assert.equal(f.calls.apply.length, 1);
  assert.equal(f.calls.apply[0].detection, result);
  assert.equal("fit" in f.calls.apply[0], false);
});

test("no detected border is skipped and cannot reset an existing Crop to zero", async () => {
  const result = {
    ...detection("edge-bands"),
    pixels: { left: 0, right: 0, top: 0, bottom: 0 },
    percentages: { left: 0, right: 0, top: 0, bottom: 0 }
  };
  const f = fixture({ detection: result });
  f.nodes.get("mode").value = "edge-bands";
  await f.event("analyze");
  assert.match(f.results(), /黒帯を検出できませんでした/);
  assert.match(f.status(), /適用待ち 0 件、スキップ 1 件/);
  assert.equal(f.nodes.get("apply").disabled, true);
  await f.event("apply");
  assert.equal(f.calls.apply.length, 0);
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

test("buttons initialize without requiring an entrypoint show notification", async () => {
  const f = fixture({ skipShow: true });
  assert.equal(f.boot.initialized, true);
  assert.equal(f.nodes.get("analyze").listeners.click.length, 1);
  await f.event("analyze");
  assert.equal(f.calls.read.length, 1);
});

test("DOM-ready initializes the panel once even when show arrives later", async () => {
  const f = fixture({ readyState: "loading", skipShow: true });
  assert.equal(f.boot.initialized, false);
  f.domReady();
  f.show();
  assert.equal(f.boot.initialized, true);
  assert.equal(f.nodes.get("analyze").listeners.click.length, 1);
});

test("failed startup is visible and can be retried after a missing DOM node is restored", async () => {
  const f = fixture({ missingId: "diagnostics", skipShow: true });
  assert.equal(f.boot.initialized, false);
  assert.match(f.status(), /起動失敗.*diagnostics/);
  f.nodes.set("diagnostics", element());
  f.show();
  f.show();
  assert.equal(f.boot.initialized, true);
  assert.equal(f.nodes.get("analyze").listeners.click.length, 1);
});

test("a diagnostic SDK wait does not lock analysis or overwrite a newer run", async () => {
  let release;
  const diagnosticsWait = new Promise(resolve => { release = resolve; });
  const f = fixture({ diagnosticsWait });
  const pending = f.event("diagnose");
  assert.match(f.nodes.get("diagnostics").value, /取得中/);
  assert.equal(f.nodes.get("mode").disabled, false);
  assert.equal(f.nodes.get("analyze").disabled, false);
  await f.event("analyze");
  release();
  await pending;
  assert.equal(f.nodes.get("diagnostics").value, "");
  assert.match(f.status(), /適用待ち 1/);
});

test("optional automatic diagnostics do not block completion of a failed apply", async () => {
  let release;
  const diagnosticsWait = new Promise(resolve => { release = resolve; });
  const f = fixture({ diagnosticsWait, hostFailPaths: ["/images/sample-1.tif"] });
  await f.event("analyze");
  await f.event("apply");
  assert.match(f.status(), /失敗理由/);
  assert.equal(f.nodes.get("analyze").disabled, false);
  assert.equal(f.nodes.get("mode").disabled, false);
  release();
});

test("an event-handler exception before its inner try is displayed and clears busy", async () => {
  const f = fixture();
  f.nodes.delete("diagnostics");
  await f.event("analyze");
  assert.match(f.status(), /解析:/);
  assert.equal(f.nodes.get("analyze").disabled, false);
  f.nodes.set("diagnostics", element());
  await f.event("analyze");
  assert.equal(f.calls.read.length, 1);
});
