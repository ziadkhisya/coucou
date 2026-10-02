import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/core/layout.ts"], bundle: true, write: false,
  format: "esm", platform: "node",
});
const { overviewHeight, islandSize } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

test("Codex overview grows with plan detail and keeps one-step fallback compact", () => {
  assert.equal(overviewHeight(0, 0, 0), 148);
  assert.ok(overviewHeight(0, 0, 0) < overviewHeight(5, 0, 0));
  assert.equal(overviewHeight(5, 0, 0), 204);
  assert.equal(islandSize("expanded", "overview", 0, overviewHeight(5, 0, 0)).h, 204);
});

test("finished plans retain a bounded note and the other-session rail fits or scrolls", () => {
  assert.equal(overviewHeight(5, 2, 0), 219);
  assert.equal(overviewHeight(0, 0, 1), 148);
  assert.ok(overviewHeight(0, 0, 5) > overviewHeight(0, 0, 1));
  assert.ok(overviewHeight(0, 0, 20) <= 264);
  assert.ok(overviewHeight(20, 3, 20) <= 264);
});
