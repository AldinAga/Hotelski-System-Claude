'use client';

import { useReadOnly } from '@/lib/use-read-only';

/** "Nova rezervacija" in the top menu: plain text, not a link, while changes are refused (safe mode). */
export function NewReservationLink() {
  const readOnly = useReadOnly();
  if (readOnly) {
    return (
      <span className="nav-disabled" aria-disabled="true" title="Licenca je istekla: nova rezervacija nije moguća.">
        Nova rezervacija
      </span>
    );
  }
  return <a href="/rezervacije/nova">Nova rezervacija</a>;
}
