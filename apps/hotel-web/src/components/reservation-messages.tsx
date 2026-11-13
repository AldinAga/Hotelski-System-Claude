'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, send } from '@/lib/api';
import { messageFor } from '@/lib/messages';
import type { ReservationMessage } from '@/lib/types';

const TEMPLATE_LABELS: Record<ReservationMessage['template'], string> = {
  reservation_confirmed: 'Potvrda rezervacije',
  reservation_cancelled: 'Otkazivanje rezervacije',
};

/** What the person at the desk reads for the state of one e-mail. */
function statusText(m: ReservationMessage): string {
  switch (m.status) {
    case 'sent':
      return 'Poslato';
    case 'pending':
    case 'sending':
      return 'Čeka slanje';
    case 'skipped':
      // Without an address: no one to write to. With one: the confirmation was closed because the reservation was cancelled.
      return m.recipient === null ? 'Gost nema e-adresu' : (m.lastError ?? 'Poruka nije poslata');
    case 'failed':
      return m.lastError ? `Nije poslato: ${m.lastError}` : 'Nije poslato';
  }
}

/** The e-mails sent to the guest of one reservation, with a resend for the ones that did not go out. */
export function ReservationMessages({ reservationId, readOnly = false }: { reservationId: string; readOnly?: boolean }) {
  const [messages, setMessages] = useState<ReservationMessage[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      setMessages(await api<ReservationMessage[]>(`/reservations/${reservationId}/messages`));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [reservationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resend(id: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api(`/messages/${id}/resend`, send('POST'));
    } catch (err) {
      setError(messageFor(err));
    } finally {
      // Either way the list is read again: the message may have been sent in the meantime.
      await load();
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="reservation-messages">
      <h2 id="reservation-messages">Poruke gostu</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loadFailed && <p className="muted">Poruke trenutno ne mogu da se učitaju.</p>}
      {messages !== null && messages.length === 0 && <p className="muted">Gostu još nije poslata nijedna poruka.</p>}
      {messages !== null && messages.length > 0 && (
        <ul className="list">
          {messages.map((m) => (
            <li key={m.id} aria-label={TEMPLATE_LABELS[m.template] ?? m.template}>
              <div className="head">
                <strong>{TEMPLATE_LABELS[m.template] ?? m.template}</strong>
                <span className="badge">{statusText(m)}</span>
              </div>
              {m.recipient && <div className="muted">{m.recipient}</div>}
              {m.status === 'failed' && (
                <div className="stay-actions">
                  <button type="button" className="secondary" disabled={busy || readOnly} onClick={() => void resend(m.id)}>
                    Pošalji ponovo
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
