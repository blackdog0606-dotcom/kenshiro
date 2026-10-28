"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPremiereHost } = require("../src/premiere-host");

const percentages = { left: 1.2, right: 2.3, top: 3.4, bottom: 4.5 };
const nativeOrderValues = [1.2, 3.4, 2.3, 4.5];
const SET_LABEL = "黒枠: モーションの切り抜きを設定";

function makeParam(displayName, initial = 0, options = {}) {
  let writes = 0;
  return {
    displayName, value: structuredClone(initial),
    isTimeVarying: () => Boolean(options.animated),
    async getStartValue() {
      if (options.startValueThrows) throw options.startValueThrows;
      return { value: { value: this.value } };
    },
    createKeyframe(value) {
      if (options.failKeyframe) throw new Error("native keyframe construction failed");
      return { value: { value } };
    },
    createSetValueAction(keyframe) {
      if (options.protected) throw new Error(`Unrelated Motion write: ${displayName}`);
      if (options.failCreate) throw new Error("native value action construction failed");
      return () => {
        writes++;
        if (options.failFirst && writes === 1) throw new Error("native parameter write failed");
        if (options.ignoreFirst && writes === 1) return;
        if (options.corruptRestore && writes > 1) { this.value = keyframe.value.value + 1; return; }
        this.value = options.float32 ? Math.fround(keyframe.value.value) : keyframe.value.value;
      };
    }
  };
}

function component(matchName, params) {
  return { params, getMatchName: async () => matchName,
    getParamCount: () => params.length, getParam: index => params[index] };
}

function makeMotion(options = {}) {
  const geometry = [
    ["位置", [0.5, 0.5]], ["スケール", 54.49825668334961],
    ["スケール (幅)", 54.49825668334961], [" ", true], ["回転", 0],
    ["アンカーポイント", [0.5, 0.5]], ["アンチフリッカー", 0]
  ].map(([label, value]) => makeParam(label, value, { protected: true }));
  const labels = options.labels || ["切り抜き (左端)", "切り抜き (上端)", "切り抜き (右端)", "切り抜き (下端)"];
  const cropParams = labels.map((label, index) => makeParam(label,
    options.oldValues ? options.oldValues[index] : 0, index === 0 ? options : { float32: options.float32 }));
  return Object.assign(component(options.matchName || "AE.ADBE Motion", [...geometry, ...cropParams]),
    { geometry, cropParams });
}

function makeLegacy(options = {}) {
  const labels = options.labels || ["Left", "Top", "Right", "Bottom"];
  const cropParams = labels.map((label, index) => makeParam(label,
    options.oldValues ? options.oldValues[index] : 7,
    index === 0 ? options : index === 3 ? options.lastParamOptions || {} : {}));
  const zoom = makeParam(options.native ? " " : "Zoom", options.zoom || false, { animated: options.zoomAnimated });
  const feather = makeParam(options.native ? "エッジをぼかす" : "Edge Feather", options.feather || 0,
    { animated: options.featherAnimated });
  const params = [...cropParams, zoom, feather];
  if (options.extra) params.push(makeParam("Unknown modifier", 12));
  return Object.assign(component(options.matchName || "AE.ADBE AECrop", params), { cropParams, zoom, feather });
}

