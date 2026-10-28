"use strict";

const CROP_MATCH_NAMES = ["AE.ADBE AECrop", "AE.ADBE Crop", "PR.ADBE Crop", "ADBE Crop"];
const MOTION_MATCH_NAMES = ["AE.ADBE Motion", "ADBE Motion", "PR.ADBE Motion"];
const SIDES = ["left", "right", "top", "bottom"];
const ZOOM_NAMES = ["zoom", "ズーム"];
const FEATHER_NAMES = ["edgefeather", "エッジのぼかし", "境界のぼかし", "エッジの境界ぼかし", "エッジをぼかす"];

function normalizeName(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s()（）:：・_\-]/g, "");
}

const SIDE_NAMES = {
  left: ["left", "左", "左側", "左端"],
  right: ["right", "右", "右側", "右端"],
  top: ["top", "上", "上側", "上端"],
  bottom: ["bottom", "下", "下側", "下端"]
};

function sideForName(name, qualified = false) {
  const normalized = normalizeName(name);
  return SIDES.find(side => SIDE_NAMES[side].some(label =>
    (!qualified && normalized === label) || normalized === `crop${label}` ||
    normalized === `切り抜き${label}` || normalized === `クロップ${label}`
  ));
}

function guidOf(value) {
  if (!value || !value.guid) return null;
  const guid = String(value.guid);
  return guid && guid !== "[object Object]" ? guid : null;
}

function sameEntity(current, original, originalGuid) {
  if (!current || !original) return false;
  const currentGuid = guidOf(current);
  return originalGuid && currentGuid ? originalGuid === currentGuid : current === original;
}

async function numericValue(param) {
  const name = param.displayName;
  const keyframe = await param.getStartValue();
  const value = keyframe && keyframe.value && keyframe.value.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`切り抜きの「${name}」の数値を取得できません。`);
  }
  return value;
}

function transact(project, label, build) {
  let success = false;
  let buildError;
  try {
    project.lockedAccess(() => {
      success = project.executeTransaction(compound => {
        try { return build(compound); }
        catch (error) { buildError = error; throw error; }
      }, label);
    });
  } catch (error) {
    throw buildError || error;
  }
  if (buildError) throw buildError;
  if (!success) throw new Error(`${label} のトランザクションに失敗しました。`);
}

async function findTargets(chain) {
  const motions = [];
  const crops = [];
  const count = chain.getComponentCount();
  for (let i = 0; i < count; i++) {
    const component = chain.getComponentAtIndex(i);
    const matchName = await component.getMatchName();
    if (MOTION_MATCH_NAMES.includes(matchName) || CROP_MATCH_NAMES.includes(matchName)) {
      const target = { componentIndex: i, componentCount: count, paramCount: component.getParamCount(), matchName };
      if (MOTION_MATCH_NAMES.includes(matchName)) motions.push(target);
      else crops.push(target);
    }
  }
  return { motions, crops };
}

function resolveParam(chain, target, paramIndex, expectedName) {
  if (chain.getComponentCount() !== target.componentCount) throw new Error("エフェクト構成が変わりました。再解析してください。");
  const component = chain.getComponentAtIndex(target.componentIndex);
  if (!component || component.getParamCount() !== target.paramCount) {
    throw new Error("切り抜きの項目構成が変わりました。再解析してください。");
  }
  const param = component.getParam(paramIndex);
  if (!param || (expectedName !== undefined && normalizeName(param.displayName) !== normalizeName(expectedName))) {
    throw new Error("切り抜きの項目名が変わりました。再解析してください。");
  }
  return { component, param };
}

async function inspectSides(chain, target, label, qualified = false) {
  const params = {};
  const names = [];
  for (let paramIndex = 0; paramIndex < target.paramCount; paramIndex++) {
    // Each asynchronous read gets a fresh wrapper. Only plain descriptors and
    // numeric snapshots survive into later reads or the mutation transaction.
    const { param } = resolveParam(chain, target, paramIndex);
    const name = param.displayName;
    names.push(name);
    const side = sideForName(name, qualified);
    if (side) {
      if (params[side]) throw new Error(`${label} の ${side} パラメータが重複しています。`);
      if (param.isTimeVarying()) throw new Error(`${label} にキーフレームがあります。対象の静止画をスキップしました。`);
      params[side] = { paramIndex, name, value: await numericValue(param) };
    }
  }
  if (SIDES.some(side => !params[side])) {
    throw new Error(`${label} の四方向の切り抜きを識別できません。この版はモーション内の切り抜き4項目が必要です。`);
  }
  return { params, names };
}

