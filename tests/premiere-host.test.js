"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPremiereHost } = require("../src/premiere-host");

const percentages = { left: 1.2, right: 2.3, top: 3.4, bottom: 4.5 };

function makeParam(displayName, value = 0, options = {}) {
  return {
    displayName, value,
    isTimeVarying: () => Boolean(options.animated),
    async getStartValue() {
      if (options.startValueThrows) throw options.startValueThrows;
      return { value: { value: this.value } };
    },
    createKeyframe: value => ({ value: { value } }),
    createSetValueAction(keyframe) {
      return () => {
        if (options.setFails) throw new Error("set failed");
        this.value = options.ignoreWrite ? this.value : keyframe.value.value;
      };
    }
  };
}

function makeCrop(labels = ["Left", "Right", "Top", "Bottom"], options = {}) {
  const params = labels.map((label, index) => makeParam(label, options.oldValue || 0,
    index === 0 ? options : {}));
  params.push(makeParam("Zoom", options.zoom || false));
  params.push(makeParam("Edge Feather", options.feather || 0));
  return {
    params,
    getMatchName: async () => "AE.ADBE Crop",
    getParamCount: () => params.length,
    getParam: index => params[index]
  };
}

function fixture(options = {}) {
  const components = options.existing === false ? [] : [makeCrop(options.labels, options)];
  if (options.duplicate) components.push(makeCrop());
  const calls = [];
  const state = { path: "/images/still.png", offline: false, nested: false };
  const clip = {
    isSequence: async () => state.nested,
    isOffline: async () => state.offline,
    getMediaFilePath: async () => state.path
  };
  const chain = {
    getComponentCount: () => components.length,
    getComponentAtIndex: index => components[index],
    createAppendComponentAction: pending => () => {
      assert.equal(pending.pending, true, "factory object is not an inserted Component");
      components.push(makeCrop(options.newLabels, options.newOptions));
    },
    createRemoveComponentAction: component => () => {
      if (options.rollbackFails) throw new Error("remove failed");
      const index = components.indexOf(component);
      assert.notEqual(index, -1);
      components.splice(index, 1);
    }
  };
  class VideoClipTrackItem {
    getName = async () => "still.png";
    getProjectItem = async () => clip;
    getComponentChain = async () => chain;
  }
  const trackItem = new VideoClipTrackItem();
  const sequence = {
    guid: "sequence-1",
    getSelection: async () => ({ getTrackItems: async () => options.selected || [trackItem] })
  };
  let currentSequence = sequence;
  const project = {
    guid: "project-1",
    getActiveSequence: async () => currentSequence,
    lockedAccess: callback => callback(),
    executeTransaction(callback, label) {
      calls.push(label);
      const actions = [];
      callback({ addAction: action => actions.push(action) });
      if (options.rejectSetTransaction && label === "黒枠: Crop 値を設定") return false;
      actions.forEach(action => action());
      return true;
    }
  };
  let currentProject = project;
  const ppro = {
    Project: { getActiveProject: async () => currentProject },
    VideoClipTrackItem,
    ClipProjectItem: { cast: value => value },
    VideoFilterFactory: {
      getMatchNames: async () => {
        if (options.availableThrows) throw options.availableThrows;
        return options.available || ["AE.ADBE Crop"];
      },
      createComponent: async () => ({ pending: true })
    }
  };
  return {
    host: createPremiereHost(ppro), project, sequence, state, components, calls, trackItem,
    changeSequence: () => { currentSequence = { guid: "sequence-2" }; },
    changeProject: () => { currentProject = { guid: "project-2" }; }
  };
}

async function prepared(f) {
  const context = await f.host.getSelection();
  return { context, record: { ...context.items[0], detection: { status: "ok", percentages } } };
}

test("updates a recognized existing Crop in one undoable transaction without adding another", async () => {
  const f = fixture();
  const { context, record } = await prepared(f);
  const result = await f.host.applyCrop(context, record);
  assert.equal(result.created, false);
  assert.equal(f.components.length, 1);
  assert.deepEqual(f.components[0].params.slice(0, 4).map(p => p.value), Object.values(percentages));
  assert.deepEqual(f.calls, ["黒枠: Crop 値を設定"]);
});

