import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import "./ts-resolve.mjs";

const { sealToken, openToken } = await import("../app/lib/token-seal.ts");

const key = () => randomBytes(32).toString("base64");

test("round trip", () => {
  const k = key();
  const sealed = sealToken("synthetic-refresh-token", k);
  assert.match(sealed, /^v1\.[^.]+\.[^.]+\.[^.]+$/);
  assert.ok(!sealed.includes("synthetic-refresh-token"));
  assert.equal(openToken(sealed, k), "synthetic-refresh-token");
});

test("two seals of the same text differ", () => {
  const k = key();
  assert.notEqual(sealToken("same", k), sealToken("same", k));
});

test("wrong key throws", () => {
  const sealed = sealToken("x", key());
  assert.throws(() => openToken(sealed, key()));
});

test("flipped byte throws", () => {
  const k = key();
  const parts = sealToken("hello world", k).split(".");
  const ct = Buffer.from(parts[3], "base64");
  ct[0] ^= 1;
  parts[3] = ct.toString("base64");
  assert.throws(() => openToken(parts.join("."), k));
});

test("truncated / bad format throws", () => {
  const k = key();
  const sealed = sealToken("hello", k);
  assert.throws(() => openToken(sealed.slice(0, sealed.length - 10), k));
  assert.throws(() => openToken("garbage", k));
  assert.throws(() => openToken("v2." + sealed.slice(3), k));
});

test("keys that are not 32 bytes throw", () => {
  const short = randomBytes(16).toString("base64");
  assert.throws(() => sealToken("x", short));
  assert.throws(() => openToken("v1.a.b.c", short));
  assert.throws(() => sealToken("x", ""));
});
