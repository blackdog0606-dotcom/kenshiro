"use strict";

const WIDTH = 1000;
const HEIGHT = 800;

function fill(data, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * WIDTH + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
}

function imageWithFrame({ outer, thickness, color = [0, 0, 0], grayscale = false,
  noFrame = false, missingRight = false, stray = false, gap = false }) {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  data.fill(255);
  const inner = {
    left: outer.left + thickness.left,
    right: outer.right - thickness.right,
    top: outer.top + thickness.top,
    bottom: outer.bottom - thickness.bottom,
  };
  // Original geometric drawings: all inset from the frame, with no black row
  // or column adjacent to it. These are not derived from a supplied manga scan.
  const middleX = Math.floor((inner.left + inner.right) / 2);
  const middleY = Math.floor((inner.top + inner.bottom) / 2);
  fill(data, inner.left + 65, inner.top + 70, middleX - 25, middleY + 35,
    grayscale ? [170, 170, 170] : [62, 139, 190]);
  fill(data, middleX + 40, middleY - 80, inner.right - 75, inner.bottom - 85,
    grayscale ? [100, 100, 100] : [224, 142, 63]);
  fill(data, inner.left + 90, inner.bottom - 65, inner.right - 90, inner.bottom - 60,
    [12, 12, 12]);
  if (!noFrame) {
    fill(data, outer.left, outer.top, outer.right, inner.top, color);
    fill(data, outer.left, inner.bottom, outer.right, outer.bottom, color);
    fill(data, outer.left, inner.top, inner.left, inner.bottom, color);
    if (!missingRight) fill(data, inner.right, inner.top, outer.right, inner.bottom, color);
  }
  if (stray) fill(data, 975, 300, 981, 501, [0, 0, 0]);
  if (gap) fill(data, inner.right, 390, outer.right, 410, [255, 255, 255]);
  return data;
}

/**
 * Exactly ten original TIFF inputs. Expected crop numbers are independent
 * literal values: each includes the outer white margin plus black frame.
 * This module never imports the detector and performs no I/O when imported.
 */
function createFixtures() {
  const standardOuter = { left: 80, right: 920, top: 60, bottom: 740 };
  const standardThickness = { left: 10, right: 10, top: 10, bottom: 10 };
  const definitions = [
    {
      name: "01-white-margin-and-frame", outer: standardOuter, thickness: standardThickness,
      pixels: { left: 90, right: 90, top: 70, bottom: 70 },
      percentages: { left: 9, right: 9, top: 8.8, bottom: 8.8 },
    },
    {
      name: "02-asymmetric-margin-and-frame",
      outer: { left: 43, right: 958, top: 31, bottom: 769 },
      thickness: { left: 7, right: 13, top: 9, bottom: 11 },
      pixels: { left: 50, right: 55, top: 40, bottom: 42 },
      percentages: { left: 5, right: 5.5, top: 5, bottom: 5.3 },
    },
    {
      name: "03-thin-frame",
      outer: { left: 100, right: 900, top: 80, bottom: 720 },
      thickness: { left: 2, right: 2, top: 2, bottom: 2 },
      pixels: { left: 102, right: 102, top: 82, bottom: 82 },
      percentages: { left: 10.2, right: 10.2, top: 10.3, bottom: 10.3 },
    },
    {
      name: "04-thick-frame",
      outer: { left: 30, right: 970, top: 40, bottom: 760 },
      thickness: { left: 20, right: 20, top: 20, bottom: 20 },
      pixels: { left: 50, right: 50, top: 60, bottom: 60 },
      percentages: { left: 5, right: 5, top: 7.5, bottom: 7.5 },
    },
    {
      name: "05-grayscale-drawing",
      outer: { left: 120, right: 880, top: 70, bottom: 730 },
      thickness: { left: 8, right: 8, top: 8, bottom: 8 }, grayscale: true,
      pixels: { left: 128, right: 128, top: 78, bottom: 78 },
      percentages: { left: 12.8, right: 12.8, top: 9.8, bottom: 9.8 },
    },
    {
      name: "06-rgb20-frame",
      outer: { left: 51, right: 949, top: 41, bottom: 759 },
      thickness: { left: 9, right: 9, top: 9, bottom: 9 }, color: [20, 20, 20],
      pixels: { left: 60, right: 60, top: 50, bottom: 50 },
      percentages: { left: 6, right: 6, top: 6.3, bottom: 6.3 },
    },
    {
      name: "07-stray-ink-outside-right", outer: standardOuter, thickness: standardThickness, stray: true,
      pixels: { left: 90, right: 90, top: 70, bottom: 70 },
      percentages: { left: 9, right: 9, top: 8.8, bottom: 8.8 },
      note: "A separate short black stroke outside the right frame must not move the frame boundary.",
    },
    {
      name: "08-right-frame-gap-under5percent", outer: standardOuter, thickness: standardThickness, gap: true,
      pixels: { left: 90, right: 90, top: 70, bottom: 70 },
      percentages: { left: 9, right: 9, top: 8.8, bottom: 8.8 },
      note: "The right frame has a 20px gap; more than 95% of that side remains black.",
    },
    {
      name: "09-no-frame-skip", outer: standardOuter, thickness: standardThickness, noFrame: true,
      status: "ambiguous", pixels: null, percentages: null,
      note: "Skip: drawings on a white page without a complete surrounding frame.",
    },
    {
      name: "10-three-sided-frame-skip", outer: standardOuter, thickness: standardThickness, missingRight: true,
      status: "ambiguous", pixels: null, percentages: null,
      note: "Skip: top, bottom and left exist, but the right frame is missing.",
    },
  ];
  return definitions.map((definition) => {
    const { outer, thickness, color, grayscale, noFrame, missingRight, stray, gap, ...description } = definition;
    return {
      width: WIDTH, height: HEIGHT, status: "ok", ...description,
      data: imageWithFrame({ outer, thickness, color, grayscale, noFrame, missingRight, stray, gap }),
    };
  });
}

if (require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const UTIF = require("utif");
  if (process.argv.length > 3) throw new Error("Usage: node scripts/create-panel-samples.js [output-directory]");
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..", "test-panels");
  const fixtures = createFixtures();
  const names = new Set(fixtures.map(({ name }) => `${name}.tif`));
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).some((name) => /\.tiff?$/i.test(name) && !names.has(name))) {
    throw new Error("出力先に別のTIFFがあります。別の出力フォルダーを指定してください。");
  }
  const expected = [];
  for (const fixture of fixtures) {
    const { data, ...description } = fixture;
    const file = `${fixture.name}.tif`;
    fs.writeFileSync(path.join(directory, file), Buffer.from(UTIF.encodeImage(data.buffer, fixture.width, fixture.height)));
    expected.push({ file, ...description });
  }
  fs.writeFileSync(path.join(directory, "expected.json"), `${JSON.stringify({
    mode: "white-margin-and-rectangular-black-panel-frame",
    criteria: { blackRgbMaximum: 20, minimumBlackPercentPerSide: 95, roundingPercent: 0.1 },
    fixtures: expected,
  }, null, 2)}\n`);
  console.log(`Created 10 single-page TIFFs and expected.json in ${directory}`);
  console.log("01–08: remove the white margin and black rectangular frame; 09–10: skip.");
}

module.exports = { createFixtures };
