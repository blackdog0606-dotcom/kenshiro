const jpeg = require('jpeg-js');
const UPNG = require('upng-js');
const UTIF = require('utif');

const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 20_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function invalid(message) {
  throw new Error(message || '画像ファイルが破損しているか、対応していない形式です。');
}

function checkDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    invalid('元画像のサイズを読み取れません。');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    invalid('最小版では元画像は4,000万画素以下、各辺20,000px以下にしてください。');
  }
}

function hasPrefix(bytes, offset, prefix) {
  return offset + prefix.length <= bytes.length &&
    prefix.every((value, index) => bytes[offset + index] === value);
}

function pngDimensions(bytes) {
  if (bytes.length < 33) invalid('PNGファイルが途中で切れています。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width;
  let height;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid('PNGチャンクが途中で切れています。');
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) invalid('PNGチャンクの長さが不正です。');
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset === 8) {
      if (name !== 'IHDR' || length !== 13) invalid('PNGのIHDRヘッダーが不正です。');
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      checkDimensions(width, height);
    } else if (name === 'IHDR') {
      invalid('PNGのIHDRヘッダーが重複しています。');
    }
    if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') {
      invalid('アニメーションPNGには対応していません。静止画PNGに変換してください。');
    }
    offset += length + 12;
    if (name === 'IEND') {
      if (length !== 0 || offset !== bytes.length) invalid('PNGの終端が不正です。');
      ended = true;
      break;
    }
  }
  if (!ended) invalid('PNGの終端チャンクがありません。');
  return { width, height };
}

function exifOrientation(bytes, start, end) {
  if (!hasPrefix(bytes, start, [69, 120, 105, 102, 0, 0])) return 1;
  const tiff = start + 6;
  if (end - tiff < 8) invalid('JPEGのEXIFヘッダーが不正です。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) invalid('JPEGのEXIFバイト順が不正です。');
  const littleEndian = order === 0x4949;
  const u16 = (offset) => view.getUint16(offset, littleEndian);
  const u32 = (offset) => view.getUint32(offset, littleEndian);
  if (u16(tiff + 2) !== 42) invalid('JPEGのEXIFヘッダーが不正です。');
  const ifdOffset = u32(tiff + 4);
  if (ifdOffset < 8 || ifdOffset > end - tiff - 2) invalid('JPEGのEXIF位置が不正です。');
  const ifd = tiff + ifdOffset;
  const count = u16(ifd);
  if (count > Math.floor((end - ifd - 2) / 12)) invalid('JPEGのEXIF項目が途中で切れています。');
  let orientation = 1;
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    if (u16(entry) !== 0x0112) continue;
    if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) {
      invalid('JPEGのEXIF回転情報が不正です。');
    }
    orientation = u16(entry + 8);
    if (orientation < 1 || orientation > 8) invalid('JPEGのEXIF回転情報が不正です。');
    if (orientation !== 1) {
      invalid('EXIF回転・反転付きJPEGは、画像編集ソフトで向きを確定して保存し直してから実行してください。');
    }
  }
  return orientation;
}

function jpegDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let dimensions;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid('JPEGのマーカーが不正です。');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalid('JPEGファイルが途中で切れています。');
    const marker = bytes[offset++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) invalid('JPEGセグメントが途中で切れています。');
    const length = view.getUint16(offset);
    if (length < 2 || length > bytes.length - offset) invalid('JPEGセグメントの長さが不正です。');
    const start = offset + 2;
    const end = offset + length;
    if (marker === 0xe1) exifOrientation(bytes, start, end);
    if (SOF_MARKERS.has(marker)) {
      if (length < 8) invalid('JPEGのサイズヘッダーが不正です。');
      const height = view.getUint16(start + 1);
      const width = view.getUint16(start + 3);
      checkDimensions(width, height);
      if (dimensions && (dimensions.width !== width || dimensions.height !== height)) {
        invalid('JPEGに異なる画像サイズが含まれています。');
      }
      dimensions = { width, height };
    }
    if (marker === 0xda) break;
    offset = end;
  }
  if (!dimensions) invalid('JPEGの元画像サイズを読み取れません。');
  return dimensions;
}

