"use strict";

const KNOWN_CROP_NAMES = ["AE.ADBE Crop", "PR.ADBE Crop", "ADBE Crop"];
const MAX_COMPONENTS = 8;
const MAX_PARAMS = 32;
const MAX_FACTORY_NAMES = 40;

// Inspect only SDK identifiers/labels and primitive numeric/boolean values.
// Never serialize arbitrary SDK objects, error messages, text or media paths.
function label(value) {
  if (typeof value !== "string") return "（文字列ではありません）";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function valueShape(value, depth = 0, seen = new Set()) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") return Number.isFinite(value) ? `number(${value})` : "number（有限値ではありません）";
  if (type === "boolean") return `boolean(${value})`;
  if (type === "string") return "string（内容省略）";
  if (type !== "object") return type;
  if (depth >= 4) return "object（深さ制限）";
  if (seen.has(value)) return "object（循環参照）";
  seen.add(value);
  if (ArrayBuffer.isView(value)) return `binary-view（長さ ${value.byteLength}）`;
  if (value instanceof ArrayBuffer) return `ArrayBuffer（長さ ${value.byteLength}）`;
  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map(item => valueShape(item, depth + 1, seen));
    return `array（長さ ${value.length}）[${items.join(", ")}${value.length > 4 ? ", …" : ""}]`;
  }
  const fields = [];
  for (const key of ["value", "x", "y"]) {
    try {
      if (key in value) fields.push(`${key}: ${valueShape(value[key], depth + 1, seen)}`);
    } catch (_) {
      fields.push(`${key}: 読み取りエラー`);
    }
  }
  return fields.length ? `object{${fields.join(", ")}}` : "object（value/x/y以外は省略）";
}

