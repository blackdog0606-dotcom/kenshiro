"use strict";

const { entrypoints, storage } = require("uxp");
const ppro = require("premierepro");
const { createPremiereHost } = require("./premiere-host");
const { decodeImage } = require("./image-reader");
const { detectBlackBorders } = require("./black-borders");
const { detectPanelFrame } = require("./panel-frame");
const { calculateFit } = require("./fit-geometry");
const { readSource, verifySource } = require("./source-file");

const host = createPremiereHost(ppro);
let context = null;
let records = [];
let busy = false;
let cancelled = false;
let initialized = false;
const el = id => document.getElementById(id);
const message = error => error && error.message ? error.message : String(error);
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

function controls() {
  el("mode").disabled = busy;
  el("analyze").disabled = busy;
  el("apply").disabled = busy || !records.some(record => record.state === "ready");
  el("cancel").disabled = !busy;
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
    if (record.detection && record.detection.status === "ok") {
      const d = record.detection;
      text(row, `${d.width} × ${d.height}px ／ クロップpx: 左${d.pixels.left} 右${d.pixels.right} 上${d.pixels.top} 下${d.pixels.bottom}`);
      const p = d.percentages;
      text(row, `Left ${p.left.toFixed(1)}% ／ Right ${p.right.toFixed(1)}% ／ Top ${p.top.toFixed(1)}% ／ Bottom ${p.bottom.toFixed(1)}%`, "values");
    }
    if (record.fit) {
      const f = record.fit;
      text(row, `拡大の目安: Scale ${f.scalePercent.toFixed(2)}% ／ Position (${f.positionPixels.x.toFixed(1)}, ${f.positionPixels.y.toFixed(1)})px`, "muted");
      text(row, "正方形ピクセル・未回転・元画像中心アンカー・事前縮小なしの場合。既存設定によって要調整。", "muted");
    }
    const label = record.state === "applied" ? "適用済み" : record.state === "ready" ? "適用待ち" : "スキップ／失敗";
    text(row, record.error ? `${label}: ${record.error}` : label, record.error ? "error" : record.state === "applied" ? "success" : "");
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
  const mode = el("mode").value;
  render();
  try {
    const selected = await host.getSelection();
    if (!selected.items.length) throw new Error("タイムラインでPNG／JPEG／TIFの静止画クリップを選択してください。");
    if (selected.items.length > 10) throw new Error("最小版は1回10クリップまでです。選択数を減らしてください。");
    context = selected;
    let frame;
    try { frame = await context.sequence.getFrameSize(); } catch (_) { /* Crop alone remains usable. */ }
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
        record.detection = mode === "panel-frame" ? detectPanelFrame(image) : detectBlackBorders(image);
        if (record.detection.status !== "ok") {
          throw new Error(mode === "panel-frame"
            ? "四辺の黒いコマ枠を確定できません。枠の欠け・傾き・複数の枠などを確認してください。"
            : "黒枠と内容の境界を確定できません（全黒・ほぼ全黒、または丸めで内容が消える画像）。");
        }
        if (frame) {
          try { record.fit = calculateFit({ ...record.detection, sequenceWidth: frame.width, sequenceHeight: frame.height }); }
          catch (_) { /* Optional fit hints must not block a valid Crop. */ }
        }
        record.state = "ready";
      } catch (error) {
        record.error = message(error);
      }
      render();
      await yieldUI();
    }
    const ready = records.filter(r => r.state === "ready").length;
    el("status").textContent = `${cancelled ? "解析中断" : "解析完了"}: 適用待ち ${ready} 件、スキップ ${records.length - ready} 件。値を確認して適用してください。`;
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
    el("status").textContent = `${cancelled ? "適用中断" : "適用完了"}: 成功 ${applied} 件、失敗 ${failed} 件。Motionは未変更です。取り消しは編集メニューの「取り消し」で行えます。`;
  } finally {
    busy = false;
    controls();
  }
}

function initialize() {
  if (initialized) return;
  initialized = true;
  el("analyze").addEventListener("click", analyze);
  el("apply").addEventListener("click", apply);
  el("cancel").addEventListener("click", () => { cancelled = true; });
  el("mode").addEventListener("change", () => {
    context = null;
    records = [];
    render();
    el("status").textContent = "検出モードを変更しました。選択クリップを再解析してください。";
  });
  controls();
}

entrypoints.setup({ panels: { blackCropPanel: { show: initialize } } });
