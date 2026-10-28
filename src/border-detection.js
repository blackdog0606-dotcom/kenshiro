"use strict";

const { detectBlackBorders } = require("./black-borders");
const { detectPanelFrame } = require("./panel-frame");

// Preserve the original edge scan and thresholds. White margins prevent that
// scan from reaching an inset frame. Only an all-zero result may try the
// existing four-sided frame detector; uncertain frames produce no crop.
function detectBorders(image, mode) {
  if (mode === "panel-frame") return detectPanelFrame(image);
  if (mode !== "edge-bands") throw new Error("検出モードを選択し直してください。");

  const edges = detectBlackBorders(image);
  if (edges.status !== "ok" || Object.values(edges.pixels).some(value => value > 0)) {
    return { ...edges, mode: "edge-bands", method: "continuous-edge-bands" };
  }

  const frame = detectPanelFrame(image);
  if (frame.status === "ok") {
    return { ...frame, mode: "edge-bands", method: "white-margin-frame-fallback" };
  }
  return { ...edges, mode: "edge-bands", method: "continuous-edge-bands" };
}

module.exports = { detectBorders };
