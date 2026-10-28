"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectPremiereDiagnostics } = require("../src/premiere-diagnostics");

function sdk(options = {}) {
  const calls = { writes: 0, chainReads: 0, paramReads: 0, projectReads: 0 };
  const forbidden = () => { calls.writes++; throw new Error("diagnostics must never mutate"); };
  const defaultParams = [
    { name: "切り抜き（左側）", value: { value: { value: 1.1 } } },
    { name: "切り抜き（右側）", value: { value: { value: 1.5 } } },
    { name: "切り抜き（上側）", value: { value: { value: 2.5 } } },
    { name: "切り抜き（下側）", value: { value: { value: 2.5 } } },
    { name: "Zoom", value: { value: { value: false } } },
    { name: "Source Text", value: { value: { value: "secret customer text /Users/private/image.tif sk-DO_NOT_PRINT" } } }
  ];
  const params = options.params || defaultParams;
  const component = {
    getMatchName: async () => options.matchName || "ADBE Motion",
    getParamCount: () => options.paramCount === undefined ? params.length : options.paramCount,
    getParam(index) {
      calls.paramReads++;
      if (options.failParam === index) throw new Error("/Users/private/image.tif private-error-secret");
      const param = params[index % params.length];
      return {
        displayName: param.name,
        isTimeVarying: () => Boolean(param.animated),
        getStartValue: async () => {
          if (param.wait) return await param.wait;
          if (param.error) throw new Error("credential-value-do-not-print /Users/private/image.tif");
          return param.value;
        },
        createSetValueAction: forbidden
      };
    }
  };
  const chain = {
    getComponentCount: () => options.componentCount === undefined ? 1 : options.componentCount,
    getComponentAtIndex() { calls.chainReads++; return component; },
    createAppendComponentAction: forbidden,
    createRemoveComponentAction: forbidden
  };
  class VideoClipTrackItem {
    getComponentChain = async () => chain;
    getProjectItem = () => { throw new Error("must not request source media"); };
    getName = () => { throw new Error("must not collect customer clip names"); };
  }
  const tracks = options.noTracks ? [] : [new VideoClipTrackItem(), new VideoClipTrackItem()];
  const sequence = { getSelection: async () => ({ getTrackItems: async () => tracks }) };
  const project = {
    getActiveSequence: async () => options.noSequence ? null : sequence,
    executeTransaction: forbidden,
    lockedAccess: forbidden
  };
  return {
    calls,
    ppro: {
      VideoFilterFactory: {
        getMatchNames: async () => {
          if (options.factoryWait) return await options.factoryWait;
          if (options.factoryError) throw new Error("private-error-secret");
          return options.names || ["AE.ADBE Crop", "AE.ADBE Other", "PR.ADBE Crop"];
        },
        createComponent: forbidden
      },
      Project: { getActiveProject: async () => {
        calls.projectReads++;
        return options.noProject ? null : project;
      } },
      VideoClipTrackItem
    }
  };
}

test("reports available Crop identities, parameter labels and safe nested numeric values without writes", async () => {
  const f = sdk();
  const result = await collectPremiereDiagnostics(f.ppro);
  assert.match(result, /利用可能エフェクト: 3 件、Crop候補: 2 件/);
  assert.match(result, /完全一致: AE\.ADBE Crop, PR\.ADBE Crop/);
  assert.match(result, /matchName: ADBE Motion/);
  assert.match(result, /名前: 切り抜き（左側）/);
  assert.match(result, /object\{value: object\{value: number\(1\.1\)\}\}/);
  assert.match(result, /boolean\(false\)/);
  assert.match(result, /Motion内の四方向Crop名: 検出/);
  assert.doesNotMatch(result, /secret customer|\/Users\/private|sk-DO_NOT_PRINT/);
  assert.equal(f.calls.writes, 0);
  assert.equal(f.calls.chainReads, 1, "only the first selected video is inspected");
});

test("describes direct, single-wrapped, nested and array values while omitting arbitrary strings and object fields", async () => {
  const f = sdk({ params: [
    { name: "Direct", value: 4.2 },
    { name: "Wrapped", value: { value: 1.2 } },
    { name: "Position", value: { value: { value: [0.5, 0.5] } } },
    { name: "Text", value: { customerSecret: "do-not-print", value: "hidden-value" } },
    { name: "PointF", value: { x: 100, y: 200, path: "/private/source.png" } }
  ] });
  const result = await collectPremiereDiagnostics(f.ppro);
  assert.match(result, /number\(4\.2\)/);
  assert.match(result, /object\{value: number\(1\.2\)\}/);
  assert.match(result, /array（長さ 2）\[number\(0\.5\), number\(0\.5\)\]/);
  assert.match(result, /string（内容省略）/);
  assert.match(result, /object\{x: number\(100\), y: number\(200\)\}/);
  assert.doesNotMatch(result, /customerSecret|do-not-print|hidden-value|\/private\/source/);
});

test("isolates factory and parameter operation failures without leaking native error contents", async () => {
  const f = sdk({ factoryError: true, failParam: 0, params: [
    { name: "Left", value: 0 }, { name: "Right", value: { value: { value: 2 } } },
    { name: "Top", error: true }
  ] });
  const result = await collectPremiereDiagnostics(f.ppro);
  assert.match(result, /VideoFilterFactory\.getMatchNames: 取得失敗/);
  assert.match(result, /パラメータ\[0\] getParam: 取得失敗/);
  assert.match(result, /名前: Right/);
  assert.match(result, /パラメータ\[2\] getStartValue: 取得失敗/);
  assert.doesNotMatch(result, /private-error-secret|\/Users\/private|credential-value-do-not-print/);
  assert.equal(f.calls.writes, 0);
});