function fixture(options = {}) {
  const motion = options.motion === false ? null : makeMotion(options.motionOptions);
  const legacy = options.legacy ? makeLegacy(options.legacyOptions) : null;
  const components = [component("AE.ADBE Opacity", [makeParam("不透明度", 100, { protected: true })])];
  if (motion) components.push(motion);
  if (legacy) components.push(legacy);
  if (options.duplicateMotion) components.push(makeMotion());
  if (options.duplicateLegacy) components.push(makeLegacy());
  if (options.thirdParty) components.push(component("AE.Impact_Crop_FX", [makeParam("Left", 14, { protected: true })]));
  const beforeGeometry = motion ? structuredClone(motion.geometry.map(param => param.value)) : null;
  const calls = [];
  const actionCounts = [];
  const factoryCalls = [];
  const state = { path: "/images/still.tif", offline: false, nested: false };
  const clip = { isSequence: async () => state.nested,
    isOffline: async () => state.offline, getMediaFilePath: async () => state.path };
  const chain = {
    getComponentCount: () => components.length, getComponentAtIndex: index => components[index],
    createAppendComponentAction: () => { throw new Error("Must not add an effect"); },
    createRemoveComponentAction: () => { throw new Error("Must not remove an effect"); }
  };
  class VideoClipTrackItem {
    getName = async () => "still.tif";
    getProjectItem = async () => clip;
    getComponentChain = async () => chain;
  }
  const trackItem = new VideoClipTrackItem();
  const sequence = { guid: "sequence-1",
    getSelection: async () => ({ getTrackItems: async () => options.selected || [trackItem] }) };
  let currentSequence = sequence;
  let locked = false;
  const project = {
    guid: "project-1", getActiveSequence: async () => currentSequence,
    lockedAccess(callback) {
      locked = true;
      try { return callback(); } finally { locked = false; }
    },
    executeTransaction(callback, label) {
      assert.equal(locked, true, "native mutation must hold lockedAccess");
      calls.push(label);
      const actions = [];
      const transactionIndex = actionCounts.push(0) - 1;
      const returned = callback({ addAction: action => {
        actions.push(action);
        actionCounts[transactionIndex]++;
      } });
      assert.equal(returned instanceof Promise, false, "transaction callback must be synchronous");
      if (options.rejectSetTransaction && calls.length === 1) return false;
      if (options.rollbackFails && calls.length > 1) throw new Error("native rollback transaction failed");
      for (let index = 0; index < actions.length; index++) {
        actions[index]();
        if (options.failAfterActions === index + 1 && calls.length === 1) {
          throw new Error("native partial transaction failure");
        }
      }
      return true;
    }
  };
  let currentProject = project;
  const ppro = {
    Project: { getActiveProject: async () => currentProject }, VideoClipTrackItem,
    ClipProjectItem: { cast: value => value },
    VideoFilterFactory: {
      getMatchNames: async () => { factoryCalls.push("catalog"); throw new Error("Factory catalog must not be read"); },
      createComponent: async () => { factoryCalls.push("create"); throw new Error("Factory must not be used"); }
    }
  };
  return { host: createPremiereHost(ppro), project, sequence, motion, legacy, beforeGeometry,
    state, components, calls, actionCounts, factoryCalls, trackItem,
    changeSequence: () => { currentSequence = { guid: "sequence-2" }; },
    changeProject: () => { currentProject = { guid: "project-2" }; } };
}

async function prepared(f) {
  const context = await f.host.getSelection();
  return { context, record: { ...context.items[0], detection: { status: "ok", percentages } } };
}

function assertGeometryUnchanged(f) {
  assert.deepEqual(f.motion.geometry.map(param => param.value), f.beforeGeometry);
}

async function apply(f) {
  const { context, record } = await prepared(f);
  return f.host.applyCrop(context, record);
}

test("writes native Motion's four Japanese crop fields in one transaction and keeps geometry unchanged", async () => {
  const f = fixture();
  const componentsBefore = [...f.components];
  const result = await apply(f);
  assert.equal(result.status, "applied");
  assert.equal(result.target, "motion-crop");
  assert.equal(result.created, false);
  assert.equal(result.legacyCropCleared, false);
  assert.deepEqual(result.percentages, percentages);
  assert.deepEqual(f.motion.cropParams.map(param => param.value), nativeOrderValues);
  assertGeometryUnchanged(f);
  assert.deepEqual(f.components, componentsBefore);
  assert.deepEqual(f.calls, [SET_LABEL]);
  assert.deepEqual(f.actionCounts, [4]);
  assert.deepEqual(f.factoryCalls, []);
});

test("identifies shuffled qualified English crop names rather than Motion parameter indices", async () => {
  const f = fixture({ motionOptions: { labels: ["Crop Bottom", "Crop Left", "Crop Top", "Crop Right"] } });
  await apply(f);
  assert.deepEqual(f.motion.cropParams.map(param => param.value), [4.5, 1.2, 3.4, 2.3]);
  assertGeometryUnchanged(f);
});

test("repeated application changes only intrinsic crop and never creates another effect", async () => {
  const f = fixture();
  const count = f.components.length;
  await apply(f);
  await apply(f);
  assert.equal(f.components.length, count);
  assert.deepEqual(f.factoryCalls, []);
  assert.deepEqual(f.motion.cropParams.map(param => param.value), nativeOrderValues);
  assertGeometryUnchanged(f);
});

