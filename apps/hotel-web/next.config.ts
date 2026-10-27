import type { NextConfig } from 'next';

// The browser talks only to this origin: /api/* is forwarded to hotel-api, so
// the API's HttpOnly, SameSite=Strict session cookie stays first-party.
// Rewrites are fixed when `next build` runs, so HOTEL_API_URL must be set at
// build time (the container image build passes it).
const apiUrl = (process.env.HOTEL_API_URL ?? 'http://localhost:4200').replace(/\/+$/, '');

const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Next's App Router emits inline scripts for hydration; eval only in dev (HMR).
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      // data: for the TOTP QR code, which is drawn locally and never sent anywhere.
      "img-src 'self' data:",
      "connect-src 'self'" + (process.env.NODE_ENV === 'production' ? '' : ' ws: wss:'),
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Type errors fail `next build`; there is no ESLint setup in this repo.
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
