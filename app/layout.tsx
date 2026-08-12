import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const description = "ระบบลงคิวผ่าตัด OR 17 และ OR Extra พร้อมเชื่อม Google Calendar";
  return {
    metadataBase: new URL(origin),
    title: "OR Queue | Breast & Endocrine Surgery CMU",
    description,
    icons: { icon: "/unit-logo.jpg", shortcut: "/unit-logo.jpg" },
    openGraph: {
      title: "OR Queue",
      description,
      type: "website",
      url: origin,
      images: [{ url: `${origin}/og.png`, width: 1536, height: 1024, alt: "OR Queue — Breast & Endocrine Surgery CMU" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "OR Queue",
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
