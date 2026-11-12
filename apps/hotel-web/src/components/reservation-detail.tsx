'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, send } from '@/lib/api';
import { formatDate, formatDay, formatRsd, nightsBetween, nightsLabel } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import {
  RESERVATION_STATUS_LABELS,
  STAY_STATUS_LABELS,
  typeLabel,
  type Reservation,
  type Unit,
  type UnitType,
} from '@/lib/types';
import { useLicenceMode } from '@/lib/use-read-only';
import { ReservationMessages } from './reservation-messages';
import { StayActions } from './stay-actions';
import { StayGuests } from './stay-guests';

const CANCELLABLE = new Set(['requested', 'confirmed']);
/**
 * A stay of a typed booking can be put on (or moved to) another active unit
 * of its type while it is live. A stay on an untyped unit is booked on that
 * unit itself and cannot move. Every role that can open this page (owner,
 * manager, receptionist) may assign: the API refuses housekeeping both.
 */
const MOVABLE_STAY = new Set(['expected', 'in_house']);
const MOVABLE_RESERVATION = new Set(['requested', 'confirmed']);

/** One reservation with the real stay dates (the calendar shows them clipped to its range). */
export function ReservationDetail({ id }: { id: string }) {
  const licence = useLicenceMode();
  const readOnly = licence !== 'full';
  const [r, setR] = useState<Reservation | null>(null);
  const [businessDate, setBusinessDate] = useState<string | null>(null);
  const [names, setNames] = useState<{ types: Map<string, UnitType>; units: Map<string, Unit> }>({
    types: new Map(),
    units: new Map(),
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const [res, types, units, day] = await Promise.all([
      api<Reservation>(`/reservations/${id}`),
      api<UnitType[]>('/unit-types'),
      api<Unit[]>('/units'),
      // Without the open day check-in is simply not offered; the page still works.
      api<{ day: string }>('/business-day').then((b) => b.day, () => null),
    ]);
    setR(res);
    setBusinessDate(day);
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

  /** POST /stays/:id/assign-unit with the version this screen read; the page is read again either way. */
  async function moveStay(stayId: string, unitId: string, assigned: boolean) {
    if (!r) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/stays/${stayId}/assign-unit`, send('POST', { unitId, version: r.version }));
      const name = names.units.get(unitId)?.name ?? '';
      setNotice(assigned ? `Boravak je premešten na jedinicu ${name}.` : `Boravku je dodeljena jedinica ${name}.`);
    } catch (err) {
      // version_conflict, unit_taken, unit_blocked, …: the dictionary message,
      // then the current state (new version, where the stay really is).
      setError(messageFor(err));
    } finally {
      await load().catch(() => undefined);
      setBusy(false);
    }
  }

  /** After check-in, check-out or a refusal that means this page is out of date: show the text, read it again. */
  async function changed(text?: string) {
    setNotice(text ?? null);
    await load().catch((err: unknown) => setError(messageFor(err)));
  }

  const canCancel =
    r !== null && CANCELLABLE.has(r.status) && !r.stays.some((s) => s.status === 'in_house' || s.status === 'checked_out');

  return (
    <main>
      <p>
        <a href="/kalendar">‹ Kalendar</a>
      </p>
      <h1 tabIndex={-1}>{r ? `Rezervacija ${r.number}` : 'Rezervacija'}</h1>
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
                      nightsLabel(nightsBetween(s.arrival, s.departure)),
                      type ? typeLabel(type) : null,
                      unit ? unit.name : 'Jedinica nije dodeljena',
                      `${s.adults} odr.${s.children ? ` + ${s.children} dece` : ''}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div>{`Iznos: ${formatRsd(s.totalMinor)}`}</div>
                  {s.unitTypeId !== null && MOVABLE_STAY.has(s.status) && MOVABLE_RESERVATION.has(r.status) && (
                    <StayUnitPicker
                      key={`${s.id}:${s.unitId ?? ''}`}
                      currentUnitId={s.unitId}
                      units={[...names.units.values()].filter(
                        (u) => u.unitTypeId === s.unitTypeId && (u.active || u.id === s.unitId),
                      )}
                      disabled={busy || readOnly}
                      onMove={(unitId) => void moveStay(s.id, unitId, s.unitId !== null)}
                    />
                  )}
                  <StayActions
                    stay={s}
                    reservation={r}
                    businessDate={businessDate}
                    licence={licence}
                    onChanged={changed}
                  />
                  <StayGuests stay={s} readOnly={readOnly} />
                </li>
              );
            })}
          </ul>
          <p>
            <strong>{`Ukupno: ${formatRsd(r.totalMinor)}`}</strong>
          </p>

          <ReservationMessages reservationId={r.id} readOnly={readOnly} />

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

/** The unit select of one stay: "Dodeli" when it has none yet, "Premesti" when it has one. Wraps at 375 px. */
function StayUnitPicker(props: {
  currentUnitId: string | null;
  units: Unit[];
  disabled: boolean;
  onMove: (unitId: string) => void;
}) {
  const [unitId, setUnitId] = useState(props.currentUnitId ?? '');
  const assigned = props.currentUnitId !== null;
  return (
    <div className="row">
      <label>
        Jedinica
        <select value={unitId} onChange={(e) => setUnitId(e.target.value)} disabled={props.disabled}>
          {!assigned && <option value="">Izaberite jedinicu</option>}
          {props.units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={props.disabled || unitId === '' || unitId === props.currentUnitId}
        onClick={() => props.onMove(unitId)}
      >
        {assigned ? 'Premesti' : 'Dodeli'}
      </button>
    </div>
  );
}
