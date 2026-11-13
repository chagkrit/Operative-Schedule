import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import "./ts-resolve.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

// Text of `name(...) { ... }` up to the matching closing brace.
function block(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${marker} has no closing brace`);
}

const SIGN_IN_MESSAGE = "กรุณาเข้าสู่ระบบด้วยบัญชีที่ได้รับอนุญาต";

test("no access check compares against the single AUTHORIZED_EMAIL any more", async () => {
  const files = ["auth.ts", ...(await sourceFiles("app"))];
  for (const path of files) {
    const text = await read(path);
    assert.doesNotMatch(text, /[!=]==?\s*AUTHORIZED_EMAIL\b/, `${path} still compares with AUTHORIZED_EMAIL`);
    assert.doesNotMatch(text, /AUTHORIZED_EMAIL\s*[!=]==?/, `${path} still compares with AUTHORIZED_EMAIL`);
  }
});

test("Auth.js signIn and authorized callbacks consult the allowlist", async () => {
  const auth = await read("auth.ts");
  assert.match(auth, /import \{ userStore \} from "\.\/app\/lib\/user-store"/);
  const signIn = block(auth, "async signIn(");
  assert.match(signIn, /email_verified/);
  assert.match(signIn, /userStore\.getAccess\(/);
  assert.match(signIn, /\.allowed/);
  const authorized = block(auth, "async authorized(");
  assert.match(authorized, /userStore\.getAccess\(/);
  assert.match(authorized, /\.allowed/);
  // jwt keeps the lower-cased email the API chokepoint reads.
  assert.match(block(auth, "async jwt("), /token\.email = profile\.email\.toLowerCase\(\)/);
});

test("the Calendar API chokepoint checks the allowlist before any Google token work", async () => {
  const calendar = await read("app/lib/calendar.ts");
  const fn = block(calendar, "async function authorizedAccessToken(");
  assert.match(fn, /userStore\.getAccess\(/);
  assert.ok(fn.indexOf("userStore.getAccess(") < fn.indexOf("process.env.GOOGLE_REFRESH_TOKEN) {"));
  assert.match(fn, /withStatus\(SIGN_IN_REQUIRED_MESSAGE, 401\)/);
  assert.doesNotMatch(calendar, /กรุณาเข้าสู่ระบบด้วย hnbcmu/);
  const session = await read("app/lib/session.ts");
  assert.ok(session.includes(`SIGN_IN_REQUIRED_MESSAGE = "${SIGN_IN_MESSAGE}"`));
});

test("pages and presence use the allowlist; a deny never signs the user out", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /const access = await sessionAccess\(\);\s*if \(!access\) redirect\("\/signin"\);/);
  assert.match(page, /isAdmin=\{access\.role === "admin"\}/);
  assert.match(page, /authorizedEmail=\{AUTHORIZED_EMAIL\}/); // calendar-owner label, not an access check
  const signin = await read("app/signin/page.tsx");
  assert.match(signin, /if \(await sessionAccess\(\)\) redirect\("\/"\);/);
  const presence = await read("app/api/presence/route.ts");
  assert.match(presence, /await requestUserEmail\(request\)/);
  assert.match(presence, /status: 401/);
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /authorizedEmail: string; isAdmin: boolean/);
  for (const path of ["app/page.tsx", "app/signin/page.tsx", "app/api/presence/route.ts", "app/lib/session.ts", "app/lib/calendar.ts", "auth.ts"]) {
    const text = await read(path);
    assert.doesNotMatch(text, /signOut\(/, `${path} must not sign anyone out on a deny`);
  }
});

test("new bookings record the signed-in booker, not the calendar owner", async () => {
  const route = await read("app/api/schedule/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(post, /const bookedByEmail = await requestUserEmail\(request\);/);
  const create = post.slice(post.indexOf("createBookingEvent("), post.indexOf("});", post.indexOf("createBookingEvent(")));
  assert.match(create, /\n\s*bookedByEmail,\n/);
  assert.doesNotMatch(route, /bookedByEmail: AUTHORIZED_EMAIL/);
  // Inside the try, so statusFor() turns the 401 into a JSON 401.
  assert.ok(post.indexOf("try {") < post.indexOf("requestUserEmail(request)"));
});

test("closures and staff-unavailability saves record the acting user", async () => {
  for (const path of ["app/api/schedule-closures/route.ts", "app/api/staff-unavailability/route.ts"]) {
    const route = await read(path);
    assert.doesNotMatch(route, /AUTHORIZED_EMAIL/, path);
    assert.match(route, /const actorEmail = await requestUserEmail\(request\);/, path);
    assert.match(route, /updatedBy: actorEmail,/, path);
    // An undo restores the record as it was, including who last changed it.
    assert.match(route, /updatedBy: existing!\.updatedBy,/, path);
  }
});

test("user-store write computes its put options before awaiting the SDK import", async () => {
  const store = await read("app/lib/user-store.ts");
  const write = block(store, "async write(users)");
  assert.match(write, /^async write\(users\) \{\n(?:\s*\/\/.*\n)*\s*const opts = blobPutOptions\(etag\);\n\s*const \{ put \} = await import\("@vercel\/blob"\);/);
  assert.match(write, /put\(pathname, JSON\.stringify\(users, null, 2\), \{ \.\.\.opts, abortSignal: blobTimeoutSignal\(\) \}\)/);
});

test("user-store Blob get and put carry a per-call timeout signal", async () => {
  const store = await read("app/lib/user-store.ts");
  assert.match(block(store, "async read()"), /get\(pathname, \{ access: "private", useCache: false, abortSignal: blobTimeoutSignal\(\) \}\)/);
  assert.match(block(store, "async write(users)"), /abortSignal: blobTimeoutSignal\(\)/);
  // Not AbortSignal.timeout(): its TimeoutError is retried by the SDK with backoff (minutes).
  assert.doesNotMatch(store, /AbortSignal\.timeout\(/);
});

// ---- behavior: session helpers with a real Auth.js JWT and an in-memory store ----

const { encode } = await import("next-auth/jwt");
const session = await import("../app/lib/session.ts");
const { createUserStore } = await import("../app/lib/user-store.ts");

const SECRET = "test-secret-for-access-wiring-0123456789";
const COOKIE = "authjs.session-token"; // http:// URL ⇒ non-secure cookie name

function memoryStore(data) {
  return createUserStore({
    async read() {
      if (data instanceof Error) throw data;
      return data;
    },
    async write() {},
  });
}

async function requestWith(claims) {
  process.env.AUTH_SECRET = SECRET;
  const headers = {};
  if (claims) headers.cookie = `${COOKIE}=${await encode({ token: claims, secret: SECRET, salt: COOKIE })}`;
  return new Request("http://localhost/api/schedule", { headers });
}

const LIST = [
  { email: "nansurg7@gmail.com", role: "admin", active: true },
  { email: "hnbcmu@gmail.com", role: "user", active: true },
  { email: "off@cmu.ac.th", role: "user", active: false },
];

async function rejects401(promise) {
  await assert.rejects(promise, (err) => err.status === 401 && err.message === SIGN_IN_MESSAGE);
}

test("requestUserEmail returns the verified, lower-cased email of an allowed user", async () => {
  const store = memoryStore(LIST);
  assert.equal(await session.requestUserEmail(await requestWith({ email: "HnBcMu@Gmail.com" }), store), "hnbcmu@gmail.com");
  assert.equal(session.SIGN_IN_REQUIRED_MESSAGE, SIGN_IN_MESSAGE);
});

test("requestUserEmail throws 401 for no session, unknown, inactive, or email-less tokens", async () => {
  const store = memoryStore(LIST);
  await rejects401(session.requestUserEmail(await requestWith(null), store));
  await rejects401(session.requestUserEmail(await requestWith({ email: "stranger@gmail.com" }), store));
  await rejects401(session.requestUserEmail(await requestWith({ email: "off@cmu.ac.th" }), store));
  await rejects401(session.requestUserEmail(await requestWith({ name: "no email" }), store));
});

test("requestUserEmail fails closed on an unreadable list except for the bootstrap admin", async () => {
  const broken = memoryStore(new Error("blob 500"));
  const originalError = console.error;
  console.error = () => {};
  try {
    await rejects401(session.requestUserEmail(await requestWith({ email: "hnbcmu@gmail.com" }), broken));
    assert.equal(await session.requestUserEmail(await requestWith({ email: "nansurg7@gmail.com" }), broken), "nansurg7@gmail.com");
  } finally {
    console.error = originalError;
  }
});

test("emailAccess maps the allowlist to {email, role} or null", async () => {
  const store = memoryStore(LIST);
  assert.deepEqual(await session.emailAccess(" NANSURG7@gmail.com ", store), { email: "nansurg7@gmail.com", role: "admin" });
  assert.deepEqual(await session.emailAccess("hnbcmu@gmail.com", store), { email: "hnbcmu@gmail.com", role: "user" });
  assert.equal(await session.emailAccess("off@cmu.ac.th", store), null);
  assert.equal(await session.emailAccess("", store), null);
  assert.equal(await session.emailAccess(undefined, store), null);
});
