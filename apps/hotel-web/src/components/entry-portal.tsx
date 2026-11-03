import type { ReactNode } from 'react';
import { BackToTop } from './back-to-top';

/** Concierge bell: the front desk's mark. */
function BellMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M12 6.5V8" />
      <path d="M10.25 6.5h3.5" />
      <path d="M5.5 16.5a6.5 6.5 0 0 1 13 0" />
      <path d="M3.5 16.5h17" />
      <path d="M5 19.5h14" />
    </svg>
  );
}

/**
 * The glass frame of the screens before sign-in (/prijava, /aktivacija):
 * blurred colour blobs, the "Recepcija" wordmark and one frosted card holding
 * the page's heading and form. Styles: .portal* in globals.css.
 */
export function EntryPortal({
  title,
  lead,
  wide = false,
  children,
}: {
  title: string;
  lead?: string;
  /** The setup wizard needs a little more room than the sign-in form. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="portal">
      <div className="portal-backdrop" aria-hidden="true">
        <span className="portal-blob portal-blob-1" />
        <span className="portal-blob portal-blob-2" />
        <span className="portal-blob portal-blob-3" />
      </div>
      <main className="portal-main">
        <div className="portal-brand">
          <span className="portal-mark">
            <BellMark />
          </span>
          <span className="portal-wordmark">
            Recepcija
            <small>Hotelski sistem</small>
          </span>
        </div>
        <section className={wide ? 'portal-card portal-wide' : 'portal-card'} aria-labelledby="portal-title">
          <h1 id="portal-title" tabIndex={-1}>
            {title}
          </h1>
          {lead && <p className="portal-lead">{lead}</p>}
          {children}
        </section>
      </main>
      <BackToTop />
    </div>
  );
}
