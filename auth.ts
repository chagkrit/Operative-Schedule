import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const AUTHORIZED_EMAIL = "hnbcmu@gmail.com";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: {
          access_type: "offline",
          prompt: "consent",
          scope: "openid email profile https://www.googleapis.com/auth/calendar.events",
        },
      },
    }),
  ],
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    async signIn({ profile }) {
      return Boolean(profile?.email_verified && profile.email?.toLowerCase() === AUTHORIZED_EMAIL);
    },
    async jwt({ token, account, profile }) {
      if (account) {
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
