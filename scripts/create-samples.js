"use strict";

const fs = require("node:fs");
const path = require("node:path");
const UPNG = require("upng-js");
const UTIF = require("utif");

const WIDTH = 1000;
const HEIGHT = 800;
const ZERO = { left: 0, right: 0, top: 0, bottom: 0 };

function setPixel(data, x, y, color) {
  const offset = (y * WIDTH + x) * 4;
  data[offset] = color[0];
  data[offset + 1] = color[1];
  data[offset + 2] = color[2];
  data[offset + 3] = 255;
}

function artwork() {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let color = [242, 239, 231];
      if (x % 100 < 2 || y % 100 < 2) color = [192, 204, 213];
      const dx = (x - 430) / 200;
      const dy = (y - 360) / 200;
      if (dx * dx + dy * dy < 1) color = [48, 132, 167];
      if (x >= 590 && x < 770 && y >= 250 && y < 530) color = [217, 125, 62];
      if (y >= 600 && y < 620 && x >= 200 && x < 800) color = [105, 145, 92];
      setPixel(data, x, y, color);
    }
  }
  return data;
}

function withBorder(pixels, color = [0, 0, 0]) {
  const data = artwork();
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (x < pixels.left || x >= WIDTH - pixels.right ||
          y < pixels.top || y >= HEIGHT - pixels.bottom) {
        setPixel(data, x, y, color);
      }
    }
  }
  return data;
}

/**
 * Ten deterministic, original source images and independently specified
 * expected values. This generator never imports or calls the detector.
 */
function createFixtures() {
  const definitions = [
    { name: "01-no-border", pixels: { ...ZERO }, percentages: { ...ZERO } },
    { name: "02-symmetric", pixels: { left: 20, right: 20, top: 16, bottom: 16 },
      percentages: { left: 2, right: 2, top: 2, bottom: 2 } },
    { name: "03-left-only", pixels: { ...ZERO, left: 9 },
      percentages: { ...ZERO, left: 0.9 } },
    { name: "04-right-only", pixels: { ...ZERO, right: 13 },
      percentages: { ...ZERO, right: 1.3 } },
    { name: "05-top-rounding-down", pixels: { ...ZERO, top: 9 },
      percentages: { ...ZERO, top: 1.1 } },
    { name: "06-bottom-rounding-up", pixels: { ...ZERO, bottom: 11 },
      percentages: { ...ZERO, bottom: 1.4 } },
    { name: "07-asymmetric", pixels: { left: 7, right: 13, top: 9, bottom: 11 },
      percentages: { left: 0.7, right: 1.3, top: 1.1, bottom: 1.4 } },
    { name: "08-rgb20-inclusive", pixels: { left: 7, right: 11, top: 5, bottom: 13 },
      percentages: { left: 0.7, right: 1.1, top: 0.6, bottom: 1.6 }, color: [20, 20, 20] }
  ];
  const fixtures = definitions.map(({ color, ...definition }) => ({
    ...definition, width: WIDTH, height: HEIGHT, status: "ok",
    data: withBorder(definition.pixels, color)
  }));

  // Rows 0..7 contain exactly 950/1000 black pixels and must be cropped.
  // Row 8 contains 949/1000 and must stop the top scan. The exceptions lie
  // in columns 0..50; every column remains mostly colored, so no side crop.
  const threshold = artwork();
  for (let y = 0; y <= 8; y++) {
    const coloredCount = y === 8 ? 51 : 50;
    for (let x = coloredCount; x < WIDTH; x++) setPixel(threshold, x, y, [20, 20, 20]);
  }
  fixtures.push({
    name: "09-exactly95-percent", width: WIDTH, height: HEIGHT,
    status: "ok", pixels: { ...ZERO, top: 8 }, percentages: { ...ZERO, top: 1 },
    note: "Top 8 rows are 95.0% black; row 9 is 94.9% black and stops detection.",
    data: threshold
  });

  const allBlack = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let offset = 3; offset < allBlack.length; offset += 4) allBlack[offset] = 255;
  fixtures.push({
    name: "10-all-black-skip", width: WIDTH, height: HEIGHT,
    status: "ambiguous", reason: "no-content",
    pixels: { left: WIDTH, right: WIDTH, top: HEIGHT, bottom: HEIGHT },
    percentages: null, note: "Skip: no identifiable content; never apply a 100% Crop.", data: allBlack
  });
  return fixtures;
}

function writeFixtures(directory, format = "png") {
  if (!["png", "tiff"].includes(format)) throw new Error("Sample format must be png or tiff.");
  directory ??= path.join(__dirname, "..", format === "tiff" ? "test-images-tiff" : "test-images");
  fs.mkdirSync(directory, { recursive: true });
  const expected = [];
  for (const fixture of createFixtures()) {
    const { data, ...description } = fixture;
    const file = `${fixture.name}.${format === "tiff" ? "tif" : "png"}`;
    const encoded = format === "tiff"
      ? UTIF.encodeImage(data.buffer, fixture.width, fixture.height)
      : UPNG.encode([data.buffer], fixture.width, fixture.height, 0);
    fs.writeFileSync(path.join(directory, file), Buffer.from(encoded));
    expected.push({ file, ...description });
  }
  fs.writeFileSync(path.join(directory, "expected.json"), `${JSON.stringify({
    criteria: { blackRgbMaximum: 20, minimumBlackPercentPerLine: 95, roundingPercent: 0.1 },
    fixtures: expected
  }, null, 2)}\n`);
  return { directory, count: expected.length, format };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--tiff")) {
    throw new Error("Usage: node scripts/create-samples.js [--tiff]");
  }
  const result = writeFixtures(undefined, args[0] === "--tiff" ? "tiff" : "png");
  const label = result.format === "tiff" ? "TIFF" : "PNG";
  console.log(`Created ${result.count} ${label} source images and expected.json in ${result.directory}`);
  console.log(`Import the 10 ${label}s into Premiere, place them on a timeline and select them for testing.`);
  console.log("01 has no border; 02–09 have known borders; 10 must be skipped as all-black.");
}

module.exports = { createFixtures, writeFixtures };
