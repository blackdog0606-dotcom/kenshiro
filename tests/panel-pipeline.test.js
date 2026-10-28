"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const UTIF = require("utif");
const { createFixtures } = require("../scripts/create-panel-samples.js");
const { decodeImage } = require("../src/image-reader.js");
const { detectPanelFrame } = require("../src/panel-frame.js");
const { calculateFit } = require("../src/fit-geometry.js");

const fixtures = createFixtures();

test("panel sample set has exactly ten unique original sources and eight crop candidates", () => {
  assert.equal(fixtures.length, 10);
  assert.equal(new Set(fixtures.map(({ name }) => name)).size, 10);
  assert.equal(fixtures.filter(({ status }) => status === "ok").length, 8);
  assert.equal(fixtures.filter(({ status }) => status !== "ok").length, 2);
  assert.ok(fixtures.every(({ width, height }) => width === 1000 && height === 800));
});

for (const fixture of fixtures) {
  test(`${fixture.name}: original TIFF → white margin/frame removal → rounded Crop and fit`, () => {
    const encoded = UTIF.encodeImage(fixture.data.buffer, fixture.width, fixture.height);
    assert.equal(UTIF.decode(encoded).length, 1);
    const image = decodeImage(encoded, "tif");
    const result = detectPanelFrame(image);
    if (fixture.status !== "ok") {
      assert.notEqual(result.status, "ok");
      assert.equal(result.percentages, null);
      return;
    }
    assert.equal(result.status, "ok");
    assert.deepEqual(result.pixels, fixture.pixels);
    assert.deepEqual(result.percentages, fixture.percentages);
    const fit = calculateFit({
      width: image.width, height: image.height, percentages: result.percentages,
      sequenceWidth: 1920, sequenceHeight: 1080,
    });
    const scale = fit.scalePercent / 100;
    assert.ok(fit.contentWidth * scale <= 1920 + 1e-9);
    assert.ok(fit.contentHeight * scale <= 1080 + 1e-9);
    assert.ok(Math.abs(fit.contentWidth * scale - 1920) < 1e-9 || Math.abs(fit.contentHeight * scale - 1080) < 1e-9);
    const cropCenterX = image.width * (result.percentages.left - result.percentages.right) / 200;
    const cropCenterY = image.height * (result.percentages.top - result.percentages.bottom) / 200;
    assert.ok(Math.abs(fit.positionPixels.x + cropCenterX * scale - 960) < 1e-9);
    assert.ok(Math.abs(fit.positionPixels.y + cropCenterY * scale - 540) < 1e-9);
  });
}

test("sample generator writes exactly ten single-page TIFF files plus the independent expectations", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kenshiro-panel-fixtures-"));
  try {
    const script = path.join(__dirname, "..", "scripts", "create-panel-samples.js");
    const generated = spawnSync(process.execPath, [script, temporary], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    const files = fs.readdirSync(temporary);
    assert.equal(files.length, 11);
    assert.equal(files.filter((file) => file.endsWith(".tif")).length, 10);
    const expected = JSON.parse(fs.readFileSync(path.join(temporary, "expected.json"), "utf8"));
    assert.equal(expected.fixtures.length, 10);
    for (const [index, entry] of expected.fixtures.entries()) {
      const bytes = fs.readFileSync(path.join(temporary, entry.file));
      const exactBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      assert.equal(UTIF.decode(exactBuffer).length, 1);
      assert.deepEqual(entry.pixels, fixtures[index].pixels);
      assert.deepEqual(entry.percentages, fixtures[index].percentages);
      assert.equal(entry.status, fixtures[index].status);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
