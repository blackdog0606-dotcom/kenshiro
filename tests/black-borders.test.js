"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectBlackBorders, BLACK_THRESHOLD, REQUIRED_BLACK_PERCENT } = require("../src/black-borders.js");

function image(width, height, rgb = [255, 255, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data.set([...rgb, 255], i);
  }
  return { width, height, data };
}

function pixel(img, x, y, rgb, alpha = 255) {
  img.data.set([...rgb, alpha], (y * img.width + x) * 4);
}

function row(img, y, rgb) {
  for (let x = 0; x < img.width; x++) pixel(img, x, y, rgb);
}

function column(img, x, rgb) {
  for (let y = 0; y < img.height; y++) pixel(img, x, y, rgb);
}

test("default thresholds match the requested inclusive RGB 20 and 95%", () => {
  assert.equal(BLACK_THRESHOLD, 20);
  assert.equal(REQUIRED_BLACK_PERCENT, 95);
  const img = image(20, 20);
  row(img, 0, [20, 20, 20]);
  pixel(img, 0, 0, [255, 255, 255]);
  assert.equal(detectBlackBorders(img).pixels.top, 1, "19/20 black qualifies");
  pixel(img, 1, 0, [20, 20, 21]);
  assert.equal(detectBlackBorders(img).pixels.top, 0, "18/20 black does not qualify");
});

test("any RGB channel exceeding 20 is nonblack", () => {
  for (const rgb of [[21, 0, 0], [0, 21, 0], [0, 0, 21]]) {
    const img = image(10, 10);
    row(img, 0, rgb);
    assert.equal(detectBlackBorders(img).pixels.top, 0);
  }
});

test("detects asymmetric consecutive borders on all edges", () => {
  const img = image(100, 80);
  for (let y = 0; y < 3; y++) row(img, y, [0, 0, 0]);
  for (let y = 78; y < 80; y++) row(img, y, [0, 0, 0]);
  for (let x = 0; x < 4; x++) column(img, x, [0, 0, 0]);
  for (let x = 93; x < 100; x++) column(img, x, [0, 0, 0]);
  const result = detectBlackBorders(img);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.pixels, { left: 4, right: 7, top: 3, bottom: 2 });
  assert.deepEqual(result.percentages, { left: 4, right: 7, top: 3.8, bottom: 2.5 });
});

test("each scan stops at the first nonblack line and ignores interior lines", () => {
  const img = image(40, 40);
  row(img, 0, [0, 0, 0]);
  row(img, 2, [0, 0, 0]);
  row(img, 20, [0, 0, 0]);
  row(img, 39, [0, 0, 0]);
  column(img, 0, [0, 0, 0]);
  column(img, 2, [0, 0, 0]);
  column(img, 20, [0, 0, 0]);
  column(img, 39, [0, 0, 0]);
  assert.deepEqual(detectBlackBorders(img).pixels, { left: 1, right: 1, top: 1, bottom: 1 });
});

test("the 95% condition is also inclusive for columns", () => {
  const img = image(20, 20);
  column(img, 19, [20, 20, 20]);
  pixel(img, 19, 10, [21, 0, 0]);
  assert.equal(detectBlackBorders(img).pixels.right, 1);
  pixel(img, 19, 11, [21, 0, 0]);
  assert.equal(detectBlackBorders(img).pixels.right, 0);
});

test("rounds source-dimension percentages to nearest 0.1%", () => {
  const img = image(1920, 1080);
  for (let x = 0; x < 7; x++) column(img, x, [0, 0, 0]);
  for (let y = 0; y < 13; y++) row(img, y, [0, 0, 0]);
  assert.deepEqual(detectBlackBorders(img).percentages, { left: 0.4, right: 0, top: 1.2, bottom: 0 });
});

test("no border returns zero without inventing crops", () => {
  const img = image(12, 8);
  const result = detectBlackBorders(img);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.pixels, { left: 0, right: 0, top: 0, bottom: 0 });
  assert.deepEqual(result.percentages, { left: 0, right: 0, top: 0, bottom: 0 });
});

test("all-black or overlapping bands are ambiguous and cannot be applied", () => {
  const result = detectBlackBorders(image(20, 30, [20, 20, 20]));
  assert.equal(result.status, "ambiguous");
  assert.equal(result.reason, "no-content");
  assert.equal(result.percentages, null);
});

test("a tiny remaining strip lost by percentage rounding is ambiguous", () => {
  const img = image(3000, 100, [0, 0, 0]);
  column(img, 1500, [255, 255, 255]);
  row(img, 50, [255, 255, 255]);
  const result = detectBlackBorders(img);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.reason, "rounded-content-loss");
  assert.deepEqual(result.pixels, { left: 1500, right: 1499, top: 50, bottom: 49 });
  assert.equal(result.percentages, null);
});

test("small dimensions need every pixel black when fewer than 20 pixels", () => {
  const img = image(19, 3);
  row(img, 0, [0, 0, 0]);
  pixel(img, 0, 0, [21, 0, 0]);
  assert.equal(detectBlackBorders(img).pixels.top, 0);
  pixel(img, 0, 0, [20, 20, 20]);
  assert.equal(detectBlackBorders(img).pixels.top, 1);
});

test("1×1 white is valid and 1×1 black has no identifiable content", () => {
  assert.equal(detectBlackBorders(image(1, 1)).status, "ok");
  assert.equal(detectBlackBorders(image(1, 1, [0, 0, 0])).reason, "no-content");
});

test("alpha does not change RGB-based classification", () => {
  const img = image(10, 10);
  for (let x = 0; x < 10; x++) pixel(img, x, 0, [0, 0, 0], 0);
  assert.equal(detectBlackBorders(img).pixels.top, 1);
});

test("accepts clamped RGBA buffers and views with nonzero byte offset", () => {
  const img = image(3, 3);
  const backing = new Uint8ClampedArray(img.data.length + 12);
  const data = backing.subarray(4, 4 + img.data.length);
  data.set(img.data);
  assert.equal(detectBlackBorders({ ...img, data }).status, "ok");
});

test("rejects malformed source dimensions and buffers", () => {
  assert.throws(() => detectBlackBorders(null), TypeError);
  for (const width of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => detectBlackBorders({ width, height: 2, data: new Uint8Array(8) }), RangeError);
  }
  assert.throws(() => detectBlackBorders({ width: 2, height: 2, data: [] }), TypeError);
  assert.throws(() => detectBlackBorders({ width: 2, height: 2, data: new Uint8Array(15) }), RangeError);
  assert.throws(() => detectBlackBorders({ width: 2, height: 2, data: new Float32Array(16) }), TypeError);
});
