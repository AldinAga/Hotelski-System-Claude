'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, api, send } from '@/lib/api';
import { formatDay, formatRsd } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import type { LicenceMode } from '@/lib/use-read-only';
import type { UserRole } from '@/lib/use-role';
import type { CheckOutPreview, Reservation, ReservationStay } from '@/lib/types';

interface Props {
  stay: ReservationStay;
  reservation: Reservation;
  /** The open business day (YYYY-MM-DD), or null while it is not known. */
  businessDate: string | null;
  /** The property's calendar date and how far the business day lags behind it (GET /business-day); 0 while unknown. */
  today?: string | null;
  lagDays?: number;
  /** The signed-in role, or null while it is not known. */
  role?: UserRole | null;
  /** Check-out works in safe mode (EXPIRED), nothing at all without a usable licence, check-in only with a full one. */
  licence: LicenceMode;
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
export function StayActions({ stay, reservation, businessDate, today = null, lagDays = 0, role = null, licence, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  // The night(s) lost to an unclosed day were read and understood (asked again for every preview).
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CheckOutPreview | null>(null);
  // State updates land after the next click can already fire; the ref closes that gap.
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const checkOutRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    setUnderstood(false);
    if (preview) {
      wasOpen.current = true;
      headingRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      checkOutRef.current?.focus();
    }
  }, [preview]);

  const expected = stay.status === 'expected';
  const confirmed = reservation.status === 'confirmed';
  const canCheckIn = expected && confirmed && businessDate !== null && stay.arrival === businessDate;
  // The API refuses check-in unless the reservation is confirmed: say so where the button would be.
  const needsConfirmation = expected && reservation.status === 'requested' && businessDate !== null && stay.arrival === businessDate;
  // Today's guest while yesterday's business day is still open: check-in waits for the close.
  const dayIsLate = lagDays > 0 && businessDate !== null;
  const waitsForClose = dayIsLate && expected && confirmed && stay.arrival > businessDate && today !== null && stay.arrival <= today;
  const arrivesLater = expected && businessDate !== null && stay.arrival > businessDate && !waitsForClose;
  const inHouse = stay.status === 'in_house';
  // The API keeps the stay until the open day, so every night before today it gives back is lost to the unclosed day.
  const lostNights = dayIsLate && today !== null && preview ? preview.nightsToRelease.filter((n) => n < today) : [];
  const plural = lostNights.length > 1;

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

  if (!canCheckIn && !needsConfirmation && !arrivesLater && !waitsForClose && !inHouse && !error) return null;

  return (
    <div className="stay-block">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {waitsForClose && businessDate !== null && (
        <p className="warn">
          {`Poslovni dan ${formatDay(businessDate)} nije zatvoren. `}
          {licence === 'full' && (
            <>
              <a href="/poslovni-dan">Zatvorite dan</a>
              {' da biste prijavili gosta.'}
            </>
          )}
          {licence === 'safe' && (
            <>
              {'Licenca je istekla, pa prijava gosta nije moguća. Dan možete zatvoriti na ekranu '}
              <a href="/poslovni-dan">Poslovni dan</a>
              {'.'}
            </>
          )}
          {licence === 'none' && 'Licenca nije ispravna, pa prijava gosta nije moguća.'}
        </p>
      )}
      {needsConfirmation && <p className="muted">Rezervacija nije potvrđena, pa se gost ne može prijaviti.</p>}
      {!preview && (canCheckIn || arrivesLater || inHouse) && (
        <div className="stay-actions">
          {canCheckIn && (
            <button type="button" disabled={busy || licence !== 'full'} onClick={() => void checkIn()}>
              Prijavi gosta
            </button>
          )}
          {arrivesLater && <span className="muted">{`Dolazak ${dayMonth(stay.arrival)}`}</span>}
          {inHouse && (
            <button type="button" ref={checkOutRef} disabled={busy || licence === 'none'} onClick={() => void openPreview()}>
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
          {lostNights.length > 0 && (
            <div className="warn">
              <p>
                {`${plural ? 'Noći' : 'Noć'} ${lostNights.map(formatDay).join(', ')} ${plural ? 'neće biti naplaćene' : 'neće biti naplaćena'} jer poslovni dan ${formatDay(preview.businessDate)} nije zatvoren.`}
              </p>
              <p>
                <a href="/poslovni-dan">Zatvorite dan</a>
                {', pa onda odjavite gosta. Ili potvrdite da gost odlazi bez naplate.'}
              </p>
              <label className="check">
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                {`Razumem da ${plural ? 'noći neće biti naplaćene' : 'noć neće biti naplaćena'} i odjavljujem gosta.`}
              </label>
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
          {preview.balanceMinor < 0 && role === 'receptionist' && <div>Povraćaj preplate radi menadžer ili vlasnik.</div>}
          <div className="stay-actions">
            {preview.balanceMinor === 0 && (
              <button type="button" disabled={busy || licence === 'none' || (lostNights.length > 0 && !understood)} onClick={() => void checkOut()}>
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