test("accepts the known legacy Motion match name without looking up an effect factory", async () => {
  const f = fixture({ motionOptions: { matchName: "ADBE Motion" } });
  await apply(f);
  assert.deepEqual(f.motion.cropParams.map(param => param.value), nativeOrderValues);
  assert.deepEqual(f.factoryCalls, []);
});

test("sets analyzed values in Motion and zeros legacy Crop in the same transaction", async () => {
  const f = fixture({ legacy: true, legacyOptions: { oldValues: [10.3, 12.6, 10.5, 9.1] } });
  const result = await apply(f);
  assert.equal(result.legacyCropCleared, true);
  assert.deepEqual(f.motion.cropParams.map(param => param.value), nativeOrderValues);
  assert.deepEqual(f.legacy.cropParams.map(param => param.value), [0, 0, 0, 0]);
  assert.equal(f.legacy.zoom.value, false);
  assert.equal(f.legacy.feather.value, 0);
  assert.equal(f.components.length, 3, "legacy effect is retained without removing any component");
  assert.deepEqual(f.calls, [SET_LABEL]);
  assert.deepEqual(f.actionCounts, [8]);
  assertGeometryUnchanged(f);
});

test("supports the observed native six-parameter AECrop schema with blank Zoom name", async () => {
  const f = fixture({ legacy: true,
    legacyOptions: { native: true, labels: ["左", "上", "右", "下"] } });
  await apply(f);
  assert.deepEqual(f.legacy.cropParams.map(param => param.value), [0, 0, 0, 0]);
  assert.deepEqual(f.motion.cropParams.map(param => param.value), nativeOrderValues);
  assertGeometryUnchanged(f);
});

test("native float32 readback is accepted without changing requested 0.1-percent values", async () => {
  const f = fixture({ motionOptions: { float32: true } });
  await apply(f);
  f.motion.cropParams.forEach((param, index) => assert.ok(Math.abs(param.value - nativeOrderValues[index]) < 0.0001));
  assertGeometryUnchanged(f);
});

for (const [name, options, expectedStage] of [
  ["missing Motion", { motion: false }, "motion-availability"],
  ["duplicate Motion", { duplicateMotion: true }, "motion-availability"],
  ["unknown Motion match name", { motionOptions: { matchName: "ThirdParty.Motion" } }, "motion-availability"],
  ["generic side labels inside Motion", { motionOptions: { labels: ["Left", "Top", "Right", "Bottom"] } }, "motion-parameter-inspection"],
  ["missing intrinsic crop side", { motionOptions: { labels: ["Crop Left", "Crop Top", "Crop Right", "Other"] } }, "motion-parameter-inspection"],
  ["duplicate intrinsic crop side", { motionOptions: { labels: ["Crop Left", "Crop Top", "Crop Right", "Crop Right"] } }, "motion-parameter-inspection"],
  ["animated intrinsic crop", { motionOptions: { animated: true } }, "motion-parameter-inspection"],
  ["nonnumeric intrinsic crop", { motionOptions: { oldValues: [false, 0, 0, 0] } }, "motion-parameter-inspection"],
  ["duplicate legacy Crop", { legacy: true, duplicateLegacy: true }, "legacy-crop-inspection"],
  ["animated legacy Crop", { legacy: true, legacyOptions: { animated: true } }, "legacy-crop-inspection"],
  ["legacy Crop zoom", { legacy: true, legacyOptions: { zoom: true } }, "legacy-crop-inspection"],
  ["animated legacy zoom", { legacy: true, legacyOptions: { zoomAnimated: true } }, "legacy-crop-inspection"],
  ["native blank-name Crop zoom", { legacy: true, legacyOptions: { native: true, labels: ["左", "上", "右", "下"], zoom: true } }, "legacy-crop-inspection"],
  ["legacy Crop feather", { legacy: true, legacyOptions: { feather: 5 } }, "legacy-crop-inspection"],
  ["animated legacy feather", { legacy: true, legacyOptions: { featherAnimated: true } }, "legacy-crop-inspection"],
  ["unknown legacy modifier", { legacy: true, legacyOptions: { extra: true } }, "legacy-crop-inspection"],
  ["unverified blank-name Zoom schema", { legacy: true, legacyOptions: { native: true, matchName: "AE.ADBE Crop" } }, "legacy-crop-inspection"]
]) {
  test(`rejects ${name} before modifying any values`, async () => {
    const f = fixture(options);
    const before = f.components.map(effect => effect.params.map(param => structuredClone(param.value)));
    await assert.rejects(apply(f), error => { assert.equal(error.stage, expectedStage); return true; });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.components.map(effect => effect.params.map(param => param.value)), before);
    assert.deepEqual(f.factoryCalls, []);
  });
}

