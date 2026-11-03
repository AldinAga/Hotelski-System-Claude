import type { Viewport } from 'next';

/**
 * Viewport of the entry portal (/prijava, /aktivacija): edge to edge, so the
 * glass backdrop also fills the area around a phone's notch; the portal pads
 * its content by the safe-area insets (.portal-main in globals.css). The
 * signed-in app keeps the root viewport. The theme colour follows the
 * portal's light and dark backgrounds.
 */
export const portalViewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f3ee' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0f17' },
  ],
};
