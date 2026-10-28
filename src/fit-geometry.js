"use strict";

/**
 * Fit the cropped source rectangle inside a sequence without distorting it.
 * Crop percentages must be the rounded values actually written to Crop.
 * The returned position assumes Motion's anchor is the source image center.
 * Values are source/sequence pixels, independent of the host's point encoding.
 */
function calculateFit(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("Image, sequence and crop geometry are required.");
  }
  const { width, height, percentages, sequenceWidth, sequenceHeight } = options;
  for (const [name, value] of Object.entries({ width, height, sequenceWidth, sequenceHeight })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive finite number.`);
    }
  }
  if (!percentages || typeof percentages !== "object") {
    throw new TypeError("The applied Crop percentages are required.");
  }
  for (const side of ["left", "right", "top", "bottom"]) {
    const value = percentages[side];
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new RangeError(`Crop ${side} must be a finite percentage from 0 to 100.`);
    }
  }
  if (percentages.left + percentages.right >= 100 ||
      percentages.top + percentages.bottom >= 100) {
    throw new RangeError("The applied Crop must leave a positive content area.");
  }

  const contentWidth = width * (1 - (percentages.left + percentages.right) / 100);
  const contentHeight = height * (1 - (percentages.top + percentages.bottom) / 100);
  const scale = Math.min(sequenceWidth / contentWidth, sequenceHeight / contentHeight);
  const centerOffsetX = width * (percentages.left - percentages.right) / 200;
  const centerOffsetY = height * (percentages.top - percentages.bottom) / 200;
  const positionPixels = {
    x: sequenceWidth / 2 - centerOffsetX * scale,
    y: sequenceHeight / 2 - centerOffsetY * scale
  };
  const scalePercent = scale * 100;
  if (![contentWidth, contentHeight, scalePercent, positionPixels.x, positionPixels.y].every(Number.isFinite)) {
    throw new RangeError("Fit geometry exceeds the supported numeric range.");
  }
  return { scalePercent, positionPixels, contentWidth, contentHeight };
}

module.exports = { calculateFit };
