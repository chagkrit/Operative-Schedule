import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

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
      return Boolean(profile?.email_verified && profile.email?.toLowerCase() === AUTHORIZED_EMAIL);
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
    authorized({ auth: session }) {
      return session?.user?.email?.toLowerCase() === AUTHORIZED_EMAIL;
    },
  },
  trustHost: true,
});
