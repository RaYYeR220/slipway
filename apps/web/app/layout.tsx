import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Slipway — execution desk for tokenized US stocks", template: "%s · Slipway" },
  description:
    "Slipway prices your order across Bitget rTokens, stock perps and the New York sessions, hands you a dry-run ticket for every slice, then grades its own forecast against the tape.",
};

export const viewport: Viewport = { themeColor: "#050c10", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=zodiak@300,400,700,300i,400i&f[]=switzer@300,400,500,600&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Azeret+Mono:wght@300..600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
