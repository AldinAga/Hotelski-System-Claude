import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

export default function FolioLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
