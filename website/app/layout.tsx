import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://ttcut.vercel.app"),
  title: "TTcut — 本地乒乓球回合分析与自动剪辑",
  description: "TTcut 在 Windows 本地识别乒乓球有效回合，提供全部、精彩和自定义剪辑模式，并安全导出成片。",
  icons: {
    icon: "/og.png",
  },
  openGraph: {
    title: "TTcut — 识别每个回合，剪出一场好球",
    description: "本地离线的乒乓球回合分析与自动视频剪辑工具。",
    type: "website",
    locale: "zh_CN",
    images: [{ url: "/og.png", width: 1792, height: 1024, alt: "TTcut 项目介绍" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "TTcut — 识别每个回合，剪出一场好球",
    description: "本地离线的乒乓球回合分析与自动视频剪辑工具。",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
