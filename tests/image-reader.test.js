const test = require('node:test');
const assert = require('node:assert/strict');
const jpeg = require('jpeg-js');
const UPNG = require('upng-js');
const UTIF = require('utif');
// UTIF's small encoder schema omits the standard SHORT Predictor tag even
// though its decoder supports it. Register it to build a real predictor fixture.
UTIF.ttypes[317] = 3;
const { decodeImage } = require('../src/image-reader');

function pixels(width = 4, height = 3) {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set([200, 150, 80, 255], offset);
  }
  return { width, height, data };
}

function pngBytes(image = pixels()) {
  return new Uint8Array(UPNG.encode([image.data.buffer], image.width, image.height, 0));
}

function jpegBytes(image = pixels()) {
  return new Uint8Array(jpeg.encode(image, 100).data);
}

function withExif(input, orientation, littleEndian = true) {
  const payload = new Uint8Array(32);
  payload.set([69, 120, 105, 102, 0, 0]);
  const view = new DataView(payload.buffer);
  view.setUint16(6, littleEndian ? 0x4949 : 0x4d4d);
  view.setUint16(8, 42, littleEndian);
  view.setUint32(10, 8, littleEndian);
  view.setUint16(14, 1, littleEndian);
  view.setUint16(16, 0x0112, littleEndian);
  view.setUint16(18, 3, littleEndian);
  view.setUint32(20, 1, littleEndian);
  view.setUint16(24, orientation, littleEndian);
  const output = new Uint8Array(input.length + payload.length + 4);
  output.set(input.subarray(0, 2));
  output.set([0xff, 0xe1, 0, payload.length + 2], 2);
  output.set(payload, 6);
  output.set(input.subarray(2), 6 + payload.length);
  return output;
}

test('PNG decodes original dimensions and exact RGBA without canvas', () => {
  const image = pixels();
  image.data.set([20, 21, 22, 140], 4);
  const result = decodeImage(pngBytes(image), '.PNG');
  assert.equal(result.width, image.width);
  assert.equal(result.height, image.height);
  assert.deepEqual(result.data, image.data);
});

test('JPEG decodes into an RGBA typed array', () => {
  const result = decodeImage(jpegBytes(), 'jpeg');
  assert.equal(result.width, 4);
  assert.equal(result.height, 3);
  assert.ok(result.data instanceof Uint8Array);
  assert.equal(result.data.length, 4 * 3 * 4);
  assert.equal(result.data[3], 255);
  assert.ok(Math.abs(result.data[0] - 200) <= 3);
});

test('subarray byte offsets do not expose unrelated bytes to the decoders', () => {
  for (const input of [pngBytes(), jpegBytes()]) {
    const padded = new Uint8Array(input.length + 13);
    padded.fill(99);
    padded.set(input, 5);
    assert.equal(decodeImage(padded.subarray(5, input.length + 5)).width, 4);
  }
});

test('ArrayBuffer input is supported', () => {
  assert.equal(decodeImage(pngBytes().buffer).height, 3);
});

test('content signatures and extensions must agree', () => {
  assert.throws(() => decodeImage(jpegBytes(), 'png'), /拡張子が一致/);
  assert.throws(() => decodeImage(pngBytes(), 'jpg'), /拡張子が一致/);
  assert.throws(() => decodeImage(pngBytes(), 'tif'), /拡張子が一致/);
  assert.throws(() => decodeImage(pngBytes(), 'gif'), /PNG・JPEG・TIFF/);
  assert.throws(() => decodeImage(new Uint8Array([1, 2, 3])), /PNG・JPEG/);
  assert.throws(() => decodeImage('not bytes'), /バイナリ/);
});

test('PNG size guard runs before attempting decompression', () => {
  const huge = pngBytes();
  new DataView(huge.buffer).setUint32(16, 20_001);
  assert.throws(() => decodeImage(huge), /20,000px/);
  new DataView(huge.buffer).setUint32(16, 10_000);
  new DataView(huge.buffer).setUint32(20, 4_001);
  assert.throws(() => decodeImage(huge), /4,000万画素/);
  new DataView(huge.buffer).setUint32(16, 0);
  assert.throws(() => decodeImage(huge), /サイズを読み取れません/);
});

test('JPEG size guard runs before attempting decompression', () => {
  const huge = jpegBytes();
  let sof = -1;
  for (let index = 0; index < huge.length - 1; index++) {
    if (huge[index] === 0xff && huge[index + 1] === 0xc0) { sof = index; break; }
  }
  assert.notEqual(sof, -1);
  const view = new DataView(huge.buffer);
  view.setUint16(sof + 7, 20_001);
  assert.throws(() => decodeImage(huge), /20,000px/);
});

