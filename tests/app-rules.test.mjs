import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("protects the app with the exact authorized Google account", async () => {
  const auth = await read("auth.ts");
  assert.match(auth, /AUTHORIZED_EMAIL = "hnbcmu@gmail\.com"/);
  assert.match(auth, /profile\.email\?\.toLowerCase\(\) === AUTHORIZED_EMAIL/);
  assert.match(auth, /calendar\.events/);
});

test("keeps the clinical queue safeguards in the server API", async () => {
  const route = await read("app/api/schedule/route.ts");
  assert.match(route, /ลงเคสที่ 4 ไม่ได้/);
  assert.match(route, /OR Extra รับเฉพาะเคส/);
  assert.match(route, /cancerSchedulingMode === "specific"/);
  assert.match(route, /cancerSchedulingMode === "earliest"/);
});
