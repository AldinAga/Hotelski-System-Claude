import type { ReactNode } from 'react';
import { BackToTop } from './back-to-top';
import { LicenceBanner } from './licence-banner';
import { NewReservationLink } from './new-reservation-link';
import { SignOutButton } from './sign-out-button';

/** Top navigation, licence banner and back-to-top button of every signed-in screen. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <nav className="topnav" aria-label="Glavni meni">
        <a href="/kalendar">Kalendar</a>
        <NewReservationLink />
        <a href="/podesavanja/jedinice">Jedinice</a>
        <a href="/podesavanja/cene">Cene</a>
        <span className="spacer" />
        <SignOutButton />
      </nav>
      <LicenceBanner />
      {children}
      <BackToTop variant="app" />
    </>
  );
}
