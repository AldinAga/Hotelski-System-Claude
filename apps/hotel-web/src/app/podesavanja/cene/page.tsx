'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, send } from '@/lib/api';
import { addDays, formatDay, formatRsd, isDay, nightsBetween, parseRsd, today } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import { BOARDS, typeLabel, type RateDay, type RatePlan, type Scope, type Unit, type UnitType } from '@/lib/types';

/** Days shown in the grid at once. */
const GRID_DAYS = 31;

interface ScopeOption {
  value: string;
  label: string;
  scope: Scope;
}

/**
 * Prices are entered for a unit type, or for a unit without a type. A unit
 * that has a type is sold through it, and the API refuses prices on it
 * (422 scope_not_priced), so it is not offered.
 */
function scopeOptions(types: UnitType[], units: Unit[]): ScopeOption[] {
  return [
    ...types.map((t) => ({
      value: `unit_type:${t.id}`,
      label: `Tip: ${typeLabel(t)}${t.active ? '' : ' (isključen)'}`,
      scope: { kind: 'unit_type' as const, id: t.id },
    })),
    ...units
      .filter((u) => u.unitTypeId === null)
      .map((u) => ({
        value: `unit:${u.id}`,
        label: `Jedinica bez tipa: ${u.name}${u.active ? '' : ' (isključena)'}`,
        scope: { kind: 'unit' as const, id: u.id },
      })),
  ];
}

function nightsText(n: number): string {
  return n === 1 ? '1 noć' : `${n} noći`;
}

/** "10.000" for a cell: whole dinars, para only when there are any. */
function cellPrice(minor: number): string {
  const full = formatRsd(minor).replace(' RSD', '');
  return full.endsWith(',00') ? full.slice(0, -3) : full;
}

interface Selection {
  first: string;
  last: string;
  /** The next grid click sets the other end instead of starting anew. */
  extending: boolean;
}

