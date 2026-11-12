import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("manifest declares the installable app", () => {
  const src = readFileSync(new URL("../app/manifest.ts", import.meta.url), "utf8");
  for (const needle of [
    'short_name: "OR Queue"',
    'display: "standalone"',
    'start_url: "/?tab=schedule"',
    'theme_color: "#a71955"',
    'background_color: "#fbf4f6"',
    '"maskable"',
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-512.png",
  ]) {
    assert.ok(src.includes(needle), `manifest.ts contains ${needle}`);
  }
});

test("layout sets theme colour and iOS web-app meta", () => {
  const src = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  for (const needle of [
    'themeColor: "#a71955"',
    'viewportFit: "cover"',
    "appleWebApp",
    "capable: true",
    'apple: "/icons/apple-touch-icon-180.png"',
  ]) {
    assert.ok(src.includes(needle), `layout.tsx contains ${needle}`);
  }
});

test("no service worker in this PR", () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const file of [...walk(join(root, "app")), ...walk(join(root, "public"))]) {
    if (/\.(png|jpe?g|ico|woff2?)$/i.test(file)) continue;
    assert.ok(!readFileSync(file, "utf8").includes("serviceWorker.register"), `${file} registers a service worker`);
  }
  assert.ok(!existsSync(join(root, "public/sw.js")), "public/sw.js must not exist");
});

test("manifest declares a stable app id", () => {
  const src = readFileSync(new URL("../app/manifest.ts", import.meta.url), "utf8");
  assert.match(src, /id: "\/"/);
});

test("maskable icon is padded to 2900px (logo ~70%)", () => {
  const src = readFileSync(new URL("../scripts/make-icons.sh", import.meta.url), "utf8");
  assert.ok(src.includes("2900"), "make-icons.sh pads maskable canvas to 2900");
  assert.ok(!src.includes("2600"), "old 2600 padding removed");
});