test("appends new Crop before reading its parameters and can be repeated without duplicates", async () => {
  const f = fixture({ existing: false });
  const { context, record } = await prepared(f);
  assert.equal((await f.host.applyCrop(context, record)).created, true);
  assert.equal((await f.host.applyCrop(context, record)).created, false);
  assert.equal(f.components.length, 1);
  assert.deepEqual(f.calls, ["黒枠: Crop を追加", "黒枠: Crop 値を設定", "黒枠: Crop 値を設定"]);
});

test("identifies Japanese side labels and uses labels rather than parameter indices", async () => {
  const f = fixture({ labels: ["切り抜き（下側）", "切り抜き (左側)", "上", "右側"] });
  const { context, record } = await prepared(f);
  await f.host.applyCrop(context, record);
  assert.deepEqual(f.components[0].params.slice(0, 4).map(p => p.value), [4.5, 1.2, 3.4, 2.3]);
});

for (const [name, options, message] of [
  ["animated crop", { animated: true }, /キーフレーム/],
  ["duplicate Crop effects", { duplicate: true }, /複数/],
  ["enabled Crop zoom", { zoom: true }, /ズーム/],
  ["nonzero feather", { feather: 5 }, /ぼかし/],
  ["unknown parameter labels", { labels: ["A", "B", "C", "D"] }, /識別/]
]) {
  test(`rejects ${name} without changing existing effects`, async () => {
    const f = fixture(options);
    const { context, record } = await prepared(f);
    await assert.rejects(f.host.applyCrop(context, record), message);
    assert.deepEqual(f.calls, []);
    assert.equal(f.components[0].params[0].value, 0);
  });
}

test("removes only the newly added Crop if its parameters cannot be identified", async () => {
  const f = fixture({ existing: false, newLabels: ["A", "B", "C", "D"] });
  const unrelated = { getMatchName: async () => "ADBE Motion" };
  f.components.push(unrelated);
  const { context, record } = await prepared(f);
  await assert.rejects(f.host.applyCrop(context, record), /識別/);
  assert.deepEqual(f.components, [unrelated]);
  assert.deepEqual(f.calls, ["黒枠: Crop を追加", "黒枠: 追加した Crop を取り消し"]);
});

test("removes newly added Crop if a write transaction fails", async () => {
  const f = fixture({ existing: false, rejectSetTransaction: true });
  const { context, record } = await prepared(f);
  await assert.rejects(f.host.applyCrop(context, record), /トランザクション/);
  assert.equal(f.components.length, 0);
});

test("readback mismatch is a failure and restores existing Crop values", async () => {
  const f = fixture({ ignoreWrite: true, oldValue: 7 });
  const { context, record } = await prepared(f);
  await assert.rejects(f.host.applyCrop(context, record), /検証/);
  assert.deepEqual(f.components[0].params.slice(0, 4).map(p => p.value), [7, 7, 7, 7]);
  assert.deepEqual(f.calls, ["黒枠: Crop 値を設定", "黒枠: Crop 値を元に戻す"]);
});

