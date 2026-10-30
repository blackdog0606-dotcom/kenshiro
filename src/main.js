"use strict";

const { entrypoints, storage } = require("uxp");
const ppro = require("premierepro");
const { createPremiereHost } = require("./premiere-host");
const { decodeImage } = require("./image-reader");
const { detectBorders } = require("./border-detection");
const { readSource, verifySource } = require("./source-file");
const { collectPremiereDiagnostics } = require("./premiere-diagnostics");
const { version: PLUGIN_VERSION } = require("../manifest.json");

const host = createPremiereHost(ppro);
let context = null;
let records = [];
let busy = false;
let cancelled = false;
let initialized = false;
let diagnosticBusy = false;
let diagnosticRun = 0;
const boundEvents = new Set();
const el = id => document.getElementById(id);
const message = error => error && error.message ? error.message : String(error);
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

function controls() {
  el("mode").disabled = busy;
  el("analyze").disabled = busy;
  el("apply").disabled = busy || !records.some(record => record.state === "ready");
  el("cancel").disabled = !busy;
  el("diagnose").disabled = busy || diagnosticBusy;
}

function clearDiagnostics() {
  diagnosticRun++;
  diagnosticBusy = false;
  el("diagnostics").value = "";
}

async function refreshDiagnostics(failures = []) {
  const run = ++diagnosticRun;
  diagnosticBusy = true;
  const lines = [`Kenshiro v${PLUGIN_VERSION}`];
  failures.forEach((record, index) => lines.push(`失敗 ${index + 1}: ${record.error}`));
  const prefix = lines.join("\n");
  try {
    controls();
    el("diagnostics").value = `${prefix}\n診断情報を取得中…`;
    const report = await collectPremiereDiagnostics(ppro, {
      onProgress: partial => {
        if (run === diagnosticRun) el("diagnostics").value = `${prefix}\n${partial}`;
      }
    });
    if (run === diagnosticRun) el("diagnostics").value = `${prefix}\n${report}`;
  } catch (error) {
    if (run === diagnosticRun) {
      const field = el("diagnostics");
      if (field) field.value = `${prefix}\n診断情報の取得にも失敗しました: ${message(error)}`;
      console.error(`[Kenshiro] diagnostics: ${message(error)}`);
    }
  } finally {
    if (run === diagnosticRun) {
      diagnosticBusy = false;
      controls();
    }
  }
}

async function diagnose() {
  if (busy || diagnosticBusy) return;
  await refreshDiagnostics(records.filter(record => record.error));
}

function text(parent, value, className) {
  const node = document.createElement("div");
  node.textContent = value;
  if (className) node.className = className;
  parent.appendChild(node);
}

function render() {
  const list = el("results");
  list.textContent = "";
  records.forEach((record, index) => {
    const row = document.createElement("div");
    row.className = "result";
    text(row, `${index + 1}. ${record.name || "名称不明"}`, "name");
    const label = record.state === "applied" ? "適用済み：モーションの切り抜き" : record.state === "ready" ? "適用待ち" : "スキップ／失敗";
    text(row, record.error ? `${label}: ${record.error}` : label, record.error ? "error" : record.state === "applied" ? "success" : "");
    if (record.detection && record.detection.status === "ok") {
      const d = record.detection;
      text(row, d.method === "white-margin-frame-fallback"
        ? "検出: 白い余白の内側の黒いコマ枠"
        : d.mode === "partial-frame" ? "検出: 白余白と部分コマ枠（検出なしの辺は0%）"
        : d.mode === "panel-frame" ? "検出: 黒いコマ枠" : "検出: 画像端から連続する黒帯");
      text(row, `${d.width} × ${d.height}px ／ クロップpx: 左${d.pixels.left} 右${d.pixels.right} 上${d.pixels.top} 下${d.pixels.bottom}`);
      const p = d.percentages;
      text(row, `Left ${p.left.toFixed(1)}% ／ Right ${p.right.toFixed(1)}% ／ Top ${p.top.toFixed(1)}% ／ Bottom ${p.bottom.toFixed(1)}%`, "values");
    }
    list.appendChild(row);
  });
  controls();
}

