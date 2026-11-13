'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { guestsLabel } from '@/lib/business';
import { formatDay, nightsLabel } from '@/lib/format';

interface Props {
  /** The open business day being closed (YYYY-MM-DD). */
  day: string;
  /** From the server's pending counts: nights the close posts and guests it marks as no-show. */
  nightsToPost: number;
  noShows: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The confirmation of closing the day. A labelled modal dialog: focus moves to
 * its heading when it opens, Tab stays inside it, Escape cancels, and focus goes
 * back to whatever had it before when the dialog goes away.
 */
export function CloseDayDialog({ day, nightsToPost, noShows, busy, onConfirm, onCancel }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    return () => before?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
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
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="dialog card stack"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-day-title"
        aria-describedby="close-day-text"
        onKeyDown={onKeyDown}
      >
        <h2 id="close-day-title" tabIndex={-1} ref={headingRef}>
          {`Zatvaranje dana ${formatDay(day)}`}
        </h2>
        <p id="close-day-text">
          {`Proknjižiće se ${nightsLabel(nightsToPost)}. Za ${guestsLabel(noShows)} se beleži „nije došao“. Posle toga se otvara sledeći poslovni dan. Zatvaranje se ne može poništiti.`}
        </p>
        <div className="stay-actions">
          <button type="button" disabled={busy} onClick={onConfirm}>
            Potvrdi zatvaranje
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
            Odustani
          </button>
        </div>
      </div>
    </div>
  );
}
