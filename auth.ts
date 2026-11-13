import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { userStore } from "./app/lib/user-store";

// The Google Calendar owner (calendar id default, legacy `booked_by`/`updated_by` fallback,
// calendar label in the UI). Not an access rule: who may sign in comes from the allowlist
// in app/lib/user-store.ts.
export const AUTHORIZED_EMAIL = "hnbcmu@gmail.com";

// When GOOGLE_REFRESH_TOKEN is set, Calendar access is held by the server (see app/lib/calendar.ts),
// so sign-in only proves identity: no Calendar scope, no per-device refresh token to expire or
// push the server's own token out of Google's per-account refresh-token limit.
const SERVER_CALENDAR_TOKEN = Boolean(process.env.GOOGLE_REFRESH_TOKEN);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google(
      SERVER_CALENDAR_TOKEN
        ? {}
        : {
            authorization: {
              params: {
                access_type: "offline",
                prompt: "consent",
                scope: "openid email profile https://www.googleapis.com/auth/calendar.events",
              },
            },
          },
    ),
  ],
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    async signIn({ profile }) {
      if (!profile?.email_verified || !profile.email) return false;
      return (await userStore.getAccess(profile.email)).allowed;
    },
    async jwt({ token, account, profile }) {
      if (account && !SERVER_CALENDAR_TOKEN) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at;
      }
      if (profile?.email) token.email = profile.email.toLowerCase();
      return token;
    },
    async session({ session }) {
      if (session.user?.email) session.user.email = session.user.email.toLowerCase();
      return session;
    },
    // Only runs from a proxy/middleware, which this app does not have; pages and API routes
    // check the allowlist themselves (app/lib/session.ts, authorizedAccessToken in calendar.ts).
    async authorized({ auth: session }) {
      const email = session?.user?.email;
      return Boolean(email && (await userStore.getAccess(email)).allowed);
    },
  },
  trustHost: true,
});