test("reports an explicit rollback failure", async () => {
  const f = fixture({ existing: false, newLabels: ["A", "B", "C", "D"], rollbackFails: true });
  const { context, record } = await prepared(f);
  await assert.rejects(f.host.applyCrop(context, record), /取り消しにも失敗.*Undo/);
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

test("rejects relinked or offline source media before making changes", async () => {
  const f = fixture();
  const { context, record } = await prepared(f);
  f.state.path = "/images/relinked.png";
  await assert.rejects(f.host.applyCrop(context, record), /元画像/);
  f.state.path = record.path;
  f.state.offline = true;
  await assert.rejects(f.host.applyCrop(context, record), /オフライン/);
  assert.deepEqual(f.calls, []);
});

test("selection returns individual errors for unsupported files, nesting and offline media", async () => {
  const f = fixture();
  f.state.path = "/videos/movie.mp4";
  assert.match((await f.host.getSelection()).items[0].error, /PNG/);
  f.state.nested = true;
  assert.match((await f.host.getSelection()).items[0].error, /ネスト/);
  f.state.nested = false;
  f.state.offline = true;
  assert.match((await f.host.getSelection()).items[0].error, /オフライン/);
});

test("accepts TIF and TIFF still-image source paths", async () => {
  const f = fixture();
  for (const extension of ["tif", "TIFF"]) {
    f.state.path = `/images/sample.${extension}`;
    const { context, record } = await prepared(f);
    assert.equal(record.error, undefined);
    assert.equal(record.path, f.state.path);
    assert.equal((await f.host.applyCrop(context, record)).status, "applied");
  }
});

test("rejects ambiguous analysis without mutating effects", async () => {
  const f = fixture();
  const { context, record } = await prepared(f);
  record.detection = { status: "ambiguous", percentages: null };
  await assert.rejects(f.host.applyCrop(context, record), /有効な解析/);
  assert.deepEqual(f.calls, []);
});

test("reports missing standard Crop rather than guessing another effect", async () => {
  const f = fixture({ existing: false, available: ["AE.ADBE Other"] });
  const { context, record } = await prepared(f);
  await assert.rejects(f.host.applyCrop(context, record), /利用できません/);
  assert.deepEqual(f.calls, []);
});

test("tags a native Crop lookup failure with its stage without mutating the timeline", async () => {
  const native = new Error("native filter catalog unavailable");
  const f = fixture({ existing: false, availableThrows: native });
  const { context, record } = await prepared(f);
  await assert.rejects(f.host.applyCrop(context, record), error => {
    assert.equal(error.stage, "crop-availability");
    assert.equal(error.cause, native);
    assert.match(error.message, /\[Crop適用: crop-availability\].*native filter catalog unavailable/);
    return true;
  });
  assert.deepEqual(f.calls, []);
  assert.equal(f.components.length, 0);
});

test("tags a native getStartValue failure during parameter inspection before any value change", async () => {
  const native = new Error("native keyframe start value read failed");
  const f = fixture({ startValueThrows: native, oldValue: 7 });
  const { context, record } = await prepared(f);
  await assert.rejects(f.host.applyCrop(context, record), error => {
    assert.equal(error.stage, "crop-parameter-inspection");
    assert.equal(error.cause, native);
    assert.match(error.message, /\[Crop適用: crop-parameter-inspection\].*native keyframe start value read failed/);
    return true;
  });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.components[0].params.slice(0, 4).map(p => p.value), [7, 7, 7, 7]);
});

test("new Crop inspection failure preserves native stage after removing the new effect", async () => {
  const native = new Error("new native keyframe read failed");
  const f = fixture({ existing: false, newOptions: { startValueThrows: native } });
  const { context, record } = await prepared(f);
  await assert.rejects(f.host.applyCrop(context, record), error => {
    assert.equal(error.stage, "crop-parameter-inspection");
    assert.equal(error.cause, native);
    assert.match(error.message, /new native keyframe read failed/);
    return true;
  });
  assert.equal(f.components.length, 0);
  assert.deepEqual(f.calls, ["黒枠: Crop を追加", "黒枠: 追加した Crop を取り消し"]);
});

test("rollback failure retains both the original native stage and rollback stage", async () => {
  const native = new Error("native inspection failure");
  const f = fixture({ existing: false, newOptions: { startValueThrows: native }, rollbackFails: true });
  const { context, record } = await prepared(f);
  await assert.rejects(f.host.applyCrop(context, record), error => {
    assert.equal(error.stage, "crop-parameter-inspection");
    assert.equal(error.cause.cause, native);
    assert.equal(error.rollbackError.stage, "rollback-remove");
    assert.match(error.message, /crop-parameter-inspection.*native inspection failure/);
    assert.match(error.message, /取り消しにも失敗.*rollback-remove.*remove failed.*Undo/);
    return true;
  });
  assert.equal(f.components.length, 1);
});

test("tags chain-enumeration and selection-context prerequisite failures without writes", async () => {
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
    assert.equal(error.stage, "selection-context");
    assert.match(error.message, /シーケンスが変更/);
    return true;
  });
  assert.deepEqual(f.calls, []);
});
