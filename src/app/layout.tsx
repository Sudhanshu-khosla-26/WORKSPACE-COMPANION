import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Buddy — Your AI Companion",
  description: "Real-time emotional AI companion that understands and supports you.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={outfit.className}>
      <body className="antialiased overflow-hidden" style={{ background: "transparent" }}>{children}</body>
    </html>
  );
}
