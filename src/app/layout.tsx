import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Telegram Daily Assistant",
  description: "Private Telegram daily assistant API",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
