"use strict";

// Original geometric fixtures with a similar landscape layout to the report.
// Expected boundaries are literals from the drawing below, never detector output.
const test = require("node:test");
const assert = require("node:assert/strict");
const UTIF = require("utif");
const { decodeImage } = require("../src/image-reader");
const { detectBlackBorders } = require("../src/black-borders");
const { detectPanelFrame } = require("../src/panel-frame");
const { detectBorders } = require("../src/border-detection");

function blank() {
  return { width: 1000, height: 500, data: new Uint8Array(1000 * 500 * 4).fill(255) };
}

function paint(image, left, top, right, bottom, value = 0) {
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = value;
    }
  }
}

function landscape({ topGap = 0, missingRight = false, black = 0 } = {}) {
  const image = blank();
  // Outer rectangle: [50, 958) × [88, 442), thickness 8 source pixels.
  // Inner rectangle: [58, 950) × [96, 434).
  paint(image, 50, 88, 958, 96, black);
  paint(image, 50, 434, 958, 442, black);
  paint(image, 50, 88, 58, 442, black);
  if (!missingRight) paint(image, 950, 88, 958, 442, black);
  if (topGap) paint(image, 460, 88, 460 + topGap, 96, 255);
  // Narrow protruding strokes above the top edge must not replace that edge.
  paint(image, 140, 45, 143, 125, black);
  paint(image, 255, 52, 259, 121, black);
  // Original interior shapes; no full horizontal/vertical black lines.
  paint(image, 300, 180, 330, 220, black);
  paint(image, 550, 250, 620, 300, black);
  return image;
}

const ZERO = { left: 0, right: 0, top: 0, bottom: 0 };
const EXPECTED_PIXELS = { left: 58, right: 50, top: 96, bottom: 66 };
const EXPECTED_PERCENTAGES = { left: 5.8, right: 5, top: 19.2, bottom: 13.2 };

test("white margins reproduce the old successful zero crop and now yield verified inner frame edges", () => {
  const image = landscape({ topGap: 30 });
  const before = new Uint8Array(image.data);
  assert.deepEqual(detectBlackBorders(image).pixels, ZERO);
  const result = detectBorders(image, "edge-bands");
  assert.equal(result.status, "ok");
  assert.equal(result.mode, "edge-bands");
  assert.equal(result.method, "white-margin-frame-fallback");
  assert.deepEqual(result.pixels, EXPECTED_PIXELS);
  assert.deepEqual(result.percentages, EXPECTED_PERCENTAGES);
  assert.deepEqual(image.data, before, "analysis never modifies source pixels");
});

test("landscape source TIFF roundtrip keeps source-size percentages and excludes the four frame bands", () => {
  const source = landscape({ topGap: 30 });
  const bytes = UTIF.encodeImage(source.data.buffer, source.width, source.height);
  const image = decodeImage(bytes, "tif");
  const result = detectBorders(image, "edge-bands");
  assert.equal(image.width, 1000);
  assert.equal(image.height, 500);
  assert.deepEqual(result.pixels, EXPECTED_PIXELS);
  assert.deepEqual(result.percentages, EXPECTED_PERCENTAGES);
  // These expected percentages represent exact integer source coordinates.
  const retained = {
    left: result.percentages.left * image.width / 100,
    right: image.width * (1 - result.percentages.right / 100),
    top: result.percentages.top * image.height / 100,
    bottom: image.height * (1 - result.percentages.bottom / 100)
  };
  assert.deepEqual(retained, { left: 58, right: 950, top: 96, bottom: 434 });
  assert.ok(retained.left >= 58 && retained.right <= 950);
  assert.ok(retained.top >= 96 && retained.bottom <= 434);
  const marker = (200 * image.width + 310) * 4;
  assert.equal(image.data[marker], 0, "the interior marker remains in the retained rectangle");
  assert.ok(310 >= retained.left && 310 < retained.right && 200 >= retained.top && 200 < retained.bottom);
});

test("a real image-edge band takes precedence over an interior white-margin rectangle", () => {
  const image = landscape();
  paint(image, 0, 0, image.width, 3);
  const literal = detectBlackBorders(image);
  assert.deepEqual(literal.pixels, { left: 0, right: 0, top: 3, bottom: 0 });
  assert.deepEqual(detectBorders(image, "edge-bands"), {
    ...literal, mode: "edge-bands", method: "continuous-edge-bands"
  });
});

test("white pages and drawings without four frame sides remain a zero edge result", () => {
  for (const image of [blank(), landscape({ missingRight: true })]) {
    const result = detectBorders(image, "edge-bands");
    assert.equal(result.status, "ok");
    assert.deepEqual(result.pixels, ZERO);
    assert.deepEqual(result.percentages, ZERO);
    assert.notEqual(result.method, "white-margin-frame-fallback");
  }
});

test("fallback retains RGB20 and 95% coverage thresholds", () => {
  assert.deepEqual(detectBorders(landscape({ black: 20 }), "edge-bands").pixels, EXPECTED_PIXELS);
  assert.deepEqual(detectBorders(landscape({ black: 21 }), "edge-bands").pixels, ZERO);
  // 55 missing columns out of 908 leaves <95% coverage of the top side.
  assert.deepEqual(detectBorders(landscape({ topGap: 55 }), "edge-bands").pixels, ZERO);
});

test("ambiguous literal borders stay ambiguous and explicit panel mode is unchanged", () => {
  const black = blank();
  paint(black, 0, 0, black.width, black.height);
  assert.deepEqual(detectBorders(black, "edge-bands"), {
    ...detectBlackBorders(black), mode: "edge-bands", method: "continuous-edge-bands"
  });
  const image = landscape({ topGap: 30 });
  assert.deepEqual(detectBorders(image, "panel-frame"), detectPanelFrame(image));
});

test("an unknown mode cannot silently select another detection strategy", () => {
  assert.throws(() => detectBorders(landscape(), "unknown"), /検出モード/);
});
