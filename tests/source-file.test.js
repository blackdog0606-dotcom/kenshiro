"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { toFileUrl, readSource, verifySource } = require("../src/source-file");

function storageFor(metadata = { size: 8, dateModified: new Date(1234) }) {
  const entry = {
    isFile: true,
    getMetadata: async () => metadata,
    read: async () => new Uint8Array(8).buffer
  };
  return { entry, storage: { formats: { binary: "binary" }, localFileSystem: {
    getEntryWithUrl: async () => entry
  } } };
}

test("UXP local paths handle Windows and Japanese macOS paths", () => {
  assert.equal(toFileUrl("C:\\画像\\25-142-4.tif"), "file:/C:/画像/25-142-4.tif");
  assert.equal(toFileUrl("/Users/test/画像 01.tif"), "file:/Users/test/画像 01.tif");
  assert.equal(toFileUrl("/Users/test/a\\b.tif"), "file:/Users/test/a\\b.tif");
  assert.throws(() => toFileUrl("relative.tif"));
  assert.throws(() => toFileUrl("\\\\server\\image.tif"));
  assert.throws(() => toFileUrl("/a\u0000b"));
});

test("source bytes and metadata signature are read without changing the image", async () => {
  const { storage } = storageFor();
  const result = await readSource(storage, "/image.tif");
  assert.equal(result.bytes.byteLength, 8);
  assert.equal(result.signature, "8:1234");
  await verifySource(storage, "/image.tif", result.signature);
});

test("changed image is rejected before applying its old crop", async () => {
  const { storage } = storageFor();
  await assert.rejects(verifySource(storage, "/image.tif", "8:1235"), /再解析/);
});

test("image modified while reading is rejected", async () => {
  const { entry, storage } = storageFor();
  let count = 0;
  entry.getMetadata = async () => ({ size: 8, dateModified: new Date(++count) });
  await assert.rejects(readSource(storage, "/image.tif"), /読み込み中/);
});

test("empty, oversized, non-file and unavailable metadata do not decode", async () => {
  for (const size of [0, 100 * 1024 * 1024 + 1]) {
    const { storage } = storageFor({ size, dateModified: new Date() });
    await assert.rejects(readSource(storage, "/image.tif"), /100MB/);
  }
  const { entry, storage } = storageFor();
  entry.isFile = false;
  await assert.rejects(readSource(storage, "/image.tif"), /見つかりません/);
  const bad = storageFor({ size: 8, dateModified: "invalid" });
  await assert.rejects(readSource(bad.storage, "/image.tif"), /更新日時/);
});