async function inspectLegacyCrop(chain, target) {
  const { params, names } = await inspectSides(chain, target, "既存Crop");
  // The user supplied this exact six-parameter native schema. An unnamed
  // Boolean in an arbitrary effect must never be guessed to mean Zoom.
  const nativeSixParam = target.matchName === "AE.ADBE AECrop" && names.length === 6 &&
    ["left", "top", "right", "bottom"].every((side, index) => sideForName(names[index]) === side) &&
    normalizeName(names[4]) === "" && FEATHER_NAMES.includes(normalizeName(names[5]));
  for (let paramIndex = 0; paramIndex < names.length; paramIndex++) {
    if (sideForName(names[paramIndex])) continue;
    const { param } = resolveParam(chain, target, paramIndex, names[paramIndex]);
    const name = normalizeName(names[paramIndex]);
    if (ZOOM_NAMES.includes(name) || (nativeSixParam && paramIndex === 4)) {
      if (param.isTimeVarying()) throw new Error("既存Cropのズームにキーフレームがあります。");
      const keyframe = await param.getStartValue();
      const value = keyframe && keyframe.value && keyframe.value.value;
      if (value !== false && value !== 0) throw new Error("既存Cropのズームをオフにしてから再実行してください。");
    } else if (FEATHER_NAMES.includes(name)) {
      if (param.isTimeVarying() || await numericValue(param) !== 0) {
        throw new Error("既存Cropの境界のぼかしを0にしてから再実行してください。");
      }
    } else {
      throw new Error("既存Cropの構成を識別できません。既存Cropを確認してから再実行してください。");
    }
  }
  return params;
}

function valueActions(chain, writes, restore, step) {
  return writes.map(write => {
    const { target, paramIndex, name, before, after, label, side } = write;
    const detail = `${label} ${side}`;
    step("value-target", `${detail}: getParam`);
    const { component, param } = resolveParam(chain, target, paramIndex, name);
    if (param.isTimeVarying()) throw new Error(`${label}にキーフレームがあります。再解析してください。`);
    step("value-keyframe", `${detail}: createKeyframe`);
    const keyframe = param.createKeyframe(restore ? before : after);
    step("value-action", `${detail}: createSetValueAction`);
    const action = param.createSetValueAction(keyframe, true);
    // Keep native parents and keyframes alive along with their actions until
    // the synchronous transaction callback has queued every action.
    return { component, param, keyframe, action, detail };
  });
}

async function verifyValues(trackItem, writes, restore = false) {
  const chain = await trackItem.getComponentChain();
  for (const { target, paramIndex, name, before, after } of writes) {
    const { param } = resolveParam(chain, target, paramIndex, name);
    if (Math.abs(await numericValue(param) - (restore ? before : after)) > 0.0001) {
      throw new Error(`切り抜きの「${name}」を${restore ? "元に戻した後" : "設定後"}に検証できません。`);
    }
  }
}

function validateDetection(detection) {
  if (!detection || detection.status !== "ok" || !detection.percentages) {
    throw new Error("黒枠の有効な解析結果がありません。");
  }
  const values = detection.percentages;
  if (SIDES.some(side => !Number.isFinite(values[side]) || values[side] < 0 || values[side] >= 100) ||
      values.left + values.right >= 100 || values.top + values.bottom >= 100) {
    throw new Error("Crop 値が元画像全体を切り抜くため、適用しません。");
  }
  return values;
}

function stageError(error, stage, detail = "") {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  const wrapped = new Error(`[Crop適用: ${stage}] ${detail ? `${detail}: ` : ""}${message}`);
  wrapped.stage = stage;
  wrapped.cause = error;
  return wrapped;
}

