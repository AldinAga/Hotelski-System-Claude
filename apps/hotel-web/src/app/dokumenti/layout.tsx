import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

// The menu, the licence banner and the back-to-top button come from AppShell
// like on every inner page; globals.css hides them when a document is printed.
export default function DocumentsLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
