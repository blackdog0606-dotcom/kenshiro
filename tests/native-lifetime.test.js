"use strict";

// Model expiring native parameter/action wrappers. This is a regression for
// retaining SDK objects across reads and transaction boundaries, not a claim
// that a Linux mock reproduces every Premiere native lifetime rule.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPremiereHost } = require("../src/premiere-host");

const percentages = { left: 1.5, right: 1.4, top: 1.9, bottom: 2.1 };
const expectedMotion = [1.5, 1.9, 1.4, 2.1];
const invalidObject = () => new Error("The script object is no longer valid.");

function fixture(options = {}) {
  let generation = 0;
  let locked = false;
  let transaction = false;
  let transactionNumber = 0;
  let failCreation = Boolean(options.failCreation);
  let ignoredLegacy = false;
  const transactions = [];
  const actionBuilds = [];
  const writes = [];
  const geometry = [
    ["位置", [0.5, 0.5]], ["スケール", 63.24876403808594],
    ["スケール (幅)", 63.24876403808594], [" ", true], ["回転", 0],
    ["アンカーポイント", [0.5, 0.5]], ["アンチフリッカー", 0]
  ].map(([name, value]) => ({ name, value, protected: true }));
  const motionCrop = ["切り抜き (左端)", "切り抜き (上端)", "切り抜き (右端)", "切り抜き (下端)"]
    .map((name, index) => ({ name, value: options.motionBefore ? options.motionBefore[index] : 0 }));
  const legacyCrop = ["左", "上", "右", "下"]
    .map((name, index) => ({ name, value: Math.fround([1.5, 1.9, 1.4, 2.1][index]) }));
  const legacyAux = [{ name: " ", value: false, protected: true },
    { name: "エッジをぼかす", value: 0, protected: true }];
  const beforeGeometry = structuredClone(geometry.map(param => param.value));
  const beforeMotion = motionCrop.map(param => param.value);
  const beforeLegacy = legacyCrop.map(param => param.value);

  const sdkRead = value => {
    if (options.expireOnReads !== false) generation++;
    return Promise.resolve(value);
  };

  function effect(matchName, effectId, values) {
    return {
      getMatchName: () => sdkRead(matchName),
      getParamCount: () => values.length,
      getParam(index) {
        const state = values[index];
        if (!state) throw new RangeError("Missing native parameter");
        const acquired = generation;
        function assertCurrent() {
          if (acquired !== generation) throw invalidObject();
        }
        return {
          get displayName() { assertCurrent(); return state.name; },
          isTimeVarying() { assertCurrent(); return false; },
          getStartValue() {
            assertCurrent();
            return sdkRead({ value: { value: structuredClone(state.value) } });
          },
          createKeyframe(value) {
            assertCurrent();
            if (!locked || !transaction) throw invalidObject();
            return { acquired, value };
          },
          createSetValueAction(keyframe) {
            assertCurrent();
            if (!locked || !transaction || keyframe.acquired !== generation) throw invalidObject();
            assert.equal(state.protected, undefined, "geometry and legacy auxiliary parameters must not be written");
            if (failCreation && effectId === "legacy" && index === 3) {
              failCreation = false;
              throw new Error("native final action creation failed");
            }
            actionBuilds.push({ effectId, index, transactionNumber });
            return { acquired, apply() {
              if (!locked || !transaction || acquired !== generation) throw invalidObject();
              if (options.ignoreLegacyOnce && effectId === "legacy" && index === 0 && !ignoredLegacy) {
                ignoredLegacy = true;
                return;
              }
              writes.push({ effectId, index, value: keyframe.value, transactionNumber });
              state.value = Math.fround(keyframe.value);
            } };
          }
        };
      }
    };
  }

  const effects = [effect("AE.ADBE Opacity", "opacity", [{ name: "不透明度", value: 100, protected: true }]),
    effect("AE.ADBE Motion", "motion", [...geometry, ...motionCrop])];
  if (options.legacy !== false) effects.push(effect("AE.ADBE AECrop", "legacy", [...legacyCrop, ...legacyAux]));
  const chain = {
    getComponentCount: () => effects.length,
    getComponentAtIndex: index => effects[index],
    createAppendComponentAction() { throw new Error("No effect may be appended"); },
    createRemoveComponentAction() { throw new Error("No effect may be removed"); }
  };
  const clip = { isSequence: () => sdkRead(false), isOffline: () => sdkRead(false),
    getMediaFilePath: () => sdkRead("/images/still.tif") };
  class VideoClipTrackItem {
    getName = () => sdkRead("still.tif");
    getProjectItem = () => sdkRead(clip);
    getComponentChain = () => sdkRead(chain);
  }
  const trackItem = new VideoClipTrackItem();
  const sequence = { guid: "sequence", getSelection: () => sdkRead({ getTrackItems: () => sdkRead([trackItem]) }) };
  const project = {
    guid: "project", getActiveSequence: () => sdkRead(sequence),
    lockedAccess(callback) {
      generation++;
      locked = true;
      try { return callback(); }
      finally { locked = false; generation++; }
    },
    executeTransaction(callback, label) {
      assert.equal(locked, true);
      generation++;
      transaction = true;
      transactionNumber++;
      const actions = [];
      const record = { label, actions, builtAtFirstAdd: null };
      transactions.push(record);
      try {
        const returned = callback({ addAction(action) {
          assert.equal(action.acquired, generation, "actions cannot escape their creation transaction");
          if (record.builtAtFirstAdd === null) record.builtAtFirstAdd = actionBuilds.length;
          actions.push(action);
        } });
        assert.equal(returned instanceof Promise, false);
        for (let index = 0; index < actions.length; index++) {
          actions[index].apply();
          if (options.failAfterWrites === index + 1 && transactionNumber === 1) {
            throw new Error("native transaction failed after partial application");
          }
        }
        return true;
      } finally { transaction = false; generation++; }
    }
  };
  const host = createPremiereHost({ Project: { getActiveProject: () => sdkRead(project) }, VideoClipTrackItem,
    ClipProjectItem: { cast: value => value },
    VideoFilterFactory: { createComponent() { throw new Error("No factory fallback allowed"); } } });

  return { host, motionCrop, legacyCrop, geometry, beforeMotion, beforeLegacy, beforeGeometry,
    transactions, writes, actionBuilds };
}