export default function RatesPage() {
  const [plans, setPlans] = useState<RatePlan[] | null>(null);
  const [scopes, setScopes] = useState<ScopeOption[]>([]);
  const [planId, setPlanId] = useState('');
  const [scopeValue, setScopeValue] = useState('');
  const [start, setStart] = useState(today());
  const [loaded, setLoaded] = useState<{ key: string; days: Record<string, RateDay> }>({ key: '', days: {} });
  const [daysError, setDaysError] = useState<string | null>(null);
  const daysSeq = useRef(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSetup = useCallback(async () => {
    const [p, types, units] = await Promise.all([
      api<RatePlan[]>('/rate-plans'),
      api<UnitType[]>('/unit-types'),
      api<Unit[]>('/units'),
    ]);
    const options = scopeOptions(types, units);
    setPlans(p);
    setScopes(options);
    setPlanId((cur) => (p.some((x) => x.id === cur) ? cur : (p.find((x) => x.active) ?? p[0])?.id ?? ''));
    setScopeValue((cur) => (options.some((o) => o.value === cur) ? cur : options[0]?.value ?? ''));
  }, []);

  useEffect(() => {
    loadSetup().catch((err: unknown) => setError(messageFor(err)));
  }, [loadSetup]);

  const scope = scopes.find((o) => o.value === scopeValue)?.scope;
  const gridDays = isDay(start) ? Array.from({ length: GRID_DAYS }, (_, i) => addDays(start, i)) : [];

  /** What the grid shows; prices of another plan, scope or start are never painted. */
  const gridKey = `${planId}|${scopeValue}|${start}`;
  const days = loaded.key === gridKey ? loaded.days : {};

  /**
   * Reads the grid. Only the latest request may paint or report: a slower
   * answer for a plan or scope the operator has already left is dropped.
   */
  const loadDays = useCallback(async () => {
    const seq = ++daysSeq.current;
    const key = `${planId}|${scopeValue}|${start}`;
    if (!planId || !scopeValue || !isDay(start)) {
      setLoaded({ key, days: {} });
      setDaysError(null);
      return;
    }
    const q = `scope=${encodeURIComponent(scopeValue)}&from=${start}&to=${addDays(start, GRID_DAYS)}`;
    try {
      const rows = await api<RateDay[]>(`/rate-plans/${planId}/days?${q}`);
      if (seq !== daysSeq.current) return;
      setLoaded({ key, days: Object.fromEntries(rows.map((r) => [r.day, r])) });
      setDaysError(null);
    } catch (err) {
      if (seq === daysSeq.current) setDaysError(messageFor(err));
    }
  }, [planId, scopeValue, start]);

  useEffect(() => {
    void loadDays();
  }, [loadDays]);

  function pick(day: string) {
    setNotice(null);
    setSelection((s) =>
      s && s.extending
        ? { first: day < s.first ? day : s.first, last: day < s.first ? s.first : day, extending: false }
        : { first: day, last: day, extending: true },
    );
  }

  const range =
    selection && isDay(selection.first) && isDay(selection.last) && selection.first <= selection.last
      ? { from: selection.first, to: addDays(selection.last, 1) }
      : null;

  /** One PUT for the whole selected range. */
  async function apply(change: { priceMinor: number } | { closed: boolean }, done: (n: number) => string) {
    setError(null);
    setNotice(null);
    if (!range || !scope || !planId) {
      setError('Izaberite cenovnik, za koga važi cena i dane u mreži.');
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ days: number }>(
        `/rate-plans/${planId}/days`,
        send('PUT', { scope, from: range.from, to: range.to, ...change }),
      );
      setNotice(done(res.days));
      await loadDays();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  function onSetPrice(e: FormEvent) {
    e.preventDefault();
    const minor = parseRsd(price);
    if (minor === null) {
      setError('Unesite cenu u dinarima, npr. 5.500 ili 5500,50.');
      return;
    }
    void apply({ priceMinor: minor }, (n) => `Cena ${formatRsd(minor)} je postavljena za ${nightsText(n)}.`);
  }

  async function changePlan(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await loadSetup();
      return true;
    } catch (err) {
      setError(messageFor(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Cene</h1>
      {(error ?? daysError) && (
        <p role="alert" className="error">
          {error ?? daysError}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!plans && !error && <p className="muted">Učitavanje…</p>}

      {plans && (
        <>
          <h2>Mreža cena po danu</h2>
          <div className="card stack">
            <div className="row">
              <label>
                Cenovnik
                <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${p.code} – ${p.name.sr}${p.active ? '' : ' (neaktivan)'}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Za koga važi cena
                <select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}>
                  {scopes.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Prikaz od
                <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
            </div>
            {plans.length === 0 && <p className="muted">Prvo dodajte cenovnik.</p>}
            {scopes.length === 0 && <p className="muted">Prvo dodajte tip jedinice ili jedinicu bez tipa.</p>}
            <p className="help">
              Kliknite prvi, pa poslednji dan opsega (ili unesite datume ispod), pa postavite cenu ili zatvorite dane:
              ceo opseg menja se jednom akcijom. Uneta cena se ne može obrisati; može se zameniti novom cenom ili se dan
              može zatvoriti za prodaju. Jedinica koja ima tip prodaje se po ceni tipa.
            </p>

            {planId && scope && (
              <div className="grid" role="group" aria-label="Dani">
                {gridDays.map((d) => {
                  const r = days[d];
                  const selected = range !== null && d >= range.from && d < range.to;
                  const status = r?.priceMinor != null ? formatRsd(r.priceMinor) : 'bez cene';
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`day${r?.closed ? ' closed' : ''}${selected ? ' selected' : ''}`}
                      aria-label={`${d}, ${status}${r?.closed ? ', zatvoreno' : ''}`}
                      aria-pressed={selected}
                      onClick={() => pick(d)}
                    >
                      <span className="num">{formatDay(d).split('.').slice(0, 2).join('.')}.</span>
                      <span>{r?.priceMinor != null ? cellPrice(r.priceMinor) : '—'}</span>
                      {r?.closed && <span>zatvoreno</span>}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="row">
              <label>
                Prvi dan
                <input
                  type="date"
                  value={selection?.first ?? ''}
                  onChange={(e) =>
                    setSelection((s) => ({ first: e.target.value, last: s?.last ?? e.target.value, extending: false }))
                  }
                />
              </label>
              <label>
                Poslednji dan
                <input
                  type="date"
                  value={selection?.last ?? ''}
                  onChange={(e) =>
                    setSelection((s) => ({ first: s?.first ?? e.target.value, last: e.target.value, extending: false }))
                  }
                />
              </label>
            </div>
            {range && (
              <p>{`Izabrano: ${formatDay(range.from)} – ${formatDay(addDays(range.to, -1))} (${nightsText(nightsBetween(range.from, range.to))})`}</p>
            )}

            <form className="row" onSubmit={onSetPrice} aria-label="Cena za izabrane dane">
              <label>
                Cena po noći (RSD)
                <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="npr. 5.500" />
              </label>
              <button type="submit" disabled={busy}>
                Postavi cenu
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => apply({ closed: true }, (n) => `Zatvoreno: ${nightsText(n)}.`)}
              >
                Zatvori dane
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => apply({ closed: false }, (n) => `Otvoreno: ${nightsText(n)}.`)}
              >
                Otvori dane
              </button>
            </form>
          </div>

          <h2>Cenovnici</h2>
          <ul className="list">
            {plans.map((p) => (
              <li key={p.id} aria-label={`${p.code} – ${p.name.sr}`}>
                <div className="head">
                  <strong>{`${p.code} – ${p.name.sr}`}</strong>
                  {!p.active && <span className="badge">Neaktivan</span>}
                </div>
                <div className="muted">
                  {BOARDS.find((b) => b.value === p.board)?.label ?? p.board}
                  {` · popust 7+ noći ${p.discount7Pct}% · popust 30+ noći ${p.discount30Pct}%`}
                </div>
                <div className="row">
                  <button
                    type="button"
                    className={p.active ? 'danger' : 'secondary'}
                    disabled={busy}
                    onClick={() =>
                      changePlan(
                        () => api(`/rate-plans/${p.id}`, send('PATCH', { active: !p.active })),
                        p.active ? 'Cenovnik je isključen.' : 'Cenovnik je uključen.',
                      )
                    }
                  >
                    {p.active ? 'Isključi' : 'Uključi'}
                  </button>
                </div>
              </li>
            ))}
            {plans.length === 0 && <li className="muted">Još nema cenovnika.</li>}
          </ul>
          <PlanForm busy={busy} onSubmit={(body) => changePlan(() => api('/rate-plans', send('POST', body)), 'Cenovnik je dodat.')} />
        </>
      )}
    </main>
  );
}

function PlanForm(props: { busy: boolean; onSubmit: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [board, setBoard] = useState('RO');
  const [d7, setD7] = useState('0');
  const [d30, setD30] = useState('0');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await props.onSubmit({
      code: code.trim(),
      name: { sr: name.trim() },
      board,
      discount7Pct: Number(d7),
      discount30Pct: Number(d30),
    });
    if (ok) {
      setCode('');
      setName('');
    }
  }

  return (
    <form className="card stack" aria-label="Novi cenovnik" onSubmit={submit}>
      <strong>Novi cenovnik</strong>
      <div className="row">
        <label>
          Oznaka
          <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} required />
        </label>
        <label>
          Naziv
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Usluga
          <select value={board} onChange={(e) => setBoard(e.target.value)}>
            {BOARDS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label>
          Popust 7+ noći (%)
          <input type="number" min={0} max={100} step={1} value={d7} onChange={(e) => setD7(e.target.value)} required />
        </label>
        <label>
          Popust 30+ noći (%)
          <input type="number" min={0} max={100} step={1} value={d30} onChange={(e) => setD30(e.target.value)} required />
        </label>
      </div>
      <button type="submit" disabled={props.busy}>
        Dodaj cenovnik
      </button>
    </form>
  );
}
