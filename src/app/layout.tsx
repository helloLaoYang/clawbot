import type { Metadata } from "next"
import type { ReactNode } from "react"

export const runtime = "nodejs"

export const metadata: Metadata = {
  description: "Clawbot webhook service",
  title: "Clawbot",
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
