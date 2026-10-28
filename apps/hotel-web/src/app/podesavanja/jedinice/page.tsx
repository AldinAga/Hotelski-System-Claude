'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, send } from '@/lib/api';
import { addDays, formatDay, isDay, today } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import { useCanChangeSettings } from '@/lib/use-role';
import {
  BLOCK_REASONS,
  persons,
  typeLabel,
  type BlockReason,
  type CalendarView,
  type Unit,
  type UnitBlock,
  type UnitType,
} from '@/lib/types';

/** GET /calendar accepts at most 62 days; the API has no other list of blocks. */
const BLOCK_WINDOW_DAYS = 62;

interface Data {
  types: UnitType[];
  units: Unit[];
  blocks: Record<string, UnitBlock[]>;
}

function blocksFrom(calendar: CalendarView): Record<string, UnitBlock[]> {
  const out: Record<string, UnitBlock[]> = {};
  for (const u of calendar.units) {
    out[u.id] = u.bars.flatMap((b) =>
      b.kind === 'block' ? [{ id: b.blockId, unitId: u.id, from: b.from, to: b.to, reason: b.reason }] : [],
    );
  }
  return out;
}

/** "10.11.2026 – 11.11.2026": first and last blocked night (to is exclusive). */
function nightsLabel(from: string, to: string): string {
  return `${formatDay(from)} – ${formatDay(addDays(to, -1))}`;
}

const reasonLabel = (r: BlockReason) => BLOCK_REASONS.find((x) => x.value === r)?.label ?? r;

