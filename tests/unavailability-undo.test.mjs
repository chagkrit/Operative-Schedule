import assert from "node:assert/strict";
import test from "node:test";
import { undoUnavailabilityWrite } from "../app/lib/unavailability-undo.ts";

const failWith = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test("nothing written means nothing to undo", async () => {
  let calls = 0;
  const outcome = await undoUnavailabilityWrite({
    editing: true, writtenIds: [], restore: async () => { calls += 1; }, remove: async () => { calls += 1; },
  });
  assert.equal(outcome, "undone");
  assert.equal(calls, 0);
});

test("edit: restore succeeds", async () => {
  let restores = 0;
  const outcome = await undoUnavailabilityWrite({
    editing: true, writtenIds: ["e1"], restore: async () => { restores += 1; }, remove: async () => assert.fail("edit never deletes"),
  });
  assert.equal(outcome, "undone");
  assert.equal(restores, 1);
});

test("edit: 412 means someone edited after us; we do not overwrite or retry", async () => {
  let restores = 0;
  const outcome = await undoUnavailabilityWrite({
    editing: true, writtenIds: ["e1"], restore: async () => { restores += 1; throw failWith(412); }, remove: async () => assert.fail("edit never deletes"),
  });
  assert.equal(outcome, "changed");
  assert.equal(restores, 1);
});

test("edit: a transient failure is retried once", async () => {
  let restores = 0;
  const outcome = await undoUnavailabilityWrite({
    editing: true, writtenIds: ["e1"], restore: async () => { restores += 1; if (restores === 1) throw failWith(503); }, remove: async () => {},
  });
  assert.equal(outcome, "undone");
  assert.equal(restores, 2);
});

test("edit: two failures are reported, never hidden", async () => {
  let restores = 0;
  const outcome = await undoUnavailabilityWrite({
    editing: true, writtenIds: ["e1"], restore: async () => { restores += 1; throw failWith(500); }, remove: async () => {},
  });
  assert.equal(outcome, "failed");
  assert.equal(restores, 2);
});

test("create: removes every new id; already-gone counts as removed", async () => {
  const removed = [];
  const outcome = await undoUnavailabilityWrite({
    editing: false,
    writtenIds: ["a", "b", "c"],
    restore: async () => assert.fail("create never restores"),
    remove: async (id) => { removed.push(id); if (id === "b") throw failWith(410); if (id === "c") throw failWith(404); },
  });
  assert.equal(outcome, "undone");
  assert.deepEqual(removed, ["a", "b", "c"]);
});

test("create: only failed ids are retried; a persistent failure is reported", async () => {
  const removed = [];
  const once = await undoUnavailabilityWrite({
    editing: false,
    writtenIds: ["a", "b"],
    restore: async () => {},
    remove: async (id) => { removed.push(id); if (id === "b" && removed.filter((x) => x === "b").length === 1) throw failWith(503); },
  });
  assert.equal(once, "undone");
  assert.deepEqual(removed, ["a", "b", "b"]);

  const stuck = await undoUnavailabilityWrite({
    editing: false, writtenIds: ["a"], restore: async () => {}, remove: async () => { throw failWith(500); },
  });
  assert.equal(stuck, "failed");
});
