import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { portalViewport } from '@/components/portal-viewport';

export const metadata: Metadata = { title: 'Prijava – Recepcija' };
export const viewport: Viewport = portalViewport;

export default function SignInLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
