'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarGrid } from '@/components/calendar-grid';
import { api, navigation, send } from '@/lib/api';
import { addDays, isDay, today } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import type { CalendarView, Reservation } from '@/lib/types';
import { useReadOnly } from '@/lib/use-read-only';

const LENGTHS = [14, 31] as const;

export default function CalendarPage() {
  const readOnly = useReadOnly();
  const [from, setFrom] = useState(today());
  const [length, setLength] = useState<(typeof LENGTHS)[number]>(14);
  const [view, setView] = useState<CalendarView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const start = isDay(from) ? from : today();
    const v = await api<CalendarView>(`/calendar?from=${start}&to=${addDays(start, length)}`);
    // Only the latest request paints: an older range must not overwrite a newer one.
    if (seq === loadSeq.current) setView(v);
  }, [from, length]);

  useEffect(() => {
    load().catch((err: unknown) => setError(messageFor(err)));
  }, [load]);

  async function assign(stayId: string, reservationId: string, unitId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // assign-unit needs the reservation's current version; the calendar does not carry it.
      const r = await api<Reservation>(`/reservations/${reservationId}`);
      await api(`/stays/${stayId}/assign-unit`, send('POST', { unitId, version: r.version }));
      const name = view?.units.find((u) => u.id === unitId)?.name ?? '';
      setNotice(`Boravak je dodeljen jedinici ${name}.`);
      await load();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wide">
      <div className="head-row">
        <h1>Kalendar</h1>
        <button type="button" disabled={readOnly} onClick={() => navigation.go('/rezervacije/nova')}>
          Nova rezervacija
        </button>
      </div>
      <div className="row">
        <button type="button" className="secondary" onClick={() => setFrom(addDays(isDay(from) ? from : today(), -7))}>
          ‹ Nedelju ranije
        </button>
        <label>
          Od
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Prikaz
          <select value={length} onChange={(e) => setLength(Number(e.target.value) === 31 ? 31 : 14)}>
            <option value={14}>14 dana</option>
            <option value={31}>31 dan</option>
          </select>
        </label>
        <button type="button" className="secondary" onClick={() => setFrom(today())}>
          Danas
        </button>
        <button type="button" className="secondary" onClick={() => setFrom(addDays(isDay(from) ? from : today(), 7))}>
          Nedelju kasnije ›
        </button>
      </div>
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
      {!view && !error && <p className="muted">Učitavanje…</p>}
      {view && (
        <>
          <p className="help">
            Klik na slobodan dan jedinice otvara novu rezervaciju. Nedodeljen boravak prevucite na jedinicu njegovog
            tipa ili izaberite jedinicu ispod kalendara. Traka sa isprekidanom ivicom traje i van prikazanih dana.
          </p>
          <CalendarGrid
            view={view}
            readOnly={readOnly || busy}
            onPickCell={(unitId, day) => navigation.go(`/rezervacije/nova?unitId=${unitId}&arrival=${day}`)}
            onAssign={(stayId, reservationId, unitId) => void assign(stayId, reservationId, unitId)}
          />
        </>
      )}
    </main>
  );
}
