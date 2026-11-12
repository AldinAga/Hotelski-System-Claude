'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, api, send } from '@/lib/api';
import { formatDay, formatRsd } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import type { CheckOutPreview, Reservation, ReservationStay } from '@/lib/types';

interface Props {
  stay: ReservationStay;
  reservation: Reservation;
  /** The open business day (YYYY-MM-DD), or null while it is not known. */
  businessDate: string | null;
  /** Safe mode or no usable licence: check-out still works, nothing new moves in. */
  readOnly: boolean;
  /** Called after the action (with the text to show) or after a refusal that means the page is out of date. */
  onChanged: (notice?: string) => void | Promise<void>;
}

/** "2026-11-13" → "13.11." */
function dayMonth(day: string): string {
  const full = formatDay(day);
  return full.slice(0, full.lastIndexOf('.') + 1);
}

/**
 * Check-in and check-out of one stay. Check-in is offered only on the
 * arrival day of the open business day; check-out opens a preview of what it
 * will post and release, and confirms only with a zero balance.
 */
export function StayActions({ stay, reservation, businessDate, readOnly, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CheckOutPreview | null>(null);
  // State updates land after the next click can already fire; the ref closes that gap.
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const checkOutRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (preview) {
      wasOpen.current = true;
      headingRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      checkOutRef.current?.focus();
    }
  }, [preview]);

  const expected = stay.status === 'expected';
  const canCheckIn = expected && businessDate !== null && stay.arrival === businessDate;
  const arrivesLater = expected && businessDate !== null && stay.arrival > businessDate;
  const inHouse = stay.status === 'in_house';

  async function once(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** A 409 means the stay moved on (version, day, state): show why and read the page again. */
  async function refused(err: unknown) {
    setError(messageFor(err));
    if (err instanceof ApiError && err.status === 409) {
      setPreview(null);
      await onChanged();
    }
  }

  function checkIn() {
    return once(async () => {
      try {
        await api(`/stays/${stay.id}/check-in`, send('POST', { version: reservation.version }));
        await onChanged('Gost je prijavljen.');
      } catch (err) {
        await refused(err);
      }
    });
  }

  function openPreview() {
    return once(async () => {
      try {
        setPreview(await api<CheckOutPreview>(`/stays/${stay.id}/check-out-preview`));
      } catch (err) {
        await refused(err);
      }
    });
  }

  function checkOut() {
    return once(async () => {
      try {
        await api(`/stays/${stay.id}/check-out`, send('POST', { version: reservation.version }));
        setPreview(null);
        await onChanged('Gost je odjavljen.');
      } catch (err) {
        await refused(err);
      }
    });
  }

  if (!canCheckIn && !arrivesLater && !inHouse && !error) return null;

  return (
    <div className="stay-block">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!preview && (canCheckIn || arrivesLater || inHouse) && (
        <div className="stay-actions">
          {canCheckIn && (
            <button type="button" disabled={busy || readOnly} onClick={() => void checkIn()}>
              Prijavi gosta
            </button>
          )}
          {arrivesLater && <span className="muted">{`Dolazak ${dayMonth(stay.arrival)}`}</span>}
          {inHouse && (
            <button type="button" ref={checkOutRef} disabled={busy} onClick={() => void openPreview()}>
              Odjavi gosta
            </button>
          )}
        </div>
      )}
      {preview && (
        <section className="card stack" aria-labelledby={`checkout-${stay.id}`}>
          <h4 id={`checkout-${stay.id}`} tabIndex={-1} ref={headingRef} className="stay-subhead">
            Pregled odjave
          </h4>
          {preview.nightsToPost.length > 0 ? (
            <div>
              <div>Noći koje se knjiže</div>
              <table className="nights">
                <tbody>
                  {preview.nightsToPost.map((n) => (
                    <tr key={n.night}>
                      <td>{formatDay(n.night)}</td>
                      <td className="num">{formatRsd(n.priceMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted">Nema noći za knjiženje.</div>
          )}
          {preview.earlyDeparture && (
            <div>
              {`Rani odlazak: boravak se završava ${formatDay(preview.keptUntil)}. Noći koje se oslobađaju: ${preview.nightsToRelease
                .map(formatDay)
                .join(', ')}.`}
            </div>
          )}
          <div>
            <strong>{`Saldo: ${formatRsd(preview.balanceMinor)}`}</strong>
          </div>
          {preview.balanceMinor !== 0 && (
            <div>
              {'Saldo nije nula. Naplatite ili vratite razliku na '}
              <a href={`/folio/${stay.id}`}>Folio</a>
              {', pa ponovo otvorite pregled odjave.'}
            </div>
          )}
          <div className="stay-actions">
            {preview.balanceMinor === 0 && (
              <button type="button" disabled={busy} onClick={() => void checkOut()}>
                Potvrdi odjavu
              </button>
            )}
            <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>
              Odustani
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
