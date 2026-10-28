import type { ReactNode } from 'react';
import { LicenceBanner } from './licence-banner';
import { SignOutButton } from './sign-out-button';

/** Top navigation and licence banner of every signed-in screen. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <nav className="topnav" aria-label="Glavni meni">
        <a href="/kalendar">Kalendar</a>
        <a href="/rezervacije/nova">Nova rezervacija</a>
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
