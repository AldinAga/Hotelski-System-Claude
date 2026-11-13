'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, send } from '@/lib/api';
import { messageFor } from '@/lib/messages';
import type { Guest, ReservationStay, StayGuest } from '@/lib/types';

/** Guests can be changed while the stay is waiting or in the house (the API refuses the rest). */
const EDITABLE = new Set(['expected', 'in_house']);

const fullName = (g: Pick<Guest, 'firstName' | 'lastName'>) => `${g.firstName} ${g.lastName}`;

/** The guests of one stay: who they are, who holds the stay, add, remove, change the holder. */
export function StayGuests({ stay, readOnly }: { stay: ReservationStay; readOnly: boolean }) {
  const [guests, setGuests] = useState<StayGuest[]>(stay.guests);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Guest[] | null>(null);
  const [fresh, setFresh] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const inFlight = useRef(false);
  const addRef = useRef<HTMLButtonElement>(null);

  // The page read the reservation again: its guests win over what this list holds.
  useEffect(() => {
    setGuests(stay.guests);
  }, [stay.guests]);

  const capacity = stay.adults + stay.children;
  const full = guests.length >= capacity;
  const editable = EDITABLE.has(stay.status);

  async function once(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const base = `/stays/${stay.id}/guests`;

  function closeAdding() {
    setAdding(false);
    setQuery('');
    setFound(null);
    setFresh({ firstName: '', lastName: '', email: '', phone: '' });
    // The form is gone: keep the keyboard where the person was.
    requestAnimationFrame(() => addRef.current?.focus());
  }

  function search(e: FormEvent) {
    e.preventDefault();
    return once(async () => {
      setFound(await api<Guest[]>(`/guests?q=${encodeURIComponent(query.trim())}`));
    });
  }

  function addExisting(guestId: string) {
    return once(async () => {
      setGuests(await api<StayGuest[]>(base, send('POST', { guestId })));
      closeAdding();
    });
  }

  function addNew(e: FormEvent) {
    e.preventDefault();
    const firstName = fresh.firstName.trim();
    const lastName = fresh.lastName.trim();
    if (!firstName || !lastName) {
      setError('Unesite ime i prezime gosta.');
      return;
    }
    const email = fresh.email.trim();
    const phone = fresh.phone.trim();
    return once(async () => {
      const guest = { firstName, lastName, ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
      setGuests(await api<StayGuest[]>(base, send('POST', { guest })));
      closeAdding();
    });
  }

  function remove(guestId: string) {
    return once(async () => {
      setGuests(await api<StayGuest[]>(`${base}/${guestId}`, send('DELETE')));
    });
  }

  function makePrimary(guestId: string) {
    return once(async () => {
      setGuests(await api<StayGuest[]>(`${base}/${guestId}/primary`, send('POST')));
    });
  }

  const alreadyOn = new Set(guests.map((g) => g.id));
  const matches = found?.filter((g) => !alreadyOn.has(g.id)) ?? null;
  const off = busy || readOnly;

  return (
    <div className="stay-block">
      <h3 className="stay-subhead">{`Gosti (${guests.length} od ${capacity})`}</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {guests.length === 0 ? (
        <p className="muted">Gosti još nisu uneti. Nosilac rezervacije se upisuje pri prijavi.</p>
      ) : (
        <ul className="list guests">
          {guests.map((g) => (
            <li key={g.id} aria-label={fullName(g)}>
              <div className="head">
                <span>
                  <strong>{fullName(g)}</strong>
                  {g.isPrimary && <span className="badge">Nosilac</span>}
                </span>
                {editable && !g.isPrimary && (
                  <span className="stay-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={off}
                      aria-label={`Postavi kao nosioca: ${fullName(g)}`}
                      onClick={() => void makePrimary(g.id)}
                    >
                      Postavi kao nosioca
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={off}
                      aria-label={`Ukloni gosta ${fullName(g)}`}
                      onClick={() => void remove(g.id)}
                    >
                      Ukloni
                    </button>
                  </span>
                )}
              </div>
              {(g.email || g.phone) && <div className="muted">{[g.email, g.phone].filter(Boolean).join(' · ')}</div>}
            </li>
          ))}
        </ul>
      )}

      {editable && !adding && (
        <div className="stay-actions">
          <button type="button" ref={addRef} className="secondary" disabled={off || full} onClick={() => setAdding(true)}>
            Dodaj gosta
          </button>
          {full && <span className="muted">Boravak je pun: nema mesta za još jednog gosta.</span>}
        </div>
      )}

      {editable && adding && (
        <section className="card stack" aria-label="Dodavanje gosta">
          <form className="stack" onSubmit={(e) => void search(e)}>
            <label>
              Pretraga gostiju
              <input
                type="search"
                value={query}
                maxLength={100}
                placeholder="Ime, prezime, e-adresa ili telefon"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="stay-actions">
              <button type="submit" className="secondary" disabled={off}>
                Traži
              </button>
            </div>
          </form>
          {matches !== null &&
            (matches.length === 0 ? (
              <p className="muted">Nema gostiju koji odgovaraju pretrazi.</p>
            ) : (
              <ul className="list guests" aria-label="Pronađeni gosti">
                {matches.map((g) => (
                  <li key={g.id} aria-label={fullName(g)}>
                    <div className="head">
                      <span>
                        <strong>{fullName(g)}</strong>
                        {(g.email || g.phone) && (
                          <span className="muted">{` ${[g.email, g.phone].filter(Boolean).join(' · ')}`}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        disabled={off || full}
                        aria-label={`Dodaj gosta ${fullName(g)}`}
                        onClick={() => void addExisting(g.id)}
                      >
                        Dodaj
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ))}
          <form className="stack" onSubmit={(e) => void addNew(e)}>
            <strong>Novi gost</strong>
            <div className="row">
              <label>
                Ime
                <input
                  value={fresh.firstName}
                  autoComplete="off"
                  required
                  onChange={(e) => setFresh({ ...fresh, firstName: e.target.value })}
                />
              </label>
              <label>
                Prezime
                <input
                  value={fresh.lastName}
                  autoComplete="off"
                  required
                  onChange={(e) => setFresh({ ...fresh, lastName: e.target.value })}
                />
              </label>
            </div>
            <div className="row">
              <label>
                E-adresa
                <input
                  type="email"
                  value={fresh.email}
                  autoComplete="off"
                  onChange={(e) => setFresh({ ...fresh, email: e.target.value })}
                />
              </label>
              <label>
                Telefon
                <input
                  type="tel"
                  value={fresh.phone}
                  autoComplete="off"
                  onChange={(e) => setFresh({ ...fresh, phone: e.target.value })}
                />
              </label>
            </div>
            <div className="stay-actions">
              <button type="submit" disabled={off || full}>
                Dodaj novog gosta
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={closeAdding}>
                Zatvori
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
