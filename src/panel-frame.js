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
 * Four sides are mandatory by default. Opt-in partial mode accepts missing
 * sides only with verified white exterior margins on the detected sides.
 */
function detectPanelFrame(image, { partial = false } = {}) {
  const mode = partial ? "partial-frame" : MODE;
  if (!image || typeof image !== "object") throw new TypeError("An RGBA image is required.");
  const { width, height, data } = image;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 ||
      !Number.isSafeInteger(width * height * 4)) throw new RangeError("Invalid image dimensions.");
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
    throw new TypeError("Image data must be an RGBA byte array.");
  }
  if (data.length !== width * height * 4) throw new RangeError("RGBA data length does not match dimensions.");
  const skipped = (reason = "no-rectangular-frame") => ({
    status: "ambiguous", reason, mode, method: METHOD, width, height, pixels: null, percentages: null
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
  if (!partial && (!t || !b || !l || !r)) return skipped();
  if (!t && !b && !l && !r) return skipped();
  // Missing sides terminate at the source edge; they must never add a crop.
  const sides = { top: t, bottom: b, left: l, right: r };
  const tt = t || { outer: 0, inner: 0 };
  const bb = b || { outer: height, inner: height };
  const ll = l || { outer: 0, inner: 0 };
  const rr = r || { outer: width, inner: width };
  const outerBounds = { left: ll.outer, right: rr.outer, top: tt.outer, bottom: bb.outer };
  const innerBounds = { left: ll.inner, right: rr.inner, top: tt.inner, bottom: bb.inner };
  if (rr.outer - ll.outer < width * 0.5 || bb.outer - tt.outer < height * 0.5 ||
      rr.inner - ll.inner < width * 0.25 || bb.inner - tt.inner < height * 0.25) return skipped();

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
  if ((t && !verify(true, tt.outer, tt.inner, ll.outer, rr.outer)) ||
      (b && !verify(true, bb.inner, bb.outer, ll.outer, rr.outer)) ||
      (l && !verify(false, ll.outer, ll.inner, tt.outer, bb.outer)) ||
      (r && !verify(false, rr.inner, rr.outer, tt.outer, bb.outer))) return skipped();

  // In the opt-in partial mode, require a real white exterior margin on
  // every detected side. A black background touching an edge is not a frame.
  if (partial) {
    function whiteMargin(horizontal, start, end, alongStart, alongEnd) {
      if (end <= start) return false;
      let white = 0;
      const total = (end - start) * (alongEnd - alongStart);
      for (let across = start; across < end; across++) {
        for (let along = alongStart; along < alongEnd; along++) {
          const x = horizontal ? along : across;
          const y = horizontal ? across : along;
          const i = (y * width + x) * 4;
          if (data[i] >= 235 && data[i + 1] >= 235 && data[i + 2] >= 235) white++;
        }
      }
      return total > 0 && white * 100 >= total * 95;
    }
    if ((t && !whiteMargin(true, 0, tt.outer, ll.outer, rr.outer)) ||
        (b && !whiteMargin(true, bb.outer, height, ll.outer, rr.outer)) ||
        (l && !whiteMargin(false, 0, ll.outer, tt.outer, bb.outer)) ||
        (r && !whiteMargin(false, rr.outer, width, tt.outer, bb.outer))) return skipped("no-white-exterior-margin");
  }

  const pixels = { left: ll.inner, right: width - rr.inner, top: tt.inner, bottom: height - bb.inner };
  const percent = (count, size) => Math.round(count * 1000 / size) / 10;
  const percentages = {
    left: percent(pixels.left, width), right: percent(pixels.right, width),
    top: percent(pixels.top, height), bottom: percent(pixels.bottom, height)
  };
  if (percentages.left + percentages.right >= 100 || percentages.top + percentages.bottom >= 100) {
    return skipped("rounded-content-loss");
  }
  return {
    status: "ok", mode, method: METHOD, width, height, pixels, percentages,
    outerBounds, innerBounds,
    ...(partial ? { detectedSides: Object.keys(sides).filter(side => sides[side]) } : {}),
    bandWidths: { left: ll.inner - ll.outer, right: rr.outer - rr.inner, top: tt.inner - tt.outer, bottom: bb.outer - bb.inner }
  };
}

module.exports = { detectPanelFrame };
