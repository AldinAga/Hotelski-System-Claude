import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { portalViewport } from '@/components/portal-viewport';

export const metadata: Metadata = { title: 'Prvo podešavanje – Recepcija' };
export const viewport: Viewport = portalViewport;

export default function ActivationLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
