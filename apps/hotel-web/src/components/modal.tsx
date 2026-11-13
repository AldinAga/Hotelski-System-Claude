'use client';

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface Props {
  title: string;
  /** Escape and the cancel button call this; it is ignored while `busy`. */
  onClose: () => void;
  /** A request is running: Escape does not close the dialog. */
  busy?: boolean;
  children: ReactNode;
}

/**
 * A labelled modal dialog. Focus moves to its heading when it opens, Tab and
 * Shift+Tab stay inside it, Escape closes it, and focus goes back to what had
 * it before (or to the page heading when that element is gone). Not the native
 * <dialog>: its modal API is not available in every test and browser we run.
 */
export function Modal({ title, onClose, busy = false, children }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    document.body.classList.add('modal-open');
    return () => {
      document.body.classList.remove('modal-open');
      if (opener?.isConnected) opener.focus();
      else document.querySelector<HTMLElement>('main h1')?.focus();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === headingRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-backdrop">
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="modal-title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
