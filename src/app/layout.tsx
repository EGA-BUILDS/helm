import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { ConvexSetupRequired } from "./ConvexSetupRequired";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Helm",
  description: "Your software execution hub",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // ClerkProvider throws during prerender when the publishable key is unset,
  // so gate it: without the key the app renders the "Configuration required"
  // state instead of crashing.
  const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {clerkPublishableKey ? (
          <ClerkProvider>{children}</ClerkProvider>
        ) : (
          <ConvexSetupRequired />
        )}
      </body>
    </html>
  );
}
