// Pure argument parsing for get-calendar-refresh-token.mjs: `--email <address>` or `--email=<address>`.
// Default stays today's value. Returns { email } or { error } (never throws, never touches the network).
export const DEFAULT_AUTHORIZED_EMAIL = "hnbcmu@gmail.com";

export function parseTokenScriptArgs(argv) {
  let email = DEFAULT_AUTHORIZED_EMAIL;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let value;
    if (arg === "--email") {
      value = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--email=")) {
      value = arg.slice("--email=".length);
    } else {
      return { error: `Unknown argument: ${arg}. Usage: --email <address>` };
    }
    const candidate = String(value ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return { error: "--email needs a valid email address" };
    email = candidate;
  }
  return { email };
}
