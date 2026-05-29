import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
})

export const metadata: Metadata = {
  title: {
    default: 'Cortex Brain',
    template: '%s | Cortex Brain',
  },
  description: 'Multi-tenant knowledge management platform for AI-powered teams',
  icons: {
    icon: [
      {
        url: '/admin/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/admin/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/admin/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/admin/apple-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark bg-background`}>
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