test("does not modify a third-party Crop effect", async () => {
  const f = fixture({ thirdParty: true });
  await apply(f);
  assert.equal(f.components.at(-1).params[0].value, 14);
  assert.deepEqual(f.motion.cropParams.map(param => param.value), nativeOrderValues);
});

test("partial value-transaction failure restores Motion and legacy Crop snapshots", async () => {
  const f = fixture({ legacy: true, motionOptions: { oldValues: [1, 2, 3, 4] }, failAfterActions: 5 });
  await assert.rejects(apply(f), error => {
    assert.equal(error.stage, "value-transaction");
    assert.match(error.message, /native partial transaction failure/);
    return true;
  });
  assert.deepEqual(f.motion.cropParams.map(param => param.value), [1, 2, 3, 4]);
  assert.deepEqual(f.legacy.cropParams.map(param => param.value), [7, 7, 7, 7]);
  assert.equal(f.calls.length, 2);
  assertGeometryUnchanged(f);
});

test("readback mismatch restores both old intrinsic crop and legacy effect values", async () => {
  const f = fixture({ legacy: true, motionOptions: { oldValues: [2, 3, 4, 5], ignoreFirst: true } });
  await assert.rejects(apply(f), error => { assert.equal(error.stage, "readback"); return true; });
  assert.deepEqual(f.motion.cropParams.map(param => param.value), [2, 3, 4, 5]);
  assert.deepEqual(f.legacy.cropParams.map(param => param.value), [7, 7, 7, 7]);
  assertGeometryUnchanged(f);
});

test("legacy Crop zeroing is read back and a failed legacy write restores both snapshots", async () => {
  const f = fixture({ legacy: true, legacyOptions: { ignoreFirst: true },
    motionOptions: { oldValues: [2, 3, 4, 5] } });
  await assert.rejects(apply(f), error => { assert.equal(error.stage, "readback"); return true; });
  assert.deepEqual(f.motion.cropParams.map(param => param.value), [2, 3, 4, 5]);
  assert.deepEqual(f.legacy.cropParams.map(param => param.value), [7, 7, 7, 7]);
  assertGeometryUnchanged(f);
});

for (const lastParamOptions of [{ failCreate: true }, { failKeyframe: true }]) {
  const failureType = lastParamOptions.failCreate ? "value action" : "keyframe";
  const expectedStage = lastParamOptions.failCreate ? "value-action" : "value-keyframe";
  const expectedOperation = lastParamOptions.failCreate ? "createSetValueAction" : "createKeyframe";
  test(`last planned legacy ${failureType} construction failure queues no actions and changes no values`, async () => {
    const f = fixture({ legacy: true, legacyOptions: { lastParamOptions },
      motionOptions: { oldValues: [2, 3, 4, 5] } });
    await assert.rejects(apply(f), error => {
      assert.equal(error.stage, expectedStage);
      assert.match(error.message, /native .* construction failed/);
      assert.ok(error.message.includes(`bottom: ${expectedOperation}`), "failure identifies the actual last write and native operation");
      assert.match(error.cause.message, /native .* construction failed/);
      return true;
    });
    assert.deepEqual(f.calls, [SET_LABEL], "transaction callback entered once, with no rollback needed");
    assert.deepEqual(f.actionCounts, [0], "all native actions must be constructed before any are queued");
    assert.deepEqual(f.motion.cropParams.map(param => param.value), [2, 3, 4, 5]);
    assert.deepEqual(f.legacy.cropParams.map(param => param.value), [7, 7, 7, 7]);
    assertGeometryUnchanged(f);
  });
}

test("failed native transaction leaves the original crop values intact", async () => {
  const f = fixture({ motionOptions: { oldValues: [2, 3, 4, 5] }, rejectSetTransaction: true });
  await assert.rejects(apply(f), /トランザクション/);
  assert.deepEqual(f.motion.cropParams.map(param => param.value), [2, 3, 4, 5]);
  assertGeometryUnchanged(f);
});

