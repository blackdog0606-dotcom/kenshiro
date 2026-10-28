"use strict";

// Separate processes expose every node:test case even in managed runtimes whose
// --test runner only emits a file summary. Preserve each process's exit status.
const { readdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const root = resolve(__dirname, "..");
for (const name of readdirSync(resolve(root, "tests")).filter(n => n.endsWith(".test.js")).sort()) {
  const result = spawnSync(process.execPath, [resolve(root, "tests", name)], {
    cwd: root, stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
