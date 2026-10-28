"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const UPNG = require("upng-js");
const UTIF = require("utif");
const { createFixtures } = require("../scripts/create-samples.js");
const { decodeImage } = require("../src/image-reader.js");
const { detectBlackBorders } = require("../src/black-borders.js");
const { calculateFit } = require("../src/fit-geometry.js");

const fixtures = createFixtures();

test("manual test set contains exactly ten uniquely named source images", () => {
  assert.equal(fixtures.length, 10);
  assert.equal(new Set(fixtures.map(({ name }) => name)).size, 10);
  assert.equal(fixtures.filter(({ status }) => status === "ok").length, 9);
  assert.equal(fixtures.filter(({ status }) => status === "ambiguous").length, 1);
});

for (const format of ["png", "tiff"]) {
 for (const fixture of fixtures) {
  test(`${fixture.name}: source ${format.toUpperCase()} decode → edge detection → rounded Crop and fit`, () => {
    const encoded = format === "tiff"
      ? UTIF.encodeImage(fixture.data.buffer, fixture.width, fixture.height)
      : UPNG.encode([fixture.data.buffer], fixture.width, fixture.height, 0);
    const image = decodeImage(encoded, format === "tiff" ? "tif" : "png");
    assert.equal(image.width, fixture.width);
    assert.equal(image.height, fixture.height);
    const result = detectBlackBorders(image);
    assert.equal(result.status, fixture.status);
    assert.deepEqual(result.pixels, fixture.pixels);
    assert.deepEqual(result.percentages, fixture.percentages);
    if (fixture.status === "ambiguous") {
      assert.equal(result.reason, fixture.reason);
      return;
    }
    const fit = calculateFit({
      width: image.width, height: image.height, percentages: result.percentages,
      sequenceWidth: 1920, sequenceHeight: 1080
    });
    const scale = fit.scalePercent / 100;
    assert.ok(fit.contentWidth * scale <= 1920 + 1e-9);
    assert.ok(fit.contentHeight * scale <= 1080 + 1e-9);
    assert.ok(Math.abs(fit.contentWidth * scale - 1920) < 1e-9 ||
      Math.abs(fit.contentHeight * scale - 1080) < 1e-9);
    const cropCenterX = image.width * (result.percentages.left - result.percentages.right) / 200;
    const cropCenterY = image.height * (result.percentages.top - result.percentages.bottom) / 200;
    assert.ok(Math.abs(fit.positionPixels.x + cropCenterX * scale - 960) < 1e-9);
    assert.ok(Math.abs(fit.positionPixels.y + cropCenterY * scale - 540) < 1e-9);
  });
 }
}
