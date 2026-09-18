import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Интерфейс целиком на русском, поэтому кириллица обязана быть в подключаемом
// начертании: без неё браузер подставляет системный шрифт и текст едет.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Shyngan — визуальный профиль университета",
  description:
    "Фотографии кампуса, общежитий, аудиторий и библиотек из открытых источников с проверкой принадлежности, источником и уровнем доверия у каждого снимка.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" className={`${inter.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
