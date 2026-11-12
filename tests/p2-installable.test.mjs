import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ICONS = [
  ["public/icons/icon-192.png", 192],
  ["public/icons/icon-512.png", 512],
  ["public/icons/icon-maskable-512.png", 512],
  ["public/icons/apple-touch-icon-180.png", 180],
];

test("app icons exist at the declared sizes", () => {
  for (const [path, size] of ICONS) {
    const buf = readFileSync(new URL(`../${path}`, import.meta.url));
    assert.equal(buf.subarray(1, 4).toString("ascii"), "PNG", `${path} is a PNG`);
    assert.equal(buf.readUInt32BE(16), size, `${path} width`);
    assert.equal(buf.readUInt32BE(20), size, `${path} height`);
  }
});