function countIsValid(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Read-only bounded diagnostics for the first currently selected video clip. */
async function collectPremiereDiagnostics(ppro, {
  timeoutMs = 1500, totalTimeoutMs = 6000, onProgress
} = {}) {
  const stepLimit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500;
  const totalLimit = Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0 ? totalTimeoutMs : 6000;
  const deadline = Date.now() + totalLimit;
  const stop = {};
  const timedOut = {};
  const lines = [];

  function progress(pending) {
    if (typeof onProgress !== "function") return;
    try {
      const snapshot = pending ? `${lines.join("\n")}\n${pending}` : lines.join("\n");
      // UI observers are optional and must neither block SDK reads nor create
      // unhandled rejections when an asynchronous observer fails.
      const result = onProgress(snapshot);
      if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
    } catch (_) { /* A display failure must not hide the diagnostic report. */ }
  }

  function append(...values) {
    lines.push(...values);
    progress();
  }

  append("Premiere Pro 黒枠クロップ 診断",
    "読み取りのみ。素材パス・プロジェクト名・テキスト値は収集しません。");

  async function read(operation, callback) {
    let timer;
    try {
      progress(`${operation}: 読み取り中…`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        append(`${operation}: 診断全体の制限時間（${totalLimit}ms）に達したため中断しました。ここまでの結果を表示します。`);
        throw stop;
      }
      const limit = Math.min(stepLimit, remaining);
      // The SDK operation is read-only. Promise.race attaches rejection
      // handlers even if the native Promise completes after the timeout.
      const result = await Promise.race([
        Promise.resolve().then(callback).then(value => ({ value })),
        new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), limit); })
      ]);
      if (result === timedOut) {
        append(`${operation}: タイムアウト（${limit}ms）。診断を中断し、ここまでの結果を表示します。`);
        throw stop;
      }
      return { ok: true, value: result.value };
    } catch (error) {
      if (error === stop) throw stop;
      // Native error.message may contain customer paths or authentication data.
      const safeKind = error instanceof TypeError ? "TypeError" :
        error instanceof RangeError ? "RangeError" : "Error";
      append(`${operation}: 取得失敗（${safeKind}、詳細文字列は省略）`);
      return { ok: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function inspect() {

    if (!ppro) {
      append("premierepro SDK: 利用できません。");
      return lines.join("\n");
    }
    append("premierepro SDK: 読み込み済み");

    const factoryResult = await read("VideoFilterFactory.getMatchNames", () => ppro.VideoFilterFactory.getMatchNames());
    if (factoryResult.ok) {
      const names = factoryResult.value;
      if (!Array.isArray(names)) {
        append(`エフェクト一覧: 想定外の返却型 ${typeName(names)}`);
      } else {
        const cropNames = names.filter(name => typeof name === "string" && /crop|切り抜き|クロップ|クロッピング/i.test(name));
        append(`利用可能エフェクト: ${names.length} 件、Crop候補: ${cropNames.length} 件`);
        cropNames.slice(0, MAX_FACTORY_NAMES).forEach(name => append(`  候補 matchName: ${label(name)}`));
        if (cropNames.length > MAX_FACTORY_NAMES) append("  Crop候補一覧は40件で打ち切りました。");
        const exact = KNOWN_CROP_NAMES.filter(name => names.includes(name));
        append(`実装の既知Crop名との完全一致: ${exact.length ? exact.join(", ") : "なし"}`);
      }
    }

    const projectResult = await read("Project.getActiveProject", () => ppro.Project.getActiveProject());
    if (!projectResult.ok || !projectResult.value) {
      if (projectResult.ok) append("アクティブなプロジェクト: なし");
      return lines.join("\n");
    }
    append("アクティブなプロジェクト: あり");
    const project = projectResult.value;
    const sequenceResult = await read("Project.getActiveSequence", () => project.getActiveSequence());
    if (!sequenceResult.ok || !sequenceResult.value) {
      if (sequenceResult.ok) append("アクティブなシーケンス: なし");
      return lines.join("\n");
    }
    const selectionResult = await read("Sequence.getSelection", () => sequenceResult.value.getSelection());
    if (!selectionResult.ok || !selectionResult.value) return lines.join("\n");
    const tracksResult = await read("TrackItemSelection.getTrackItems", () => selectionResult.value.getTrackItems());
    if (!tracksResult.ok) return lines.join("\n");
    const tracks = tracksResult.value;
    if (!Array.isArray(tracks)) {
      append(`選択クリップ一覧: 想定外の返却型 ${typeName(tracks)}`);
      return lines.join("\n");
    }
    append(`選択クリップ: ${tracks.length} 件（先頭のビデオクリップ1件を診断）`);
    const videoResult = await read("VideoClipTrackItem 型判定", () => tracks.slice(0, 100).find(track => track instanceof ppro.VideoClipTrackItem));
    if (!videoResult.ok || !videoResult.value) {
      if (videoResult.ok) append("診断対象のビデオクリップ: なし（先頭100件まで確認）");
      return lines.join("\n");
    }
    const chainResult = await read("VideoClipTrackItem.getComponentChain", () => videoResult.value.getComponentChain());
    if (!chainResult.ok || !chainResult.value) return lines.join("\n");
    const chain = chainResult.value;
    const countResult = await read("VideoComponentChain.getComponentCount", () => chain.getComponentCount());
    if (!countResult.ok) return lines.join("\n");
    const count = countResult.value;
    if (!countIsValid(count)) {
      append(`エフェクト件数: 想定外の返却型 ${typeName(count)}`);
      return lines.join("\n");
    }
    append(`選択クリップのエフェクト: ${count} 件（最大${MAX_COMPONENTS}件を表示）`);
    let intrinsicCropFound = false;
    for (let index = 0; index < Math.min(count, MAX_COMPONENTS); index++) {
      const prefix = `エフェクト[${index}]`;
      const componentResult = await read(`${prefix} getComponentAtIndex`, () => chain.getComponentAtIndex(index));
      if (!componentResult.ok || !componentResult.value) continue;
      const component = componentResult.value;
      const matchResult = await read(`${prefix} getMatchName`, () => component.getMatchName());
      const matchName = matchResult.ok && typeof matchResult.value === "string" ? matchResult.value : "";
      append(`${prefix} matchName: ${matchResult.ok ? label(matchResult.value) : "取得失敗"}`);
      const paramsCountResult = await read(`${prefix} getParamCount`, () => component.getParamCount());
      if (!paramsCountResult.ok) continue;
      const paramsCount = paramsCountResult.value;
      if (!countIsValid(paramsCount)) {
        append(`  パラメータ件数: 想定外の返却型 ${typeName(paramsCount)}`);
        continue;
      }
      append(`  パラメータ: ${paramsCount} 件（最大${MAX_PARAMS}件）`);
      const sideHints = new Set();
      for (let paramIndex = 0; paramIndex < Math.min(paramsCount, MAX_PARAMS); paramIndex++) {
        const paramPrefix = `${prefix} パラメータ[${paramIndex}]`;
        const paramResult = await read(`${paramPrefix} getParam`, () => component.getParam(paramIndex));
        if (!paramResult.ok || !paramResult.value) continue;
        const param = paramResult.value;
        const nameResult = await read(`${paramPrefix} displayName`, () => param.displayName);
        const name = nameResult.ok && typeof nameResult.value === "string" ? nameResult.value : "";
        append(`  [${paramIndex}] 名前: ${nameResult.ok ? label(nameResult.value) : "取得失敗"}`);
        const simpleSide = name.normalize("NFKC").toLowerCase().replace(/[\s()（）_\-]/g, "");
        if (/crop|切り抜き|クロップ/i.test(name) ||
            /^(left|right|top|bottom|左|左側|左端|右|右側|右端|上|上側|上端|下|下側|下端)$/.test(simpleSide)) {
          if (/left|左/i.test(name)) sideHints.add("left");
          if (/right|右/i.test(name)) sideHints.add("right");
          if (/top|上/i.test(name)) sideHints.add("top");
          if (/bottom|下/i.test(name)) sideHints.add("bottom");
        }
        const varyingResult = await read(`${paramPrefix} isTimeVarying`, () => param.isTimeVarying());
        if (varyingResult.ok) append(`    isTimeVarying: ${valueShape(varyingResult.value)}`);
        const startResult = await read(`${paramPrefix} getStartValue`, () => param.getStartValue());
        if (startResult.ok) append(`    getStartValue の型と値: ${valueShape(startResult.value)}`);
      }
      if (/motion|モーション/i.test(matchName) && sideHints.size === 4) intrinsicCropFound = true;
    }
    append(`Motion内の四方向Crop名: ${intrinsicCropFound ? "検出（別エフェクトCropとは異なる構成）" : "この診断範囲では未確認"}`);
    return lines.join("\n");
  }

  try {
    return await inspect();
  } catch (error) {
    if (error !== stop) append("診断処理内でエラーが発生しました（詳細文字列は省略）。ここまでの結果を表示します。");
    return lines.join("\n");
  }
}

module.exports = { collectPremiereDiagnostics };