export default function UnitsPage() {
  // Units, types and blocks change for owner and manager only (@Roles in hotel-api).
  const canChange = useCanChangeSettings();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingType, setEditingType] = useState<UnitType | null>(null);
  const [editingUnit, setEditingUnit] = useState<Unit | null>(null);
  const [blockFormFor, setBlockFormFor] = useState<string | null>(null);
  /** First day of the block window; moving it shows blocks further ahead. */
  const [blocksStart, setBlocksStart] = useState(today());
  /** The block named by a 409 unit_has_blocks, which may lie outside the window. */
  const [stuckBlock, setStuckBlock] = useState<{ unitId: string; blockId: string } | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const from = isDay(blocksStart) ? blocksStart : today();
    const [types, units, calendar] = await Promise.all([
      api<UnitType[]>('/unit-types'),
      api<Unit[]>('/units'),
      api<CalendarView>(`/calendar?from=${from}&to=${addDays(from, BLOCK_WINDOW_DAYS)}`),
    ]);
    // Only the latest load paints: an older window must not overwrite a newer one.
    if (seq === loadSeq.current) setData({ types, units, blocks: blocksFrom(calendar) });
  }, [blocksStart]);

  useEffect(() => {
    load().catch((err: unknown) => setError(messageFor(err)));
  }, [load]);

  /**
   * Runs a change, then reloads; errors land in the one alert at the top.
   * For a change to unit `unitId`, a 409 unit_has_blocks also offers removing
   * the block it names, since that block may be outside the shown window.
   */
  async function change(action: () => Promise<unknown>, done: string, unitId?: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    setStuckBlock(null);
    try {
      await action();
      setNotice(done);
      await load();
      return true;
    } catch (err) {
      setError(messageFor(err));
      const blockId = err instanceof ApiError && err.code === 'unit_has_blocks' ? err.details?.blockId : undefined;
      if (unitId && typeof blockId === 'string') setStuckBlock({ unitId, blockId });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const typeById = new Map((data?.types ?? []).map((t) => [t.id, t]));

  return (
    <main>
      <h1>Jedinice</h1>
      {error && (
        <div role="alert" className="error stack">
          <span>{error}</span>
          {stuckBlock && canChange && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                const { unitId, blockId } = stuckBlock;
                void change(() => api(`/units/${unitId}/blocks/${blockId}`, send('DELETE')), 'Blokada je uklonjena.');
              }}
            >
              Ukloni tu blokadu
            </button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!data && !error && <p className="muted">Učitavanje…</p>}
      {!canChange && <p className="help">Jedinice i blokade menja vlasnik ili menadžer.</p>}

      {data && (
        <>
          <h2>Tipovi jedinica</h2>
          <p className="help">
            Tip okuplja jednake jedinice (npr. dvokrevetne sobe): prodaju se i cene se unose po tipu.
          </p>
          <ul className="list">
            {data.types.map((t) => (
              <li key={t.id} aria-label={typeLabel(t)}>
                <div className="head">
                  <strong>{typeLabel(t)}</strong>
                  {!t.active && <span className="badge">Isključen</span>}
                </div>
                <div className="muted">
                  {persons(t.capacity)}
                  {t.beds ? ` · ${t.beds}` : ''}
                </div>
                {canChange && (
                  <div className="row">
                    <button type="button" className="secondary" disabled={busy} onClick={() => setEditingType(t)}>
                      Izmeni
                    </button>
                    <button
                      type="button"
                      className={t.active ? 'danger' : 'secondary'}
                      disabled={busy}
                      onClick={() =>
                        change(
                          () => api(`/unit-types/${t.id}`, send('PATCH', { active: !t.active })),
                          t.active ? 'Tip je isključen.' : 'Tip je uključen.',
                        )
                      }
                    >
                      {t.active ? 'Isključi' : 'Uključi'}
                    </button>
                  </div>
                )}
              </li>
            ))}
            {data.types.length === 0 && <li className="muted">Još nema tipova.</li>}
          </ul>

          {canChange && (
            <TypeForm
              key={`type-${editingType?.id ?? 'new'}`}
              editing={editingType}
              busy={busy}
              onCancel={() => setEditingType(null)}
              onSubmit={async (body) => {
                const ok = await change(
                  () =>
                    editingType
                      ? api(`/unit-types/${editingType.id}`, send('PATCH', body))
                      : api('/unit-types', send('POST', body)),
                  editingType ? 'Tip je sačuvan.' : 'Tip je dodat.',
                );
                if (ok) setEditingType(null);
                return ok;
              }}
            />
          )}

          <h2>Jedinice</h2>
          <p className="help">
            Isključena jedinica se ne prodaje. Jedinica sa blokadom ili dodeljenim boravkom koji još traje ne može da
            promeni tip niti da se isključi dok se blokada ne ukloni ili boravak ne premesti (na stranici
            rezervacije). Prikazane su blokade u{` ${BLOCK_WINDOW_DAYS} dana od izabranog datuma; za kasnije blokade pomerite datum.`}
          </p>
          <div className="row">
            <label>
              Blokade od
              <input type="date" value={blocksStart} onChange={(e) => setBlocksStart(e.target.value)} />
            </label>
          </div>
          <ul className="list">
            {data.units.map((u) => {
              const type = u.unitTypeId ? typeById.get(u.unitTypeId) : undefined;
              const blocks = data.blocks[u.id] ?? [];
              return (
                <li key={u.id} aria-label={u.name}>
                  <div className="head">
                    <strong>{u.name}</strong>
                    {!u.active && <span className="badge">Isključena</span>}
                  </div>
                  <div className="muted">{type ? typeLabel(type) : 'Bez tipa'}</div>
                  {blocks.length > 0 && (
                    <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
                      {blocks.map((b) => (
                        <li key={b.id} className="row" style={{ alignItems: 'center' }}>
                          <span>{`${nightsLabel(b.from, b.to)} · ${reasonLabel(b.reason)}`}</span>
                          {canChange && (
                            <button
                              type="button"
                              className="danger"
                              disabled={busy}
                              aria-label={`Ukloni blokadu ${nightsLabel(b.from, b.to)}`}
                              onClick={() =>
                                change(
                                  () => api(`/units/${u.id}/blocks/${b.id}`, send('DELETE')),
                                  'Blokada je uklonjena.',
                                )
                              }
                            >
                              Ukloni
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canChange && (
                    <div className="row">
                      <button type="button" className="secondary" disabled={busy} onClick={() => setEditingUnit(u)}>
                        Izmeni
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => setBlockFormFor(blockFormFor === u.id ? null : u.id)}
                      >
                        Dodaj blokadu
                      </button>
                      <button
                        type="button"
                        className={u.active ? 'danger' : 'secondary'}
                        disabled={busy}
                        onClick={() =>
                          change(
                            () => api(`/units/${u.id}`, send('PATCH', { active: !u.active })),
                            u.active ? 'Jedinica je isključena.' : 'Jedinica je uključena.',
                            u.id,
                          )
                        }
                      >
                        {u.active ? 'Isključi' : 'Uključi'}
                      </button>
                    </div>
                  )}
                  {canChange && blockFormFor === u.id && (
                    <BlockForm
                      unit={u}
                      busy={busy}
                      onCancel={() => setBlockFormFor(null)}
                      onSubmit={async (body) => {
                        const ok = await change(
                          () => api(`/units/${u.id}/blocks`, send('POST', body)),
                          'Blokada je dodata.',
                        );
                        if (ok) setBlockFormFor(null);
                      }}
                    />
                  )}
                </li>
              );
            })}
            {data.units.length === 0 && <li className="muted">Još nema jedinica.</li>}
          </ul>

          {canChange && (
            <UnitForm
              key={`unit-${editingUnit?.id ?? 'new'}`}
              editing={editingUnit}
              types={data.types}
              busy={busy}
              onCancel={() => setEditingUnit(null)}
              onSubmit={async (body) => {
                const ok = await change(
                  () =>
                    editingUnit
                      ? api(`/units/${editingUnit.id}`, send('PATCH', body))
                      : api('/units', send('POST', body)),
                  editingUnit ? 'Jedinica je sačuvana.' : 'Jedinica je dodata.',
                  editingUnit?.id,
                );
                if (ok) setEditingUnit(null);
                return ok;
              }}
            />
          )}
        </>
      )}
    </main>
  );
}

function TypeForm(props: {
  editing: UnitType | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const { editing } = props;
  const [code, setCode] = useState(editing?.code ?? '');
  const [name, setName] = useState(editing?.name.sr ?? '');
  const [capacity, setCapacity] = useState(String(editing?.capacity ?? 2));
  const [beds, setBeds] = useState(editing?.beds ?? '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      code: code.trim(),
      // An English name, if one was entered elsewhere, is kept.
      name: { ...(editing?.name ?? {}), sr: name.trim() },
      capacity: Number(capacity),
    };
    if (beds.trim()) body.beds = beds.trim();
    else if (editing?.beds) body.beds = null;
    if (await props.onSubmit(body)) {
      setCode('');
      setName('');
      setCapacity('2');
      setBeds('');
    }
  }

  const title = editing ? `Izmena tipa ${editing.code}` : 'Novi tip jedinice';
  return (
    <form className="card stack" aria-label={title} onSubmit={submit}>
      <strong>{title}</strong>
      <div className="row">
        <label>
          Oznaka
          <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} required />
        </label>
        <label>
          Naziv
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
      </div>
      <div className="row">
        <label>
          Kapacitet (osoba)
          <input
            type="number"
            min={1}
            max={50}
            step={1}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            required
          />
        </label>
        <label>
          Ležajevi (opciono)
          <input value={beds} onChange={(e) => setBeds(e.target.value)} placeholder="npr. 1 bračni + 1 pomoćni" />
        </label>
      </div>
      <div className="row">
        <button type="submit" disabled={props.busy}>
          {editing ? 'Sačuvaj tip' : 'Dodaj tip'}
        </button>
        {editing && (
          <button type="button" className="secondary" onClick={props.onCancel}>
            Otkaži
          </button>
        )}
      </div>
    </form>
  );
}

function UnitForm(props: {
  editing: Unit | null;
  types: UnitType[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const { editing } = props;
  const [name, setName] = useState(editing?.name ?? '');
  const [typeId, setTypeId] = useState(editing?.unitTypeId ?? '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const unitTypeId = typeId === '' ? null : typeId;
    const body: Record<string, unknown> = {};
    // Only what changed: a type change is refused while a block or stay holds the unit.
    if (!editing || editing.name !== name.trim()) body.name = name.trim();
    if (!editing || editing.unitTypeId !== unitTypeId) body.unitTypeId = unitTypeId;
    if (editing && Object.keys(body).length === 0) {
      props.onCancel();
      return;
    }
    // A refused create (e.g. unit_name_taken) keeps what was typed.
    if ((await props.onSubmit(body)) && !editing) {
      setName('');
      setTypeId('');
    }
  }

  // An inactive type can stay on a unit that already has it, but is not offered.
  const options = props.types.filter((t) => t.active || t.id === editing?.unitTypeId);
  const title = editing ? `Izmena jedinice ${editing.name}` : 'Nova jedinica';
  return (
    <form className="card stack" aria-label={title} onSubmit={submit}>
      <strong>{title}</strong>
      <div className="row">
        <label>
          Naziv
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </label>
        <label>
          Tip
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">Bez tipa</option>
            {options.map((t) => (
              <option key={t.id} value={t.id}>
                {typeLabel(t)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <button type="submit" disabled={props.busy}>
          {editing ? 'Sačuvaj jedinicu' : 'Dodaj jedinicu'}
        </button>
        {editing && (
          <button type="button" className="secondary" onClick={props.onCancel}>
            Otkaži
          </button>
        )}
      </div>
    </form>
  );
}

function BlockForm(props: {
  unit: Unit;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [reason, setReason] = useState<BlockReason>('maintenance');
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isDay(first) || !isDay(last) || last < first) {
      setInvalid('Poslednja noć mora biti ista ili posle prve noći.');
      return;
    }
    setInvalid(null);
    // The form asks for the last blocked night; the API takes the first free one.
    const body: Record<string, unknown> = { from: first, to: addDays(last, 1), reason };
    if (note.trim()) body.note = note.trim();
    await props.onSubmit(body);
  }

  return (
    <form className="stack" aria-label={`Nova blokada za ${props.unit.name}`} onSubmit={submit} style={{ marginTop: 12 }}>
      {invalid && (
        <p role="alert" className="error">
          {invalid}
        </p>
      )}
      <div className="row">
        <label>
          Prva noć
          <input type="date" value={first} min={today()} onChange={(e) => setFirst(e.target.value)} required />
        </label>
        <label>
          Poslednja noć
          <input type="date" value={last} min={first || today()} onChange={(e) => setLast(e.target.value)} required />
        </label>
      </div>
      <div className="row">
        <label>
          Razlog
          <select value={reason} onChange={(e) => setReason(e.target.value as BlockReason)}>
            {BLOCK_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Napomena (opciono)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </div>
      <div className="row">
        <button type="submit" disabled={props.busy}>
          Sačuvaj blokadu
        </button>
        <button type="button" className="secondary" onClick={props.onCancel}>
          Otkaži
        </button>
      </div>
    </form>
  );
}