// UTIF's metadata reader follows IFD pointers without a cycle guard. Validate
// their bounds first, before giving the file to UTIF.decode (or allocating pixels).
function checkTiffStructure(bytes) {
  if (bytes.length < 8) invalid('TIFFヘッダーが途中で切れています。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = bytes[0] === 0x49;
  const u16 = (offset) => view.getUint16(offset, littleEndian);
  const u32 = (offset) => view.getUint32(offset, littleEndian);
  if (u16(2) === 43) invalid('BigTIFFには対応していません。通常の8bit TIFFで保存し直してください。');
  if (u16(2) !== 42) invalid('TIFFヘッダーが不正です。');
  const visited = new Set();
  const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  function readIfd(offset, depth = 0) {
    if (depth > 8 || visited.has(offset)) invalid('TIFFのメタデータ参照が循環または深すぎます。');
    if (offset < 8 || offset > bytes.length - 6) invalid('TIFFのIFD位置が不正です。');
    visited.add(offset);
    const count = u16(offset);
    if (count > 4096 || count > Math.floor((bytes.length - offset - 6) / 12)) {
      invalid('TIFFのメタデータ項目が不正です。');
    }
    const next = u32(offset + 2 + count * 12);
    if (next !== 0) invalid('複数ページのTIFFには対応していません。1枚ずつ保存してください。');
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const items = u32(entry + 4);
      const size = sizes[type];
      if (!size || items > 1_000_000) invalid('TIFFのメタデータ形式・サイズに対応していません。');
      const length = size * items;
      const dataOffset = length <= 4 ? entry + 8 : u32(entry + 8);
      if (dataOffset > bytes.length - length) invalid('TIFFメタデータの長さが不正です。');
      if (tag === 330 || tag === 50740 || tag === 37500) {
        invalid('サブ画像・RAW・メーカー固有情報付きTIFFには対応していません。通常のTIFFで保存し直してください。');
      }
      if (tag === 34665) {
        if (type !== 4 || items !== 1) invalid('TIFFのEXIF参照が不正です。');
        readIfd(u32(dataOffset), depth + 1);
      }
    }
  }
  readIfd(u32(4));
}

// UTIF 3.1.0's LZW loop has no input boundary check. Validate the code stream,
// including EOI and its exact output size, to avoid hanging on damaged strips.
function checkLzwStrip(bytes, offset, length, expectedLength) {
  let bit = offset * 8;
  const end = (offset + length) * 8;
  let width = 9;
  let next = 258;
  let previousLength = 0;
  let outputLength = 0;
  const lengths = new Uint32Array(4096);
  lengths.fill(1, 0, 256);
  while (bit + width <= end) {
    let code = 0;
    for (let index = 0; index < width; index++, bit++) {
      code = (code << 1) | ((bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1);
    }
    if (code === 257) {
      if (outputLength !== expectedLength) invalid('TIFFのLZW展開サイズが不正です。');
      return;
    }
    if (code === 256) {
      width = 9;
      next = 258;
      previousLength = 0;
      continue;
    }
    let currentLength;
    if (code < 256) currentLength = 1;
    else if (code < next && previousLength) currentLength = lengths[code];
    else if (code === next && previousLength) currentLength = previousLength + 1;
    else invalid('TIFFのLZW圧縮データが不正です。');
    outputLength += currentLength;
    if (outputLength > expectedLength) invalid('TIFFのLZW展開サイズが元画像を超えています。');
    if (previousLength && next < 4096) {
      lengths[next++] = previousLength + 1;
      if (next === (1 << width) - 1 && width < 12) width++;
    }
    previousLength = currentLength;
  }
  invalid('TIFFのLZW圧縮データが途中で切れています。');
}

function checkPackBitsStrip(bytes, offset, length, expectedLength) {
  let outputLength = 0;
  const end = offset + length;
  while (offset < end) {
    const code = bytes[offset++];
    if (code === 128) continue;
    const consumed = code < 128 ? code + 1 : 1;
    outputLength += code < 128 ? code + 1 : 257 - code;
    if (consumed > end - offset || outputLength > expectedLength) invalid('TIFFのPackBits圧縮データが不正です。');
    offset += consumed;
  }
  if (outputLength !== expectedLength) invalid('TIFFのPackBits展開サイズが不正です。');
}

function tiffInfo(bytes) {
  checkTiffStructure(bytes);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let ifds;
  try { ifds = UTIF.decode(buffer); }
  catch (error) { invalid(`TIFFメタデータを読み取れません。(${error.message})`); }
  if (ifds.length !== 1) invalid('複数ページのTIFFには対応していません。');
  const image = ifds[0];
  const first = (tag, fallback) => image[`t${tag}`] ? image[`t${tag}`][0] : fallback;
  const width = first(256);
  const height = first(257);
  checkDimensions(width, height);
  if (first(274, 1) !== 1) invalid('回転・反転付きTIFFは、画像編集ソフトで向きを確定して保存し直してください。');
  const photometric = first(262, -1);
  const samples = first(277, 1);
  const bits = image.t258 || [1];
  if (![0, 1, 2].includes(photometric) ||
      (photometric === 2 ? ![3, 4].includes(samples) : samples !== 1) ||
      bits.length !== samples || bits.some((value) => value !== 8) ||
      first(339, 1) !== 1) {
    invalid('最小版のTIFFは8bitグレースケール・RGB/RGBAに対応しています。CMYK・16bit・パレット形式は変換してください。');
  }
  if (first(284, 1) !== 1 || image.t322 || image.t323) {
    invalid('分離チャンネル・タイルTIFFには対応していません。通常のストリップTIFFで保存してください。');
  }
  if (![1, 2].includes(first(317, 1))) invalid('このTIFFのPredictorには対応していません。');
  const compression = first(259, 1);
  if (![1, 5, 32773].includes(compression)) {
    invalid(`このTIFF圧縮形式(${compression})には対応していません。LZW・PackBits・無圧縮で保存してください。`);
  }
  const rows = first(278, height);
  if (!Number.isInteger(rows) || rows < 1) invalid('TIFFのストリップ行数が不正です。');
  const offsets = image.t273;
  const counts = image.t279;
  const stripCount = Math.ceil(height / rows);
  if (!offsets || !counts || offsets.length !== stripCount || counts.length !== stripCount) {
    invalid('TIFFのストリップ情報が不正です。');
  }
  for (let index = 0; index < stripCount; index++) {
    const offset = offsets[index];
    const length = counts[index];
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 8 || length < 1 || offset > bytes.length - length) {
      invalid('TIFFの画像データが途中で切れています。');
    }
    const expected = width * samples * Math.min(rows, height - index * rows);
    if (compression === 1 && length !== expected) invalid('無圧縮TIFFの画像データサイズが不正です。');
    if (compression === 5) checkLzwStrip(bytes, offset, length, expected);
    if (compression === 32773) checkPackBitsStrip(bytes, offset, length, expected);
  }
  return { width, height, buffer, image, ifds };
}

