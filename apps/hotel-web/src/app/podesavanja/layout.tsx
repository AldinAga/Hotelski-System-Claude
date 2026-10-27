import type { ReactNode } from 'react';
import { LicenceBanner } from '@/components/licence-banner';
import { SignOutButton } from '@/components/sign-out-button';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav className="topnav" aria-label="Podešavanja">
        <a href="/podesavanja/jedinice">Jedinice</a>
        <a href="/podesavanja/cene">Cene</a>
        <span className="spacer" />
        <SignOutButton />
      </nav>
      <LicenceBanner />
      {children}
    </>
  );
}
