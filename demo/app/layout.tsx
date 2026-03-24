import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aqualens React Demo",
  description: "Liquid Glass effect for React",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="snap-y snap-mandatory scroll-pt-6">
      <body>{children}</body>
    </html>
  );
}