test("reports missing exact Crop names without dumping unrelated factory names", async () => {
  const f = sdk({ names: ["Vendor.CustomSensitiveEffect", "Custom.CropNext"] });
  const result = await collectPremiereDiagnostics(f.ppro);
  assert.match(result, /候補 matchName: Custom\.CropNext/);
  assert.match(result, /完全一致: なし/);
  assert.doesNotMatch(result, /Vendor\.CustomSensitiveEffect/);
});

test("bounds diagnostics to eight components and thirty-two parameters each", async () => {
  const f = sdk({ componentCount: 100, paramCount: 100 });
  const result = await collectPremiereDiagnostics(f.ppro);
  assert.equal(f.calls.chainReads, 8);
  assert.equal(f.calls.paramReads, 8 * 32);
  assert.match(result, /エフェクト: 100 件（最大8件/);
  assert.match(result, /パラメータ: 100 件（最大32件/);
});

test("returns readable results for unavailable SDK, project, sequence and selection", async () => {
  assert.match(await collectPremiereDiagnostics(null), /SDK: 利用できません/);
  for (const [options, pattern] of [
    [{ noProject: true }, /プロジェクト: なし/],
    [{ noSequence: true }, /シーケンス: なし/],
    [{ noTracks: true }, /診断対象のビデオクリップ: なし/]
  ]) {
    const f = sdk(options);
    assert.match(await collectPremiereDiagnostics(f.ppro), pattern);
    assert.equal(f.calls.writes, 0);
  }
});

test("unknown SDK operation shapes are reported rather than crashing or serializing objects", async () => {
  const f = sdk();
  f.ppro.VideoFilterFactory.getMatchNames = async () => ({ secret: "do-not-print" });
  delete f.ppro.Project;
  const result = await collectPremiereDiagnostics(f.ppro);
  assert.match(result, /エフェクト一覧: 想定外の返却型 object/);
  assert.match(result, /Project\.getActiveProject: 取得失敗/);
  assert.doesNotMatch(result, /do-not-print/);
});

test("a never-settling factory read times out and aborts remaining diagnostics", { timeout: 1000 }, async () => {
  const f = sdk({ factoryWait: new Promise(() => {}) });
  const snapshots = [];
  const result = await collectPremiereDiagnostics(f.ppro, {
    timeoutMs: 5, totalTimeoutMs: 100,
    onProgress: snapshot => snapshots.push(snapshot)
  });
  assert.match(result, /VideoFilterFactory\.getMatchNames: タイムアウト/);
  assert.match(result, /ここまでの結果/);
  assert.ok(snapshots.some(snapshot => /getMatchNames: 読み取り中/.test(snapshot)));
  assert.equal(snapshots.at(-1), result);
  assert.equal(f.calls.projectReads, 0);
  assert.equal(f.calls.writes, 0);
});

test("a never-settling value read preserves preceding values and aborts instead of timing out every parameter", { timeout: 1000 }, async () => {
  const f = sdk({ params: [
    { name: "Left", value: { value: { value: 1.1 } } },
    { name: "Right", wait: new Promise(() => {}) },
    { name: "Top", value: 2.5 }
  ] });
  const result = await collectPremiereDiagnostics(f.ppro, { timeoutMs: 5, totalTimeoutMs: 100 });
  assert.match(result, /number\(1\.1\)/);
  assert.match(result, /パラメータ\[1\] getStartValue: タイムアウト/);
  assert.doesNotMatch(result, /名前: Top/);
  assert.equal(f.calls.paramReads, 2);
  assert.equal(f.calls.writes, 0);
});

test("the overall deadline bounds a read even when the per-step timeout is longer", { timeout: 1000 }, async () => {
  const f = sdk({ factoryWait: new Promise(() => {}) });
  const result = await collectPremiereDiagnostics(f.ppro, { timeoutMs: 10000, totalTimeoutMs: 5 });
  assert.match(result, /getMatchNames: タイムアウト/);
  assert.equal(f.calls.projectReads, 0);
});

test("late native rejection and failing progress observers do not escape as unhandled rejections", { timeout: 1000 }, async () => {
  let rejectNative;
  const native = new Promise((resolve, reject) => { rejectNative = reject; });
  const f = sdk({ factoryWait: native });
  const unhandled = [];
  const observe = reason => unhandled.push(reason);
  process.on("unhandledRejection", observe);
  try {
    const result = await collectPremiereDiagnostics(f.ppro, {
      timeoutMs: 5, totalTimeoutMs: 100,
      onProgress: async () => { throw new Error("display observer failed"); }
    });
    assert.match(result, /タイムアウト/);
    rejectNative(new Error("late native private-error-secret"));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", observe);
  }
});

test("a synchronous progress observer exception does not hide a successful report", async () => {
  const f = sdk({ noProject: true });
  const result = await collectPremiereDiagnostics(f.ppro, {
    onProgress() { throw new Error("UI unavailable"); }
  });
  assert.match(result, /完全一致: AE\.ADBE Crop/);
  assert.match(result, /プロジェクト: なし/);
});
