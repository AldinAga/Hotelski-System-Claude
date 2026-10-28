'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, navigation, send } from '@/lib/api';
import { addDays, formatDay, formatRsd, isDay, nightsBetween, today } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import { typeLabel, type Quote, type RatePlan, type Unit, type UnitType } from '@/lib/types';
import { useReadOnly } from '@/lib/use-read-only';

interface Options {
  types: UnitType[];
  units: Unit[];
  plans: RatePlan[];
}

/** "type:<id>" or "unit:<id>": what the stay is booked on. */
type Target = string;

function nightsLabel(n: number): string {
  const ten = n % 10;
  const hundred = n % 100;
  if (ten === 1 && hundred !== 11) return `${n} noć`;
  return `${n} noći`;
}

export default function NewReservationPage() {
  const readOnly = useReadOnly();
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [arrival, setArrival] = useState(today());
  const [departure, setDeparture] = useState(addDays(today(), 1));
  const [target, setTarget] = useState<Target>('');
  const [adults, setAdults] = useState('2');
  const [children, setChildren] = useState('0');
  const [planId, setPlanId] = useState('');
  const [note, setNote] = useState('');

  /** The quote and the exact body it was made for. */
  const [quote, setQuote] = useState<{ key: string; value: Quote } | null>(null);

  useEffect(() => {
    // Opened from a calendar cell: /rezervacije/nova?unitId=…&arrival=…
    const q = new URLSearchParams(window.location.search);
    const a = q.get('arrival');
    if (a && isDay(a)) {
      setArrival(a);
      setDeparture(addDays(a, 1));
    }
    const unitId = q.get('unitId');
    if (unitId) setTarget(`unit:${unitId}`);

    let live = true;
    Promise.all([api<UnitType[]>('/unit-types'), api<Unit[]>('/units'), api<RatePlan[]>('/rate-plans')])
      .then(([types, units, plans]) => {
        if (!live) return;
        setOptions({ types, units, plans });
        const active = plans.filter((p) => p.active);
        if (active.length > 0) setPlanId((cur) => cur || active[0].id);
      })
      .catch((err: unknown) => {
        if (live) setError(messageFor(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const body = useMemo(() => {
    const [kind, id] = target.split(':');
    const holder: Record<string, string> = { firstName: firstName.trim(), lastName: lastName.trim() };
    if (email.trim()) holder.email = email.trim();
    if (phone.trim()) holder.phone = phone.trim();
    const stay: Record<string, unknown> = {
      ...(kind === 'type' ? { unitTypeId: id } : kind === 'unit' ? { unitId: id } : {}),
      arrival,
      departure,
      adults: Number(adults),
      children: Number(children),
      ratePlanId: planId,
    };
    return {
      source: 'front_desk',
      holder,
      ...(note.trim() ? { note: note.trim() } : {}),
      stays: [stay],
    };
  }, [firstName, lastName, email, phone, arrival, departure, target, adults, children, planId, note]);
  const bodyKey = JSON.stringify(body);
  const current = quote && quote.key === bodyKey ? quote.value : null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      // The form stays as typed, so the dates or the unit can be changed and tried again.
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  function calculate(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      setQuote(null);
      const value = await api<Quote>('/reservations/quote', send('POST', body));
      setQuote({ key: bodyKey, value });
    });
  }

  function confirm() {
    void run(async () => {
      const res = await api<{ reservationId: string; number: string }>('/reservations', send('POST', body));
      navigation.go(`/rezervacije/${res.reservationId}`);
    });
  }

  const activeTypes = (options?.types ?? []).filter((t) => t.active);
  const activeUnits = (options?.units ?? []).filter((u) => u.active);
  const typeById = new Map((options?.types ?? []).map((t) => [t.id, t]));
  const plans = (options?.plans ?? []).filter((p) => p.active);
  const nights = isDay(arrival) && isDay(departure) ? nightsBetween(arrival, departure) : 0;

  return (
    <main>
      <p>
        <a href="/kalendar">‹ Kalendar</a>
      </p>
      <h1>Nova rezervacija</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!options && !error && <p className="muted">Učitavanje…</p>}
      {options && (
        <form className="card stack" aria-label="Nova rezervacija" onSubmit={calculate}>
          <strong>Gost</strong>
          <div className="row">
            <label>
              Ime
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={100} required />
            </label>
            <label>
              Prezime
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={100} required />
            </label>
          </div>
          <div className="row">
            <label>
              E-adresa (opciono)
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
            </label>
            <label>
              Telefon (opciono)
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={50} />
            </label>
          </div>

          <strong>Boravak</strong>
          <div className="row">
            <label>
              Dolazak
              <input type="date" value={arrival} min={today()} onChange={(e) => setArrival(e.target.value)} required />
            </label>
            <label>
              Odlazak
              <input
                type="date"
                value={departure}
                min={isDay(arrival) ? addDays(arrival, 1) : undefined}
                onChange={(e) => setDeparture(e.target.value)}
                required
              />
            </label>
          </div>
          {nights > 0 && <p className="muted">{nightsLabel(nights)}</p>}
          <div className="row">
            <label>
              Smeštaj
              <select value={target} onChange={(e) => setTarget(e.target.value)} required>
                <option value="">Izaberite tip ili jedinicu</option>
                <optgroup label="Tip (jedinica se dodeljuje kasnije)">
                  {activeTypes.map((t) => (
                    <option key={t.id} value={`type:${t.id}`}>
                      {typeLabel(t)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Jedinica">
                  {activeUnits.map((u) => {
                    const t = u.unitTypeId ? typeById.get(u.unitTypeId) : undefined;
                    return (
                      <option key={u.id} value={`unit:${u.id}`}>
                        {t ? `${u.name} (${t.code})` : u.name}
                      </option>
                    );
                  })}
                </optgroup>
              </select>
            </label>
            <label>
              Cenovnik
              <select value={planId} onChange={(e) => setPlanId(e.target.value)} required>
                {plans.length === 0 && <option value="">Nema aktivnog cenovnika</option>}
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {`${p.code} – ${p.name.sr}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label>
              Odrasli
              <input
                type="number"
                min={1}
                max={50}
                step={1}
                value={adults}
                onChange={(e) => setAdults(e.target.value)}
                required
              />
            </label>
            <label>
              Deca
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                value={children}
                onChange={(e) => setChildren(e.target.value)}
                required
              />
            </label>
          </div>
          <label>
            Napomena (opciono)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} />
          </label>
          <div className="row">
            <button type="submit" className={current ? 'secondary' : undefined} disabled={busy}>
              Izračunaj cenu
            </button>
          </div>

          {current && (
            <section className="stack" aria-label="Obračun">
              <strong>Obračun</strong>
              <table className="nights">
                <tbody>
                  {current.stays[0]?.nights.map((n) => (
                    <tr key={n.day}>
                      <td>{formatDay(n.day)}</td>
                      <td className="num">{formatRsd(n.priceMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                <strong>{`Ukupno: ${formatRsd(current.totalMinor)}`}</strong>
              </p>
              {readOnly && <p className="muted">Licenca je istekla: rezervacija se ne može potvrditi.</p>}
              <div className="row">
                <button type="button" disabled={busy || readOnly} onClick={confirm}>
                  Potvrdi rezervaciju
                </button>
              </div>
            </section>
          )}
        </form>
      )}
    </main>
  );
}
