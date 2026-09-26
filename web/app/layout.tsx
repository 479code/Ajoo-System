import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ajoo Ledger",
  description: "Rotating contribution tracker for Ajoo/Esusu-style savings circles.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