test('animated PNG is rejected before decoding', () => {
  const input = pngBytes();
  const output = new Uint8Array(input.length + 20);
  output.set(input.subarray(0, 33));
  const view = new DataView(output.buffer);
  view.setUint32(33, 8);
  output.set([97, 99, 84, 76], 37);
  view.setUint32(41, 2);
  output.set(input.subarray(33), 53);
  assert.throws(() => decodeImage(output), /アニメーションPNG/);
});

test('normal EXIF orientation is accepted in either byte order', () => {
  for (const littleEndian of [true, false]) {
    assert.equal(decodeImage(withExif(jpegBytes(), 1, littleEndian)).width, 4);
  }
});

test('all non-normal EXIF orientations are rejected with an actionable message', () => {
  for (const littleEndian of [true, false]) {
    for (let orientation = 2; orientation <= 8; orientation++) {
      assert.throws(() => decodeImage(withExif(jpegBytes(), orientation, littleEndian)), /向きを確定/);
    }
  }
});

test('malformed EXIF and truncated image structures report errors', () => {
  const exif = withExif(jpegBytes(), 1);
  new DataView(exif.buffer).setUint32(16, 0xffff_ffff, true);
  assert.throws(() => decodeImage(exif), /EXIF位置/);
  assert.throws(() => decodeImage(pngBytes().subarray(0, 20)), /途中で切れ/);
  assert.throws(() => decodeImage(pngBytes().subarray(0, 34)), /途中で切れ|長さが不正/);
  assert.throws(() => decodeImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 100])), /長さが不正/);
  assert.throws(() => decodeImage(jpegBytes().subarray(0, 12)), /長さが不正/);
});

function tiffBytes(image = pixels(), metadata = {}) {
  return new Uint8Array(UTIF.encodeImage(image.data, image.width, image.height, metadata));
}

function greyTiff(data, metadata = {}) {
  return tiffBytes({ width: data.length, height: 1, data }, {
    t258: [8], t262: [1], t277: [1], t279: [data.length], ...metadata,
  });
}

function shortLzw(codes) {
  const result = new Uint8Array(Math.ceil(codes.length * 9 / 8));
  let position = 0;
  for (const code of codes) {
    for (let bit = 8; bit >= 0; bit--, position++) {
      result[position >>> 3] |= ((code >>> bit) & 1) << (7 - (position & 7));
    }
  }
  return result;
}

test('TIFF RGB/RGBA fixture decodes original dimensions and exact pixels', () => {
  const image = pixels();
  const encoded = tiffBytes(image);
  const decoded = decodeImage(encoded, '.TIFF');
  assert.equal(decoded.width, image.width);
  assert.equal(decoded.height, image.height);
  assert.deepEqual(decoded.data, image.data);
  const padded = new Uint8Array(encoded.length + 9);
  padded.set(encoded, 4);
  assert.deepEqual(decodeImage(padded.subarray(4, encoded.length + 4), 'tif'), decoded);
});

test('TIFF 8bit grayscale expands to exact RGB values, including the black threshold', () => {
  const data = new Uint8Array([0, 20, 21, 255]);
  const result = decodeImage(greyTiff(data));
  assert.equal(result.width, 4);
  assert.deepEqual(Array.from(result.data), [0, 0, 0, 255, 20, 20, 20, 255,
    21, 21, 21, 255, 255, 255, 255, 255]);
  const whiteIsZero = decodeImage(greyTiff(data, { t262: [0] }));
  assert.deepEqual(Array.from(whiteIsZero.data.subarray(0, 4)), [255, 255, 255, 255]);
  assert.deepEqual(Array.from(whiteIsZero.data.subarray(12)), [0, 0, 0, 255]);
});

test('TIFF LZW plus horizontal predictor expands grayscale correctly', () => {
  const encoded = shortLzw([256, 10, 10, 10, 10, 257]);
  const input = tiffBytes({ width: 4, height: 1, data: encoded }, {
    t258: [8], t262: [1], t277: [1], t259: [5], t279: [encoded.length], t317: [2],
  });
  assert.deepEqual(Array.from(decodeImage(input).data.filter((_, index) => index % 4 === 0)), [10, 20, 30, 40]);
});

test('TIFF PackBits expands literal and repeated grayscale samples', () => {
  const encoded = new Uint8Array([1, 10, 20, 255, 50]);
  const input = tiffBytes({ width: 4, height: 1, data: encoded }, {
    t258: [8], t262: [1], t277: [1], t259: [32773], t279: [encoded.length],
  });
  assert.deepEqual(Array.from(decodeImage(input).data.filter((_, index) => index % 4 === 0)), [10, 20, 50, 50]);
});

