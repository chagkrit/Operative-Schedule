import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AUTHORIZED_EMAIL, parseTokenScriptArgs } from "../scripts/calendar-token-args.mjs";

test("no arguments keeps today's default email", () => {
  assert.equal(DEFAULT_AUTHORIZED_EMAIL, "hnbcmu@gmail.com");
  assert.deepEqual(parseTokenScriptArgs([]), { email: "hnbcmu@gmail.com" });
});

test("--email <address> and --email=<address> are accepted and normalized", () => {
  assert.deepEqual(parseTokenScriptArgs(["--email", " New.Person@Gmail.com "]), { email: "new.person@gmail.com" });
  assert.deepEqual(parseTokenScriptArgs(["--email=Other@CMU.ac.th"]), { email: "other@cmu.ac.th" });
});

test("bad or missing email and unknown arguments are errors", () => {
  for (const argv of [["--email"], ["--email", "abc"], ["--email="], ["--email", "a b@x.com"], ["--nope"], ["x@y.com"]]) {
    assert.equal(typeof parseTokenScriptArgs(argv).error, "string", JSON.stringify(argv));
  }
});
