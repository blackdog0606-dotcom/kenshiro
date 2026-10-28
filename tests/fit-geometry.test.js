"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateFit } = require("../src/fit-geometry.js");

const zeroCrop = { left: 0, right: 0, top: 0, bottom: 0 };

function approx(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
}

function fit(overrides = {}) {
  return calculateFit({
    width: 1920,
    height: 1080,
    percentages: zeroCrop,
    sequenceWidth: 1920,
    sequenceHeight: 1080,
    ...overrides
  });
}

test("an uncropped source matching the sequence remains at 100% and center", () => {
  assert.deepEqual(fit(), {
    scalePercent: 100,
    positionPixels: { x: 960, y: 540 },
    contentWidth: 1920,
    contentHeight: 1080
  });
});

test("symmetric crops enlarge the content while retaining the source-center position", () => {
  const result = fit({ percentages: { left: 10, right: 10, top: 10, bottom: 10 } });
  approx(result.scalePercent, 125);
  assert.deepEqual(result.positionPixels, { x: 960, y: 540 });
  approx(result.contentWidth, 1536);
  approx(result.contentHeight, 864);
});

test("asymmetric crop offsets are compensated in sequence pixel coordinates", () => {
  const result = calculateFit({
    width: 1000, height: 800,
    percentages: { left: 20, right: 0, top: 10, bottom: 0 },
    sequenceWidth: 800, sequenceHeight: 720
  });
  assert.deepEqual(result, {
    scalePercent: 100,
    positionPixels: { x: 300, y: 320 },
    contentWidth: 800,
    contentHeight: 720
  });
  // The surviving source bbox center, relative to its center anchor, must
  // land exactly at sequence center after applying scale and position.
  approx(result.positionPixels.x + (600 - 500) * result.scalePercent / 100, 400);
  approx(result.positionPixels.y + (440 - 400) * result.scalePercent / 100, 360);
});

test("right and bottom crops move the source position in the opposite direction", () => {
  const result = calculateFit({
    width: 1000, height: 800,
    percentages: { left: 0, right: 20, top: 0, bottom: 10 },
    sequenceWidth: 800, sequenceHeight: 720
  });
  assert.deepEqual(result.positionPixels, { x: 500, y: 400 });
});

test("portrait content is contained vertically within a landscape sequence", () => {
  const result = fit({ width: 1000, height: 2000 });
  approx(result.scalePercent, 54);
  assert.deepEqual(result.positionPixels, { x: 960, y: 540 });
  approx(result.contentHeight * result.scalePercent / 100, 1080);
  assert.ok(result.contentWidth * result.scalePercent / 100 < 1920);
});

test("landscape content is contained horizontally within a portrait sequence", () => {
  const result = fit({ sequenceWidth: 1080, sequenceHeight: 1920 });
  approx(result.scalePercent, 56.25);
  assert.deepEqual(result.positionPixels, { x: 540, y: 960 });
  approx(result.contentWidth * result.scalePercent / 100, 1080);
  assert.ok(result.contentHeight * result.scalePercent / 100 < 1920);
});

test("uses applied 0.1% crop values without re-rounding content dimensions", () => {
  const result = fit({ percentages: { left: 0.4, right: 0.9, top: 1.2, bottom: 1.3 } });
  approx(result.contentWidth, 1920 * 0.987);
  approx(result.contentHeight, 1080 * 0.975);
  const scale = 1 / 0.987;
  approx(result.scalePercent, scale * 100);
  approx(result.positionPixels.x, 960 + 4.8 * scale);
  approx(result.positionPixels.y, 540 + 0.54 * scale);
});

test("large sources can be reduced as well as enlarged", () => {
  const result = fit({ width: 3840, height: 2160 });
  assert.equal(result.scalePercent, 50);
});

test("rejects nonpositive or nonfinite source and sequence dimensions", () => {
  for (const key of ["width", "height", "sequenceWidth", "sequenceHeight"]) {
    for (const value of [0, -1, NaN, Infinity, undefined, "1920"]) {
      assert.throws(() => fit({ [key]: value }), RangeError);
    }
  }
});

test("rejects missing, invalid or fully removed Crop content", () => {
  assert.throws(() => calculateFit(), TypeError);
  assert.throws(() => fit({ percentages: null }), TypeError);
  assert.throws(() => fit({ percentages: { left: 0, right: 0, top: 0 } }), RangeError);
  for (const value of [-0.1, 100.1, NaN, Infinity, "0"]) {
    assert.throws(() => fit({ percentages: { ...zeroCrop, left: value } }), RangeError);
  }
  for (const percentages of [
    { ...zeroCrop, left: 50, right: 50 },
    { ...zeroCrop, top: 60, bottom: 40 },
    { ...zeroCrop, top: 100 }
  ]) {
    assert.throws(() => fit({ percentages }), RangeError);
  }
});
