import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OR Queue — Breast & Endocrine Surgery CMU",
    short_name: "OR Queue",
    description: "ระบบลงคิวผ่าตัด OR 17 และ OR Extra",
    id: "/",
    lang: "th",
    start_url: "/?tab=schedule",
    display: "standalone",
    background_color: "#fbf4f6",
    theme_color: "#a71955",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
