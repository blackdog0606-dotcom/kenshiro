"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectPanelFrame } = require("../src/panel-frame.js");

function paint(image, left, top, right, bottom, rgb = [0, 0, 0]) {
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      image.data.set([...rgb, 255], (y * image.width + x) * 4);
    }
  }
}

function blank(width = 400, height = 300) {
  const data = new Uint8Array(width * height * 4).fill(255);
  return { width, height, data };
}

function frame({ width = 400, height = 300, left = 30, right = 370, top = 20, bottom = 280,
  thickness = 4, color = [0, 0, 0] } = {}) {
  const image = blank(width, height);
  paint(image, left, top, right, top + thickness, color);
  paint(image, left, bottom - thickness, right, bottom, color);
  paint(image, left, top, left + thickness, bottom, color);
  paint(image, right - thickness, top, right, bottom, color);
  return image;
}

function expectSkipped(image) {
  const result = detectPanelFrame(image);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.reason, "no-rectangular-frame");
  assert.equal(result.pixels, null);
  assert.equal(result.percentages, null);
  return result;
}

test("removes exterior white margins and all four frame bands up to the inner edges", () => {
  const result = detectPanelFrame(frame());
  assert.equal(result.status, "ok");
  assert.equal(result.mode, "panel-frame");
  assert.equal(result.method, "projected-frame-bands");
  assert.deepEqual(result.pixels, { left: 34, right: 34, top: 24, bottom: 24 });
  assert.deepEqual(result.percentages, { left: 8.5, right: 8.5, top: 8, bottom: 8 });
  assert.deepEqual(result.outerBounds, { left: 30, right: 370, top: 20, bottom: 280 });
  assert.deepEqual(result.innerBounds, { left: 34, right: 366, top: 24, bottom: 276 });
  assert.deepEqual(result.bandWidths, { left: 4, right: 4, top: 4, bottom: 4 });
});

test("internal faces and dark lines do not move the detected panel edges inward", () => {
  const image = frame();
  paint(image, 180, 70, 215, 100); // Head-like interior mark.
  paint(image, 160, 100, 235, 220); // Interior drawing.
  paint(image, 45, 150, 350, 154);
  assert.deepEqual(detectPanelFrame(image).pixels, { left: 34, right: 34, top: 24, bottom: 24 });
});

test("an isolated vertical stroke outside the right frame does not replace that side", () => {
  const image = frame();
  paint(image, 390, 100, 394, 200);
  assert.deepEqual(detectPanelFrame(image).pixels, { left: 34, right: 34, top: 24, bottom: 24 });
});

test("uses source-image dimensions and rounds white-margin-plus-frame crops to 0.1%", () => {
  const image = frame({ width: 1000, height: 800, left: 43, right: 958, top: 31, bottom: 769, thickness: 7 });
  const result = detectPanelFrame(image);
  assert.deepEqual(result.pixels, { left: 50, right: 49, top: 38, bottom: 38 });
  assert.deepEqual(result.percentages, { left: 5, right: 4.9, top: 4.8, bottom: 4.8 });
});

test("RGB20 counts as black and RGB21 in one channel does not", () => {
  assert.equal(detectPanelFrame(frame({ color: [20, 20, 20] })).status, "ok");
  for (const color of [[21, 20, 20], [20, 21, 20], [20, 20, 21]]) {
    expectSkipped(frame({ color }));
  }
});

test("exactly95% projected horizontal coverage qualifies; below95% is skipped", () => {
  const image = frame({ width: 1000, height: 800, left: 80, right: 920, top: 60, bottom: 740, thickness: 10 });
  // 42 missing columns / 840 total = exactly5%; keep the four corners intact.
  for (let n = 0; n < 42; n++) paint(image, 89 + n * 20, 60, 90 + n * 20, 70, [255, 255, 255]);
  assert.equal(detectPanelFrame(image).status, "ok");
  paint(image, 91, 60, 92, 70, [255, 255, 255]);
  expectSkipped(image);
});

test("exactly95% projected vertical coverage qualifies; below95% is skipped", () => {
  const image = frame({ width: 1000, height: 800, left: 80, right: 920, top: 60, bottom: 740, thickness: 10 });
  // 34 missing rows / 680 total = exactly5%.
  paint(image, 910, 300, 920, 334, [255, 255, 255]);
  assert.equal(detectPanelFrame(image).status, "ok");
  paint(image, 910, 334, 920, 335, [255, 255, 255]);
  expectSkipped(image);
});

test("narrow projection bands tolerate a mildly tilted horizontal frame", () => {
  const image = blank(1000, 800);
  for (let x = 80; x < 920; x++) {
    const slope = Math.floor((x - 80) / 200);
    paint(image, x, 60 + slope, x + 1, 66 + slope);
    paint(image, x, 734 + slope, x + 1, 740 + slope);
  }
  paint(image, 80, 60, 86, 744);
  paint(image, 914, 60, 920, 744);
  const result = detectPanelFrame(image);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.pixels, { left: 86, right: 86, top: 70, bottom: 66 });
  assert.deepEqual(result.bandWidths, { left: 6, right: 6, top: 10, bottom: 10 });
});

test("only three sides never falls back to cropping the drawing", () => {
  const image = frame();
  paint(image, 366, 24, 370, 276, [255, 255, 255]);
  expectSkipped(image);
});

test("an interior rectangle outside the allowed exterior-quarter search is skipped", () => {
  expectSkipped(frame({ left: 130, right: 270, top: 110, bottom: 190 }));
});

test("a wholly black image is skipped rather than assigned arbitrary inner edges", () => {
  const image = blank();
  paint(image, 0, 0, image.width, image.height);
  expectSkipped(image);
});

test("a drawing without a surrounding rectangle and a white image are skipped", () => {
  const image = blank();
  paint(image, 100, 30, 104, 260);
  paint(image, 20, 150, 380, 154);
  paint(image, 200, 60, 230, 90);
  expectSkipped(image);
  expectSkipped(blank());
});

test("bands wider than3% of a source dimension are rejected conservatively", () => {
  expectSkipped(frame({ thickness: 20 }));
});

test("malformed RGBA inputs are rejected and tiny images are skipped", () => {
  assert.throws(() => detectPanelFrame(null), TypeError);
  assert.throws(() => detectPanelFrame({ width: 1, height: 1, data: [] }), TypeError);
  assert.throws(() => detectPanelFrame({ width: 1, height: 1, data: new Uint8Array(3) }), RangeError);
  assert.throws(() => detectPanelFrame({ width: Infinity, height: 1, data: new Uint8Array(4) }), RangeError);
  expectSkipped(blank(7, 7));
});
