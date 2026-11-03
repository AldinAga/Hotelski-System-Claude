'use client';

import { useEffect, useState } from 'react';

/**
 * Fixed bottom-right button that appears once the page has scrolled past the
 * first screen. Scrolls back smoothly (instantly with reduced motion) and
 * moves focus to the page heading, so keyboard users land at the top too.
 */
export function BackToTop({
  label = 'Nazad na vrh',
  variant = 'portal',
}: {
  label?: string;
  /** 'app' drops the portal glass for the light signed-in app (globals.css). */
  variant?: 'portal' | 'app';
}) {
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
    const heading =
      document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1');
    if (!heading) return;
    // A heading is not focusable on its own; -1 makes focus() work without adding a tab stop.
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }

  return (
    <button
      type="button"
      className={['back-to-top', variant === 'app' && 'back-to-top--app', visible && 'is-visible']
        .filter(Boolean)
        .join(' ')}
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