async function analyze() {
  if (busy) return;
  busy = true;
  cancelled = false;
  context = null;
  records = [];
  el("status").className = "";
  clearDiagnostics();
  const mode = el("mode").value;
  render();
  try {
    const selected = await host.getSelection();
    if (!selected.items.length) throw new Error("タイムラインでPNG／JPEG／TIFの静止画クリップを選択してください。");
    if (selected.items.length > 10) throw new Error("最小版は1回10クリップまでです。選択数を減らしてください。");
    context = selected;
    for (const item of selected.items) {
      if (cancelled) break;
      const record = { ...item, state: "skipped" };
      records.push(record);
      el("status").textContent = `${records.length} / ${selected.items.length} 解析中…`;
      try {
        if (item.error) throw new Error(item.error);
        const { bytes, signature } = await readSource(storage, item.path);
        record.signature = signature;
        const extension = item.path.split(".").pop();
        const image = decodeImage(bytes, extension);
        record.detection = detectBorders(image, mode);
        if (record.detection.status !== "ok") {
          throw new Error(mode === "partial-frame"
            ? "白い余白と長い黒い枠線を確定できません。枠線の外側に白い余白がある画像を使用してください。"
            : mode === "panel-frame"
            ? "四辺の黒いコマ枠を確定できません。枠の欠け・傾き・複数の枠などを確認してください。"
            : "黒枠と内容の境界を確定できません（全黒・ほぼ全黒、または丸めで内容が消える画像）。");
        }
        if (Object.values(record.detection.pixels).every(value => value === 0)) {
          throw new Error("黒帯を検出できませんでした。白い余白の内側にも四辺の黒いコマ枠を確認できないため、適用しません。");
        }
        record.state = "ready";
      } catch (error) {
        record.error = message(error);
      }
      render();
      await yieldUI();
    }
    const ready = records.filter(r => r.state === "ready").length;
    const firstError = records.find(record => record.error);
    el("status").textContent = `${cancelled ? "解析中断" : "解析完了"}: 適用待ち ${ready} 件、スキップ ${records.length - ready} 件。値を確認して適用してください。${firstError ? `\nスキップ理由: ${firstError.error}` : ""}`;
  } catch (error) {
    el("status").textContent = message(error);
  } finally {
    busy = false;
    controls();
  }
}

async function apply() {
  if (busy || !context) return;
  busy = true;
  cancelled = false;
  el("status").className = "";
  clearDiagnostics();
  controls();
  const targets = records.filter(record => record.state === "ready");
  let applied = 0;
  let failed = 0;
  try {
    for (let index = 0; index < targets.length; index++) {
      if (cancelled) break;
      const record = targets[index];
      el("status").textContent = `${index + 1} / ${targets.length} 適用中…`;
      try {
        await verifySource(storage, record.path, record.signature);
        await host.applyCrop(context, record);
        record.state = "applied";
        applied++;
      } catch (error) {
        record.state = "failed";
        record.error = message(error);
        failed++;
      }
      render();
      await yieldUI();
    }
    const failures = targets.filter(record => record.state === "failed");
    el("status").className = failures.length ? "error" : "";
    el("status").textContent = `${cancelled ? "適用中断" : "適用完了"}: 成功 ${applied} 件、失敗 ${failed} 件。反映先はモーションの切り抜きです。スケール・位置は変更していません。取り消しは編集メニューの「取り消し」で行えます。${failures.length ? `\n失敗理由: ${failures[0].error}\n下の「診断情報」の文章をコピーして送ってください。` : ""}`;
    if (failures.length) void refreshDiagnostics(failures);
  } finally {
    busy = false;
    controls();
  }
}

function initialize() {
  if (initialized) return;
  for (const id of ["mode", "analyze", "apply", "cancel", "diagnose", "diagnostics", "status", "results"]) {
    if (!el(id)) throw new Error(`画面の部品「${id}」が見つかりません。HTMLとスクリプトの版が一致しているか確認してください。`);
  }
  function bind(id, event, callback) {
    const key = `${id}:${event}`;
    if (boundEvents.has(key)) return;
    el(id).addEventListener(event, callback);
    boundEvents.add(key);
  }
  bind("analyze", "click", () => dispatch("解析", analyze));
  bind("apply", "click", () => dispatch("適用", apply));
  bind("cancel", "click", () => { cancelled = true; });
  bind("diagnose", "click", () => dispatch("診断", diagnose));
  bind("mode", "change", () => {
    context = null;
    records = [];
    el("status").className = "";
    clearDiagnostics();
    render();
    el("status").textContent = "検出モードを変更しました。選択クリップを再解析してください。";
  });
  controls();
  initialized = true;
  if (typeof window !== "undefined" && window.__kenshiroBoot) window.__kenshiroBoot.markReady();
  console.log(`[Kenshiro] panel handlers ready v${PLUGIN_VERSION}`);
}

function reportError(error, label) {
  const description = `${label}: ${message(error)}`;
  console.error(`[Kenshiro] ${description}`);
  const status = el("status");
  if (status) { status.textContent = description; status.className = "error"; }
  if (typeof window !== "undefined" && window.__kenshiroBoot) window.__kenshiroBoot.reportError(new Error(description));
}

async function dispatch(label, action) {
  console.log(`[Kenshiro] ${label} click`);
  try { await action(); }
  catch (error) {
    busy = false;
    reportError(error, label);
    try { controls(); } catch (_) { /* Startup error is already visible. */ }
  }
}

function startPanel() {
  try { initialize(); } catch (error) { reportError(error, "起動失敗"); }
}

entrypoints.setup({ panels: { blackCropPanel: { show: startPanel } } });
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startPanel);
else startPanel();