test("rollback failure retains original stage and rollback cause for diagnosis", async () => {
  const f = fixture({ motionOptions: { ignoreFirst: true, oldValues: [7, 7, 7, 7] }, rollbackFails: true });
  await assert.rejects(apply(f), error => {
    assert.equal(error.stage, "readback");
    assert.equal(error.rollbackError.stage, "rollback-values");
    assert.match(error.message, /Undo|取り消し/);
    assert.match(error.rollbackError.message, /native rollback transaction failed/);
    return true;
  });
  assertGeometryUnchanged(f);
});

test("rollback numeric readback failure preserves its verification stage and original cause", async () => {
  const f = fixture({ motionOptions: { ignoreFirst: true, corruptRestore: true, oldValues: [7, 7, 7, 7] } });
  await assert.rejects(apply(f), error => {
    assert.equal(error.stage, "readback");
    assert.equal(error.rollbackError.stage, "rollback-values-readback");
    assert.match(error.message, /取り消しにも失敗/);
    return true;
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.motion.cropParams[0].value, 8, "fixture simulates a host that failed to restore the value");
  assertGeometryUnchanged(f);
});

test("native inspection failure retains its cause and never starts a transaction", async () => {
  const native = new Error("native keyframe start value read failed");
  const f = fixture({ motionOptions: { startValueThrows: native } });
  await assert.rejects(apply(f), error => {
    assert.equal(error.stage, "motion-parameter-inspection");
    assert.equal(error.cause, native);
    return true;
  });
  assert.deepEqual(f.calls, []);
});

for (const action of ["changeSequence", "changeProject"]) {
  test(`rejects stale active context: ${action}`, async () => {
    const f = fixture();
    const { context, record } = await prepared(f);
    f[action]();
    await assert.rejects(f.host.applyCrop(context, record), /変更/);
    assert.deepEqual(f.calls, []);
  });
}

test("rejects relinked or offline source media before writing crop values", async () => {
  const f = fixture();
  const { context, record } = await prepared(f);
  f.state.path = "/images/relinked.png";
  await assert.rejects(f.host.applyCrop(context, record), /元画像/);
  f.state.path = record.path;
  f.state.offline = true;
  await assert.rejects(f.host.applyCrop(context, record), /オフライン/);
  assert.deepEqual(f.calls, []);
});

test("selection reports unsupported, nested, offline and non-video clips individually", async () => {
  const f = fixture();
  f.state.path = "/videos/movie.mp4";
  assert.match((await f.host.getSelection()).items[0].error, /PNG/);
  f.state.nested = true;
  assert.match((await f.host.getSelection()).items[0].error, /ネスト/);
  f.state.nested = false;
  f.state.offline = true;
  assert.match((await f.host.getSelection()).items[0].error, /オフライン/);
  const audio = fixture({ selected: [{ getName: async () => "audio" }] });
  assert.match((await audio.host.getSelection()).items[0].error, /ビデオ/);
});

test("accepts TIF and TIFF still source paths and writes their intrinsic crop", async () => {
  const f = fixture();
  for (const extension of ["tif", "TIFF"]) {
    f.state.path = `/images/sample.${extension}`;
    const { context, record } = await prepared(f);
    assert.equal(record.error, undefined);
    assert.equal(record.path, f.state.path);
    assert.equal((await f.host.applyCrop(context, record)).status, "applied");
  }
});

test("rejects ambiguous or destructive analysis before any native changes", async () => {
  const f = fixture();
  const { context, record } = await prepared(f);
  for (const detection of [
    { status: "ambiguous", percentages: null },
    { status: "ok", percentages: { ...percentages, left: 99, right: 2 } },
    { status: "ok", percentages: { ...percentages, top: NaN } }
  ]) {
    record.detection = detection;
    await assert.rejects(f.host.applyCrop(context, record), error => {
      assert.equal(error.stage, "analysis-validation"); return true;
    });
  }
  assert.deepEqual(f.calls, []);
});

test("tags unavailable chain and stale context prerequisite failures without writes", async () => {
  const f = fixture();
  const { context, record } = await prepared(f);
  const native = new Error("native component chain unavailable");
  f.trackItem.getComponentChain = async () => { throw native; };
  await assert.rejects(f.host.applyCrop(context, record), error => {
    assert.equal(error.stage, "chain-enumeration");
    assert.equal(error.cause, native);
    return true;
  });
  f.changeSequence();
  await assert.rejects(f.host.applyCrop(context, record), error => {
    assert.equal(error.stage, "selection-context"); return true;
  });
  assert.deepEqual(f.calls, []);
});
