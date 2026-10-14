// One-off helper: prints a Google refresh token for hnbcmu@gmail.com's Calendar.
// Run:  node --env-file=.env.local scripts/get-calendar-refresh-token.mjs
// Needs AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET and the redirect URI below registered on the OAuth client.
// The token is printed to the terminal only. It is never written to disk.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const AUTHORIZED_EMAIL = "hnbcmu@gmail.com";
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/api/auth/callback/google`;
const clientId = process.env.AUTH_GOOGLE_ID;
const clientSecret = process.env.AUTH_GOOGLE_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET (e.g. node --env-file=.env.local scripts/get-calendar-refresh-token.mjs).");
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: "openid email https://www.googleapis.com/auth/calendar.events",
  access_type: "offline",
  prompt: "consent",
  login_hint: AUTHORIZED_EMAIL,
  state,
}).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/api/auth/callback/google") {
    res.writeHead(404).end();
    return;
  }
  const finish = (code, message, exitCode) => {
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }).end(message);
    server.close();
    process.exitCode = exitCode;
  };
  if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
    console.error("Callback had a bad state or no code, aborting.");
    return finish(400, "Failed. See the terminal.", 1);
  }
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code"),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) throw new Error(tokens.error_description || tokens.error || "token exchange failed");
    const info = await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } })).json();
    if (String(info.email || "").toLowerCase() !== AUTHORIZED_EMAIL) throw new Error(`Signed in as ${info.email}, expected ${AUTHORIZED_EMAIL}. Nothing printed.`);
    if (!tokens.refresh_token) throw new Error("Google returned no refresh_token. Remove the app at myaccount.google.com/permissions and run again.");
    console.log("\nGOOGLE_REFRESH_TOKEN (set this in Vercel, then redeploy; do not commit or paste it anywhere else):\n");
    console.log(tokens.refresh_token);
    console.log("");
    finish(200, "Done. Close this tab and return to the terminal.", 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    finish(500, "Failed. See the terminal.", 1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Stop \`npm run dev\` first (this uses port ${PORT}). Open this URL and sign in as ${AUTHORIZED_EMAIL}:\n\n${authUrl}\n`);
});