test('TIFF little-endian header and inline IFD values are supported', () => {
  // Minimal little-endian, 8bit grayscale, one uncompressed strip.
  const entries = [[256, 3, 3], [257, 3, 1], [258, 3, 8], [259, 3, 1],
    [262, 3, 1], [273, 4, 122], [277, 3, 1], [278, 4, 1], [279, 4, 3]];
  const bytes = new Uint8Array(125);
  bytes.set([73, 73, 42, 0, 8, 0, 0, 0]);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, value], index) => {
    const offset = 10 + index * 12;
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, 1, true);
    if (type === 3) view.setUint16(offset + 8, value, true);
    else view.setUint32(offset + 8, value, true);
  });
  bytes.set([0, 20, 255], 122);
  assert.deepEqual(Array.from(decodeImage(bytes).data), [0, 0, 0, 255, 20, 20, 20, 255, 255, 255, 255, 255]);
});

test('TIFF source size guard runs before allocating decoded pixels', () => {
  assert.throws(() => decodeImage(tiffBytes(pixels(), { t256: [20_001] })), /20,000px/);
  assert.throws(() => decodeImage(tiffBytes(pixels(), { t256: [10_000], t257: [4_001] })), /4,000万画素/);
  assert.throws(() => decodeImage(tiffBytes(pixels(), { t256: [0] })), /サイズを読み取れません/);
});

test('TIFF multipage, BigTIFF, rotated, unsupported color and compression return actionable errors', () => {
  assert.throws(() => decodeImage(UTIF.encode([{ t256: [1] }, { t256: [1] }])), /複数ページ/);
  assert.throws(() => decodeImage(new Uint8Array([73, 73, 43, 0, 8, 0, 0, 0])), /BigTIFF/);
  assert.throws(() => decodeImage(tiffBytes(pixels(), { t274: [6] })), /向きを確定/);
  assert.throws(() => decodeImage(tiffBytes(pixels(), { t262: [5] })), /CMYK/);
  assert.throws(() => decodeImage(tiffBytes(pixels(), { t258: [16, 16, 16, 16] })), /16bit/);
  assert.throws(() => decodeImage(tiffBytes(pixels(), { t284: [2] })), /分離チャンネル/);
  assert.throws(() => decodeImage(tiffBytes(pixels(), { t259: [7] })), /圧縮形式/);
});

test('damaged TIFF metadata, cyclic EXIF and truncated strips fail before decode loops', () => {
  assert.throws(() => decodeImage(new Uint8Array([73, 73, 42, 0])), /途中で切れ/);
  assert.throws(() => decodeImage(tiffBytes(pixels(), { t34665: [8] })), /循環/);
  const truncated = tiffBytes().subarray(0, 1002);
  assert.throws(() => decodeImage(truncated), /途中で切れ/);
  const invalidIfd = tiffBytes();
  new DataView(invalidIfd.buffer).setUint32(4, invalidIfd.length);
  assert.throws(() => decodeImage(invalidIfd), /IFD位置/);
});

test('damaged LZW and PackBits TIFF streams reject incomplete or excessive output', () => {
  for (const encoded of [shortLzw([256, 10, 10, 10, 10]), shortLzw([256, 10, 10, 257]),
    shortLzw([256, 10, 10, 10, 10, 10, 257])]) {
    const input = tiffBytes({ width: 4, height: 1, data: encoded }, {
      t258: [8], t262: [1], t277: [1], t259: [5], t279: [encoded.length],
    });
    assert.throws(() => decodeImage(input), /LZW/);
  }
  const encoded = new Uint8Array([1, 10]);
  const input = tiffBytes({ width: 4, height: 1, data: encoded }, {
    t258: [8], t262: [1], t277: [1], t259: [32773], t279: [encoded.length],
  });
  assert.throws(() => decodeImage(input), /PackBits/);
});

test('supplied 25-142-4.tif matches independently decoded Pillow RGBA', {
  skip: !process.env.BLACK_CROP_SAMPLE_TIFF,
}, () => {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const image = decodeImage(fs.readFileSync(process.env.BLACK_CROP_SAMPLE_TIFF), 'tif');
  assert.equal(image.width, 3331);
  assert.equal(image.height, 1702);
  assert.equal(crypto.createHash('sha256').update(image.data).digest('hex'),
    '8d7bd5e344976b7abc1b86d53f1aa3cdf0eb96d17d73147af6ece351c70494c8');
});
