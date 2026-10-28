"use strict";

const MODE = "panel-frame";
const METHOD = "projected-frame-bands";
const BLACK = 20;
const SEARCH_FRACTION = 0.25;
const MAX_BAND_FRACTION = 0.03;

/**
 * Find a single, large rectangular panel frame inside exterior white margins.
 * RGB <= 20 remains the black threshold. A narrow side band must cover at
 * least 95% of its rectangle span: a coordinate is covered when that band
 * contains a black pixel. Projection tolerates a slightly skewed printed line.
 * All four sides are mandatory; uncertain images never fall back to edge crop.
 */
function detectPanelFrame(image) {
  if (!image || typeof image !== "object") throw new TypeError("An RGBA image is required.");
  const { width, height, data } = image;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 ||
      !Number.isSafeInteger(width * height * 4)) throw new RangeError("Invalid image dimensions.");
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
    throw new TypeError("Image data must be an RGBA byte array.");
  }
  if (data.length !== width * height * 4) throw new RangeError("RGBA data length does not match dimensions.");
  const skipped = (reason = "no-rectangular-frame") => ({
    status: "ambiguous", reason, mode: MODE, method: METHOD, width, height, pixels: null, percentages: null
  });
  if (width < 8 || height < 8) return skipped();
  const isBlack = (x, y) => {
    const i = (y * width + x) * 4;
    return data[i] <= BLACK && data[i + 1] <= BLACK && data[i + 2] <= BLACK;
  };
  const top = new Int32Array(width).fill(-1);
  const bottom = new Int32Array(width).fill(-1);
  const left = new Int32Array(height).fill(-1);
  const right = new Int32Array(height).fill(-1);
  const topLimit = Math.ceil(height * SEARCH_FRACTION);
  const bottomLimit = height - topLimit;
  const leftLimit = Math.ceil(width * SEARCH_FRACTION);
  const rightLimit = width - leftLimit;
  // One image pass, plus narrow-band verification below; no image-sized mask.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y >= topLimit && y < bottomLimit && x >= leftLimit && x < rightLimit) continue;
      if (!isBlack(x, y)) continue;
      if (y < topLimit && top[x] === -1) top[x] = y;
      if (y >= bottomLimit) bottom[x] = y;
      if (x < leftLimit && left[y] === -1) left[y] = x;
      if (x >= rightLimit) right[y] = x;
    }
  }

  function estimate(first, axisSize, horizontal, reverse) {
    const maximumBand = Math.max(2, Math.floor(axisSize * MAX_BAND_FRACTION));
    const histogram = new Int32Array(axisSize);
    for (const coordinate of first) if (coordinate >= 0) histogram[coordinate]++;
    let count = 0;
    let bestCount = 0;
    let bestEnd = -1;
    for (let end = 0; end < axisSize; end++) {
      count += histogram[end];
      if (end >= maximumBand) count -= histogram[end - maximumBand];
      if (count > bestCount) { bestCount = count; bestEnd = end; }
    }
    if (bestCount < first.length * 0.5) return null;
    const start = Math.max(0, bestEnd - maximumBand + 1);
    // Ignore rare isolated exterior marks inside the same search window.
    const quantile = (fraction) => {
      let sum = 0;
      for (let coordinate = start; coordinate <= bestEnd; coordinate++) {
        sum += histogram[coordinate];
        if (sum >= bestCount * fraction) return coordinate;
      }
      return bestEnd;
    };
    const low = quantile(0.01);
    const high = quantile(0.99);
    const thicknesses = [];
    const direction = reverse ? -1 : 1;
    for (let along = 0; along < first.length; along++) {
      const coordinate = first[along];
      if (coordinate < low || coordinate > high) continue;
      let lastBlack = 0;
      let whites = 0;
      for (let step = 0; step <= maximumBand; step++) {
        const across = coordinate + step * direction;
        if (across < 0 || across >= axisSize) break;
        const black = horizontal ? isBlack(along, across) : isBlack(across, along);
        if (black) { lastBlack = step + 1; whites = 0; }
        else if (++whites >= 2) break;
      }
      thicknesses.push(lastBlack);
    }
    thicknesses.sort((a, b) => a - b);
    const thickness = thicknesses[Math.floor(thicknesses.length / 2)];
    if (!thickness || high - low + thickness > maximumBand) return null;
    return reverse
      ? { outer: high + 1, inner: low - thickness + 1 }
      : { outer: low, inner: high + thickness };
  }

  const t = estimate(top, height, true, false);
  const b = estimate(bottom, height, true, true);
  const l = estimate(left, width, false, false);
  const r = estimate(right, width, false, true);
  if (!t || !b || !l || !r) return skipped();
  const outerBounds = { left: l.outer, right: r.outer, top: t.outer, bottom: b.outer };
  const innerBounds = { left: l.inner, right: r.inner, top: t.inner, bottom: b.inner };
  if (r.outer - l.outer < width * 0.5 || b.outer - t.outer < height * 0.5 ||
      r.inner - l.inner < width * 0.25 || b.inner - t.inner < height * 0.25) return skipped();

  // Check a thin projected side, and also require a genuinely straight line:
  // either >=90% coverage on one row/column or a continuous run >=10% long.
  // This guards against treating noisy artwork near four edges as a frame.
  function verify(horizontal, acrossStart, acrossEnd, alongStart, alongEnd) {
    const span = alongEnd - alongStart;
    if (span <= 0 || acrossEnd <= acrossStart) return false;
    let covered = 0;
    const coverage = new Uint8Array(span);
    let straight = false;
    for (let across = acrossStart; across < acrossEnd; across++) {
      let lineBlack = 0;
      let run = 0;
      let longest = 0;
      for (let along = alongStart; along < alongEnd; along++) {
        const black = horizontal ? isBlack(along, across) : isBlack(across, along);
        if (black) {
          lineBlack++;
          longest = Math.max(longest, ++run);
          coverage[along - alongStart] = 1;
        } else run = 0;
      }
      if (lineBlack * 100 >= span * 90 || longest * 10 >= span) straight = true;
    }
    for (const value of coverage) covered += value;
    return covered * 100 >= span * 95 && straight;
  }
  if (!verify(true, t.outer, t.inner, l.outer, r.outer) ||
      !verify(true, b.inner, b.outer, l.outer, r.outer) ||
      !verify(false, l.outer, l.inner, t.outer, b.outer) ||
      !verify(false, r.inner, r.outer, t.outer, b.outer)) return skipped();

  const pixels = { left: l.inner, right: width - r.inner, top: t.inner, bottom: height - b.inner };
  const percent = (count, size) => Math.round(count * 1000 / size) / 10;
  const percentages = {
    left: percent(pixels.left, width), right: percent(pixels.right, width),
    top: percent(pixels.top, height), bottom: percent(pixels.bottom, height)
  };
  if (percentages.left + percentages.right >= 100 || percentages.top + percentages.bottom >= 100) {
    return skipped("rounded-content-loss");
  }
  return {
    status: "ok", mode: MODE, method: METHOD, width, height, pixels, percentages,
    outerBounds, innerBounds,
    bandWidths: { left: l.inner - l.outer, right: r.outer - r.inner, top: t.inner - t.outer, bottom: b.outer - b.inner }
  };
}

module.exports = { detectPanelFrame };
