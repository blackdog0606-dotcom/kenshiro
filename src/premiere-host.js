"use strict";

const CROP_MATCH_NAMES = ["AE.ADBE AECrop", "AE.ADBE Crop", "PR.ADBE Crop", "ADBE Crop"];
const SIDES = ["left", "right", "top", "bottom"];

function normalizeName(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s()（）:：・_\-]/g, "");
}

const SIDE_NAMES = {
  left: ["left", "左", "左側", "左端"],
  right: ["right", "右", "右側", "右端"],
  top: ["top", "上", "上側", "上端"],
  bottom: ["bottom", "下", "下側", "下端"]
};

function sideForName(name) {
  const normalized = normalizeName(name);
  return SIDES.find(side => SIDE_NAMES[side].some(label =>
    normalized === label || normalized === `crop${label}` ||
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
  const keyframe = await param.getStartValue();
  const value = keyframe && keyframe.value && keyframe.value.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Crop の「${param.displayName}」の数値を取得できません。`);
  }
  return value;
}

function transact(project, label, build) {
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction(compound => build(compound), label);
  });
  if (!success) throw new Error(`${label} のトランザクションに失敗しました。`);
}

async function cropComponents(chain) {
  const result = [];
  const count = chain.getComponentCount();
  for (let i = 0; i < count; i++) {
    const component = chain.getComponentAtIndex(i);
    if (CROP_MATCH_NAMES.includes(await component.getMatchName())) result.push(component);
  }
  return result;
}

async function inspectCrop(component) {
  const params = {};
  for (let i = 0; i < component.getParamCount(); i++) {
    const param = component.getParam(i);
    const side = sideForName(param.displayName);
    if (side) {
      if (params[side]) throw new Error(`Crop の ${side} パラメータが重複しています。`);
      if (param.isTimeVarying()) throw new Error("Crop にキーフレームがあります。対象の静止画をスキップしました。");
      params[side] = { param, value: await numericValue(param) };
    } else {
      const name = normalizeName(param.displayName);
      if (["zoom", "ズーム"].includes(name)) {
        if (param.isTimeVarying()) throw new Error("Crop のズームがアニメーションしています。");
        const keyframe = await param.getStartValue();
        const value = keyframe && keyframe.value && keyframe.value.value;
        if (value !== false && value !== 0) throw new Error("Crop のズームをオフにしてから再実行してください。");
      }
      if (["edgefeather", "エッジのぼかし", "境界のぼかし", "エッジの境界ぼかし"].includes(name)) {
        if (param.isTimeVarying() || await numericValue(param) !== 0) {
          throw new Error("Crop の境界のぼかしを 0 にしてから再実行してください。");
        }
      }
    }
  }
  if (SIDES.some(side => !params[side])) {
    throw new Error("Crop の Left / Right / Top / Bottom を識別できません。英語・日本語 UI の標準 Crop が必要です。");
  }
  return params;
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

function stageError(error, stage) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  const wrapped = new Error(`[Crop適用: ${stage}] ${message}`);
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
  }

  async function applyCrop(context, record) {
    let stage = "analysis-validation";
    let chain;
    let component;
    let created = false;
    let params;
    let attemptedValues = false;
    try {
      const percentages = validateDetection(record.detection);
      stage = "selection-context";
      await assertCurrent(context, record);
      stage = "chain-enumeration";
      chain = await record.trackItem.getComponentChain();
      let crops = await cropComponents(chain);
      if (crops.length > 1) throw new Error("Crop が複数あります。対象の静止画をスキップしました。");
      component = crops[0];
      if (!component) {
        stage = "crop-availability";
        const available = await ppro.VideoFilterFactory.getMatchNames();
        const matchName = CROP_MATCH_NAMES.find(name => available.includes(name));
        if (!matchName) throw new Error("標準の Crop エフェクトが利用できません。");
        stage = "crop-create";
        const pending = await ppro.VideoFilterFactory.createComponent(matchName);
        stage = "selection-context";
        await assertCurrent(context, record);
        stage = "crop-append";
        const appendedIndex = chain.getComponentCount();
        transact(context.project, "黒枠: Crop を追加", compound => {
          compound.addAction(chain.createAppendComponentAction(pending));
        });
        created = true;
        // Capture the appended instance synchronously before yielding again.
        // The factory object can lack params until insertion has completed.
        stage = "crop-reacquire";
        component = chain.getComponentAtIndex(appendedIndex) || pending;
        chain = await record.trackItem.getComponentChain();
        crops = await cropComponents(chain);
        if (crops.length !== 1) throw new Error("追加後の Crop を一意に取得できません。");
        component = crops[0];
      }
      stage = "crop-parameter-inspection";
      params = await inspectCrop(component);
      stage = "selection-context";
      await assertCurrent(context, record);
      stage = "value-transaction";
      attemptedValues = true;
      transact(context.project, "黒枠: Crop 値を設定", compound => {
        for (const side of SIDES) {
          const param = params[side].param;
          compound.addAction(param.createSetValueAction(param.createKeyframe(percentages[side]), true));
        }
      });
      stage = "readback";
      for (const side of SIDES) {
        if (Math.abs(await numericValue(params[side].param) - percentages[side]) > 0.0001) {
          throw new Error(`Crop の ${side} を設定後に検証できません。`);
        }
      }
      return { status: "applied", created, percentages: { ...percentages } };
    } catch (error) {
      const failure = stageError(error, stage);
      let rollbackStage;
      try {
        if (created && component) {
          rollbackStage = "rollback-remove";
          transact(context.project, "黒枠: 追加した Crop を取り消し", compound => {
            compound.addAction(chain.createRemoveComponentAction(component));
          });
          rollbackStage = "rollback-remove-verification";
          if ((await cropComponents(await record.trackItem.getComponentChain())).length) {
            throw new Error("追加した Crop の削除を確認できません。");
          }
        } else if (!created && attemptedValues && params) {
          rollbackStage = "rollback-values";
          transact(context.project, "黒枠: Crop 値を元に戻す", compound => {
            for (const side of SIDES) {
              const { param, value } = params[side];
              compound.addAction(param.createSetValueAction(param.createKeyframe(value), true));
            }
          });
          rollbackStage = "rollback-values-readback";
          for (const side of SIDES) {
            if (Math.abs(await numericValue(params[side].param) - params[side].value) > 0.0001) {
              throw new Error(`Crop の ${side} を元に戻せません。`);
            }
          }
        } else if (created) {
          rollbackStage = "rollback-identification";
          throw new Error("追加したエフェクトを特定できません。");
        }
      } catch (rollbackError) {
        const rollbackFailure = stageError(rollbackError, rollbackStage);
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
