"use strict";

const MAX_FILE_BYTES = 100 * 1024 * 1024;

// UXP uses file:/ for absolute paths, including file:/C:/... on Windows.
function toFileUrl(path) {
  if (typeof path !== "string" || !path || /[\u0000-\u001f]/.test(path)) {
    throw new Error("元画像のファイルパスが不正です。");
  }
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  const normalized = windows ? path.replace(/\\/g, "/") : path;
  if (normalized.startsWith("//")) {
    throw new Error("最小版ではネットワーク共有の画像をローカルへコピーして再リンクしてください。");
  }
  if (normalized.startsWith("/")) return `file:${normalized}`;
  if (/^[A-Za-z]:\//.test(normalized)) return `file:/${normalized}`;
  throw new Error("元画像の絶対パスを取得できません。");
}

function fingerprint(metadata) {
  const modified = new Date(metadata.dateModified).getTime();
  if (!Number.isFinite(metadata.size) || !Number.isFinite(modified)) {
    throw new Error("元画像の更新日時・サイズを取得できません。");
  }
  return `${metadata.size}:${modified}`;
}

async function readSource(storage, path) {
  const entry = await storage.localFileSystem.getEntryWithUrl(toFileUrl(path));
  if (!entry.isFile) throw new Error("元画像ファイルが見つかりません。");
  const before = await entry.getMetadata();
  if (before.size <= 0 || before.size > MAX_FILE_BYTES) {
    throw new Error("最小版では0バイトでない100MB以下の元画像を使用してください。");
  }
  const signature = fingerprint(before);
  const bytes = await entry.read({ format: storage.formats.binary });
  if (signature !== fingerprint(await entry.getMetadata())) {
    throw new Error("読み込み中に元画像が変更されました。再解析してください。");
  }
  return { bytes, signature };
}

async function verifySource(storage, path, signature) {
  const entry = await storage.localFileSystem.getEntryWithUrl(toFileUrl(path));
  if (!entry.isFile || fingerprint(await entry.getMetadata()) !== signature) {
    throw new Error("解析後に元画像が変更されました。再解析してください。");
  }
}

module.exports = { toFileUrl, readSource, verifySource };