/**
 * Decode original full-resolution PNG/JPEG/TIFF into RGBA without canvas or Node I/O.
 * TIFF is single-page, 8bit grayscale/RGB/RGBA, strips, uncompressed/LZW/PackBits.
 * APNG, BigTIFF, and metadata requiring rotation/mirroring are rejected.
 * Image dimensions are checked before the decoders allocate pixel buffers.
 */
function decodeImage(input, extension = '') {
  let bytes;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (input instanceof Uint8Array || input instanceof Uint8ClampedArray) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else invalid('画像データをバイナリ形式で読み込めません。');

  const ext = String(extension).toLowerCase().replace(/^\./, '');
  if (ext && !['png', 'jpg', 'jpeg', 'tif', 'tiff'].includes(ext)) {
    invalid('最小版はPNG・JPEG・TIFFの静止画に対応しています。');
  }
  const png = hasPrefix(bytes, 0, PNG_SIGNATURE);
  const jpg = hasPrefix(bytes, 0, [0xff, 0xd8]);
  const tiff = hasPrefix(bytes, 0, [0x49, 0x49]) || hasPrefix(bytes, 0, [0x4d, 0x4d]);
  if (!png && !jpg && !tiff) invalid('PNG・JPEG・TIFFの元画像を選択してください。拡張子だけを変更した画像には対応しません。');
  if (ext && ((ext === 'png' && !png) || (['jpg', 'jpeg'].includes(ext) && !jpg) ||
      (['tif', 'tiff'].includes(ext) && !tiff))) invalid('画像の内容と拡張子が一致しません。');
  const expected = png ? pngDimensions(bytes) : jpg ? jpegDimensions(bytes) : tiffInfo(bytes);
  let decoded;
  try {
    if (png) {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const image = UPNG.decode(buffer);
      const frames = UPNG.toRGBA8(image);
      if (frames.length !== 1) invalid('複数フレームのPNGには対応していません。');
      decoded = { width: image.width, height: image.height, data: new Uint8Array(frames[0]) };
    } else if (jpg) {
      decoded = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: MAX_PIXELS / 1_000_000,
        maxMemoryUsageInMB: 256,
      });
    } else {
      UTIF.decodeImage(expected.buffer, expected.image, expected.ifds);
      decoded = { width: expected.image.width, height: expected.image.height, data: UTIF.toRGBA8(expected.image) };
    }
  } catch (error) {
    invalid(`画像をデコードできません。ファイルを確認して保存し直してください。(${error.message})`);
  }
  if (decoded.width !== expected.width || decoded.height !== expected.height ||
      decoded.data.length !== expected.width * expected.height * 4) {
    invalid('デコード後の画像サイズが元画像ヘッダーと一致しません。');
  }
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}

module.exports = { decodeImage };
