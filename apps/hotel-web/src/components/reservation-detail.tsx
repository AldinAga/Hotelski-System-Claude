'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, send } from '@/lib/api';
import { formatDate, formatDay, formatRsd, nightsBetween } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import {
  RESERVATION_STATUS_LABELS,
  STAY_STATUS_LABELS,
  typeLabel,
  type Reservation,
  type Unit,
  type UnitType,
} from '@/lib/types';
import { useReadOnly } from '@/lib/use-read-only';

const CANCELLABLE = new Set(['requested', 'confirmed']);

/** One reservation with the real stay dates (the calendar shows them clipped to its range). */
export function ReservationDetail({ id }: { id: string }) {
  const readOnly = useReadOnly();
  const [r, setR] = useState<Reservation | null>(null);
  const [names, setNames] = useState<{ types: Map<string, UnitType>; units: Map<string, Unit> }>({
    types: new Map(),
    units: new Map(),
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const [res, types, units] = await Promise.all([
      api<Reservation>(`/reservations/${id}`),
      api<UnitType[]>('/unit-types'),
      api<Unit[]>('/units'),
    ]);
    setR(res);
    setNames({ types: new Map(types.map((t) => [t.id, t])), units: new Map(units.map((u) => [u.id, u])) });
  }, [id]);

  useEffect(() => {
    load().catch((err: unknown) => setError(messageFor(err)));
  }, [load]);

  async function cancel() {
    if (!r) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/reservations/${r.id}/cancel`, send('POST', { version: r.version }));
      setNotice('Rezervacija je otkazana.');
      setConfirming(false);
      await load();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  const canCancel =
    r !== null && CANCELLABLE.has(r.status) && !r.stays.some((s) => s.status === 'in_house' || s.status === 'checked_out');

  return (
    <main>
      <p>
        <a href="/kalendar">‹ Kalendar</a>
      </p>
      <h1>{r ? `Rezervacija ${r.number}` : 'Rezervacija'}</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!r && !error && <p className="muted">Učitavanje…</p>}
      {r && (
        <>
          <div className="card stack">
            <div className="head">
              <strong>{`${r.holder.firstName} ${r.holder.lastName}`}</strong>
              <span className="badge">{RESERVATION_STATUS_LABELS[r.status] ?? r.status}</span>
            </div>
            {(r.holder.email || r.holder.phone) && (
              <div className="muted">{[r.holder.email, r.holder.phone].filter(Boolean).join(' · ')}</div>
            )}
            {r.note && <div>{r.note}</div>}
            <div className="muted">{`Napravljena ${formatDate(r.createdAt)}`}</div>
          </div>

          <h2>Boravci</h2>
          <ul className="list">
            {r.stays.map((s) => {
              const unit = s.unitId ? names.units.get(s.unitId) : undefined;
              const type = s.unitTypeId ? names.types.get(s.unitTypeId) : undefined;
              return (
                <li key={s.id} aria-label={`Boravak ${formatDay(s.arrival)} – ${formatDay(s.departure)}`}>
                  <div className="head">
                    <strong>{`${formatDay(s.arrival)} – ${formatDay(s.departure)}`}</strong>
                    <span className="badge">{STAY_STATUS_LABELS[s.status] ?? s.status}</span>
                  </div>
                  <div className="muted">
                    {[
                      `${nightsBetween(s.arrival, s.departure)} noći`,
                      type ? typeLabel(type) : null,
                      unit ? unit.name : 'Jedinica nije dodeljena',
                      `${s.adults} odr.${s.children ? ` + ${s.children} dece` : ''}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div>{`Iznos: ${formatRsd(s.totalMinor)}`}</div>
                </li>
              );
            })}
          </ul>
          <p>
            <strong>{`Ukupno: ${formatRsd(r.totalMinor)}`}</strong>
          </p>

          {canCancel && (
            <div className="card stack">
              {!confirming ? (
                <div className="row">
                  <button type="button" className="danger" disabled={busy || readOnly} onClick={() => setConfirming(true)}>
                    Otkaži rezervaciju
                  </button>
                </div>
              ) : (
                <>
                  <span>Otkazivanje oslobađa sve noći ove rezervacije. Nastaviti?</span>
                  <div className="row">
                    <button type="button" className="danger" disabled={busy || readOnly} onClick={() => void cancel()}>
                      Da, otkaži
                    </button>
                    <button type="button" className="secondary" onClick={() => setConfirming(false)}>
                      Ne
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}