async function apply(f) {
  const context = await f.host.getSelection();
  return f.host.applyCrop(context, { ...context.items[0], detection: { status: "ok", percentages } });
}

function assertOriginal(f) {
  assert.deepEqual(f.motionCrop.map(param => param.value), f.beforeMotion);
  assert.deepEqual(f.legacyCrop.map(param => param.value), f.beforeLegacy);
  assert.deepEqual(f.geometry.map(param => param.value), f.beforeGeometry);
}

test("expiring parameter and action wrappers are reacquired for intrinsic Motion and legacy Crop writes", async () => {
  const f = fixture();
  const result = await apply(f);
  assert.equal(result.status, "applied");
  f.motionCrop.forEach((param, index) => assert.ok(Math.abs(param.value - expectedMotion[index]) < 0.0001));
  assert.deepEqual(f.legacyCrop.map(param => param.value), [0, 0, 0, 0]);
  assert.deepEqual(f.geometry.map(param => param.value), f.beforeGeometry);
  assert.equal(f.transactions.length, 1);
  assert.equal(f.transactions[0].actions.length, 8);
  assert.equal(f.transactions[0].builtAtFirstAdd, 8, "all native actions are constructed before the compound is populated");
});

test("action-only lifetime protection requires construction inside the current native transaction", async () => {
  const f = fixture({ expireOnReads: false });
  await apply(f);
  assert.equal(f.transactions.length, 1);
  assert.equal(f.transactions[0].actions.length, 8);
  f.motionCrop.forEach((param, index) => assert.ok(Math.abs(param.value - expectedMotion[index]) < 0.0001));
  assert.deepEqual(f.legacyCrop.map(param => param.value), [0, 0, 0, 0]);
  assert.deepEqual(f.geometry.map(param => param.value), f.beforeGeometry);
});

test("Motion-only application uses current transaction-scoped handles without adding an effect", async () => {
  const f = fixture({ legacy: false });
  await apply(f);
  assert.equal(f.transactions.length, 1);
  assert.equal(f.transactions[0].actions.length, 4);
  f.motionCrop.forEach((param, index) => assert.ok(Math.abs(param.value - expectedMotion[index]) < 0.0001));
  assert.deepEqual(f.geometry.map(param => param.value), f.beforeGeometry);
});

test("partial native application restores both groups using newly acquired rollback handles", async () => {
  const f = fixture({ motionBefore: [5, 6, 7, 8], failAfterWrites: 5 });
  await assert.rejects(apply(f), /native transaction failed after partial application/);
  assert.equal(f.transactions.length, 2);
  assert.equal(f.transactions[1].actions.length, 8);
  assertOriginal(f);
});

test("a legacy-only readback mismatch restores Motion and Crop through fresh native wrappers", async () => {
  const f = fixture({ motionBefore: [5, 6, 7, 8], ignoreLegacyOnce: true });
  await assert.rejects(apply(f), /検証/);
  assert.equal(f.transactions.length, 2);
  assertOriginal(f);
});

test("last action construction failure cannot populate the compound or write partial values", async () => {
  const f = fixture({ motionBefore: [5, 6, 7, 8], failCreation: true });
  await assert.rejects(apply(f), /native final action creation failed/);
  assert.equal(f.transactions[0].actions.length, 0);
  assert.equal(f.writes.length, 0);
  assertOriginal(f);
});
