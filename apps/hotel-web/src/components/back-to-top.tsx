'use client';

import { useEffect, useState } from 'react';

/**
 * Fixed bottom-right button that appears once the page has scrolled past the
 * first screen. Scrolls back smoothly (instantly with reduced motion) and
 * moves focus to the page heading, so keyboard users land at the top too.
 */
export function BackToTop({ label = 'Nazad na vrh' }: { label?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const update = () => setVisible(window.scrollY > window.innerHeight);
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  function toTop() {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    document.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }

  return (
    <button
      type="button"
      className={visible ? 'back-to-top is-visible' : 'back-to-top'}
      aria-label={label}
      title={label}
      onClick={toTop}
      tabIndex={visible ? 0 : -1}
      aria-hidden={visible ? undefined : true}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 19V5" />
        <path d="M5.5 11.5 12 5l6.5 6.5" />
      </svg>
    </button>
  );
}
