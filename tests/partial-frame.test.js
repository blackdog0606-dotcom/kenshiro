"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { detectBorders } = require("../src/border-detection");
function image(sides, { black = 20, gap = 0, background = 255 } = {}) {
  const width = 400, height = 300;
  const data = new Uint8Array(width * height * 4).fill(background);
  const paint = (x0, y0, x1, y1, value) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  };
  // Content fills the source except for the requested exterior margins.
  const left = sides.includes("left") ? 30 : 0;
  const right = sides.includes("right") ? 370 : width;
  const top = sides.includes("top") ? 20 : 0;
  const bottom = sides.includes("bottom") ? 280 : height;
  paint(left, top, right, bottom, 160);
  if (sides.includes("left")) paint(30, top, 34, bottom, black);
  if (sides.includes("right")) paint(366, top, 370, bottom, black);
  if (sides.includes("top")) paint(left, 20, right, 24, black);
  if (sides.includes("bottom")) paint(left, 276, right, 280, black);
  if (gap) paint(366, 100, 370, 100 + gap, 160);
  return { width, height, data };
}
for (let mask = 1; mask < 16; mask++) {
  const keys = ["left", "right", "top", "bottom"];
  const sides = keys.filter((_, i) => mask & (1 << i));
  test(`partial mode detects ${sides.join(" + ")} and leaves absent sides at zero`, () => {
    const result = detectBorders(image(sides), "partial-frame");
    assert.equal(result.status, "ok");
    assert.deepEqual(result.pixels, Object.fromEntries(keys.map(side => [side, sides.includes(side) ? (side === "left" || side === "right" ? 34 : 24) : 0])));
    assert.deepEqual(result.percentages, Object.fromEntries(keys.map(side => [side, sides.includes(side) ? (side === "left" || side === "right" ? 8.5 : 8) : 0])));
    assert.deepEqual(result.detectedSides.slice().sort(), sides.slice().sort());
  });
}
test("right-only band requires at least95% coverage", () => {
  assert.equal(detectBorders(image(["right"], { gap: 15 }), "partial-frame").status, "ok");
  assert.equal(detectBorders(image(["right"], { gap: 16 }), "partial-frame").status, "ambiguous");
});
test("partial mode rejects RGB21 and absent frames", () => {
  assert.equal(detectBorders(image(["right"], { black: 21 }), "partial-frame").status, "ambiguous");
  assert.equal(detectBorders(image([]), "partial-frame").status, "ambiguous");
});
test("black exterior is not treated as a white margin", () => {
  assert.equal(detectBorders(image(["right"], { background: 0 }), "partial-frame").status, "ambiguous");
});
test("existing four-side mode continues to reject a right-only frame", () => {
  assert.equal(detectBorders(image(["right"]), "panel-frame").status, "ambiguous");
});