function createPremiereHost(ppro) {
  async function getSelection() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("Premiere Pro でプロジェクトを開いてください。");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("タイムラインのシーケンスを開いてください。");
    const selection = await sequence.getSelection();
    const selected = await selection.getTrackItems();
    const items = [];
    for (const trackItem of selected) {
      let name = "クリップ";
      try {
        name = await trackItem.getName();
        if (!(trackItem instanceof ppro.VideoClipTrackItem)) throw new Error("ビデオの静止画クリップを選択してください。");
        const clip = ppro.ClipProjectItem.cast(await trackItem.getProjectItem());
        if (!clip || await clip.isSequence()) throw new Error("ネストされたシーケンスには対応していません。");
        if (await clip.isOffline()) throw new Error("素材がオフラインです。");
        const path = await clip.getMediaFilePath();
        if (!/\.(png|jpe?g|tiff?)$/i.test(path)) throw new Error("最小版は PNG / JPEG / TIFF の静止画に対応しています。");
        items.push({ trackItem, clip, path, name });
      } catch (error) {
        items.push({ name, error: error.message || String(error) });
      }
    }
    return { project, sequence, projectGuid: guidOf(project), sequenceGuid: guidOf(sequence), items };
  }

  async function assertCurrent(context, record) {
    const project = await ppro.Project.getActiveProject();
    if (!sameEntity(project, context.project, context.projectGuid || guidOf(context.project))) {
      throw new Error("解析後にプロジェクトが変更されました。再解析してください。");
    }
    const sequence = await project.getActiveSequence();
    if (!sameEntity(sequence, context.sequence, context.sequenceGuid || guidOf(context.sequence))) {
      throw new Error("解析後にシーケンスが変更されました。再解析してください。");
    }
    const currentClip = ppro.ClipProjectItem.cast(await record.trackItem.getProjectItem());
    if (!currentClip || await currentClip.isSequence() || await currentClip.isOffline() ||
        await currentClip.getMediaFilePath() !== record.path) {
      throw new Error("解析後に元画像が変更されたかオフラインになりました。再解析してください。");
    }
    return project;
  }

  async function applyCrop(context, record) {
    let stage = "analysis-validation";
    let detail = "";
    const writes = [];
    let attemptedValues = false;
    try {
      const percentages = validateDetection(record.detection);
      stage = "selection-context";
      await assertCurrent(context, record);
      stage = "chain-enumeration";
      const chain = await record.trackItem.getComponentChain();
      const { motions, crops } = await findTargets(chain);
      stage = "motion-availability";
      if (motions.length !== 1) {
        throw new Error(motions.length
          ? "モーションが複数あり、適用先を特定できません。"
          : "モーションが見つかりません。この版はモーション内の切り抜き4項目へ適用します。");
      }
      stage = "motion-parameter-inspection";
      const { params } = await inspectSides(chain, motions[0], "モーションの切り抜き", true);
      for (const side of SIDES) {
        writes.push({ target: motions[0], paramIndex: params[side].paramIndex, name: params[side].name,
          label: "モーション", side, before: params[side].value, after: percentages[side] });
      }
      stage = "legacy-crop-inspection";
      if (crops.length > 1) throw new Error("既存Cropが複数あります。対象の静止画をスキップしました。");
      if (crops.length) {
        const legacy = await inspectLegacyCrop(chain, crops[0]);
        for (const side of SIDES) {
          writes.push({ target: crops[0], paramIndex: legacy[side].paramIndex, name: legacy[side].name,
            label: "既存Crop", side, before: legacy[side].value, after: 0 });
        }
      }
      stage = "selection-context";
      const project = await assertCurrent(context, record);
      const writeChain = await record.trackItem.getComponentChain();
      stage = "value-transaction";
      // Follow Adobe's native sample: resolve current wrappers under the lock,
      // create actions inside executeTransaction, then queue them synchronously.
      transact(project, "黒枠: モーションの切り抜きを設定", compound => {
        const inputs = valueActions(writeChain, writes, false, (operation, target) => {
          stage = operation; detail = target;
        });
        attemptedValues = true;
        for (const input of inputs) {
          stage = "value-add-action"; detail = input.detail;
          compound.addAction(input.action);
        }
        stage = "value-transaction"; detail = "";
      });
      stage = "readback";
      detail = "";
      await verifyValues(record.trackItem, writes);
      return {
        status: "applied", target: "motion-crop", created: false,
        legacyCropCleared: crops.length === 1, percentages: { ...percentages }
      };
    } catch (error) {
      const failure = stageError(error, stage, detail);
      let rollbackStage;
      let rollbackDetail = "";
      try {
        if (attemptedValues) {
          rollbackStage = "rollback-values";
          const project = await assertCurrent(context, record);
          const rollbackChain = await record.trackItem.getComponentChain();
          transact(project, "黒枠: 切り抜きの値を元に戻す", compound => {
            const inputs = valueActions(rollbackChain, writes, true, (operation, target) => {
              rollbackDetail = `${target} (${operation})`;
            });
            for (const input of inputs) {
              rollbackDetail = `${input.detail}: addAction`;
              compound.addAction(input.action);
            }
            rollbackDetail = "";
          });
          rollbackStage = "rollback-values-readback";
          await verifyValues(record.trackItem, writes, true);
        }
      } catch (rollbackError) {
        const rollbackFailure = stageError(rollbackError, rollbackStage, rollbackDetail);
        const combined = new Error(`${failure.message} 取り消しにも失敗しました: ${rollbackFailure.message}。Premiere Pro で Undo とエフェクト状態を確認してください。`);
        combined.stage = stage;
        combined.cause = failure;
        combined.rollbackError = rollbackFailure;
        throw combined;
      }
      throw failure;
    }
  }

  return { getSelection, applyCrop };
}

module.exports = { createPremiereHost };
