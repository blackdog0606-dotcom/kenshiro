"use strict";

const BLACK_THRESHOLD = 20;
const REQUIRED_BLACK_PERCENT = 95;

/**
 * Detect continuous black bands touching the four edges of a source image.
 * RGB channels determine blackness; alpha is deliberately ignored.
 * Rows and columns are measured over the entire original image dimension.
 *
 * An ambiguous result must not be applied to an effect. In particular, an
 * all-black image has no identifiable content boundary and produces no crop.
 *
 * @param {{ width: number, height: number, data: Uint8Array|Uint8ClampedArray }} image
 * @returns {{status: string, reason?: string, width: number, height: number,
 *   pixels: {left: number, right: number, top: number, bottom: number},
 *   percentages: null|{left: number, right: number, top: number, bottom: number}}}
 */
function detectBlackBorders(image) {
  if (!image || typeof image !== "object") {
    throw new TypeError("An RGBA image is required.");
  }
  const { width, height, data } = image;
  if (!Number.isSafeInteger(width) || width < 1 ||
      !Number.isSafeInteger(height) || height < 1 ||
      !Number.isSafeInteger(width * height * 4)) {
    throw new RangeError("Image width and height must be positive safe integers.");
  }
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
    throw new TypeError("Image data must be an RGBA byte array.");
  }
  if (data.length !== width * height * 4) {
    throw new RangeError("RGBA data length must match width × height × 4.");
  }

  // Count exceptions, stopping as soon as a line cannot be a black border.
  // Integer arithmetic preserves the inclusive 95% boundary for short lines.
  function isBlackLine(offset, stride, length) {
    const allowedNonBlack = Math.floor(length * (100 - REQUIRED_BLACK_PERCENT) / 100);
    let nonBlack = 0;
    for (let i = 0; i < length; i++, offset += stride) {
      if (data[offset] > BLACK_THRESHOLD ||
          data[offset + 1] > BLACK_THRESHOLD ||
          data[offset + 2] > BLACK_THRESHOLD) {
        nonBlack++;
        if (nonBlack > allowedNonBlack) return false;
      }
    }
    return true;
  }

  let top = 0;
  while (top < height && isBlackLine(top * width * 4, 4, width)) top++;
  let bottom = 0;
  while (bottom < height && isBlackLine((height - 1 - bottom) * width * 4, 4, width)) bottom++;
  let left = 0;
  while (left < width && isBlackLine(left * 4, width * 4, height)) left++;
  let right = 0;
  while (right < width && isBlackLine((width - 1 - right) * 4, width * 4, height)) right++;

  const pixels = { left, right, top, bottom };
  if (left + right >= width || top + bottom >= height) {
    return { status: "ambiguous", reason: "no-content", width, height, pixels, percentages: null };
  }

  const percent = (count, dimension) => Math.round(count * 1000 / dimension) / 10;
  const percentages = {
    left: percent(left, width),
    right: percent(right, width),
    top: percent(top, height),
    bottom: percent(bottom, height)
  };
  // Rounding an extremely thin remaining strip can turn a valid pixel crop
  // into a 100% crop. Never silently turn that into a destructive effect.
  if (percentages.left + percentages.right >= 100 ||
      percentages.top + percentages.bottom >= 100) {
    return { status: "ambiguous", reason: "rounded-content-loss", width, height, pixels, percentages: null };
  }
  return { status: "ok", width, height, pixels, percentages };
}

module.exports = { detectBlackBorders, BLACK_THRESHOLD, REQUIRED_BLACK_PERCENT };
