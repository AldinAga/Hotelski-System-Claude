'use client';

import { useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { addDays, formatDay, nightsBetween } from '@/lib/format';
import { BLOCK_REASONS, type CalendarBar, type CalendarView, type UnassignedStay } from '@/lib/types';

export interface CalendarGridProps {
  view: CalendarView;
  /** Safe mode: the grid is shown, but no cell, drag or assign changes anything. */
  readOnly: boolean;
  /** A click on a free day of a unit: start a new reservation there. */
  onPickCell: (unitId: string, day: string) => void;
  /** An unassigned stay put on a unit of its type (by drag or by the select). */
  onAssign: (stay: UnassignedStay, unitId: string) => void;
}

const WEEKDAYS = ['ned', 'pon', 'uto', 'sre', 'čet', 'pet', 'sub'];
const LABEL_COLUMN = 'minmax(96px, 140px)';

interface Span {
  /** Grid column of the first night (column 1 holds the row label). */
  column: number;
  nights: number;
  /** The stay or block began before the first shown day. */
  before: boolean;
  /** It goes on after the last shown day. */
  after: boolean;
}

/**
 * Where [from, to) falls in the shown days, clipped to them. GET /calendar
 * sends the real dates, so a bar that began earlier (or ends later) is drawn
 * from the first (to the last) column with a "continues" edge.
 */
export function spanOf(days: string[], from: string, to: string): Span | null {
  if (days.length === 0) return null;
  const first = days[0];
  const end = addDays(days[days.length - 1], 1);
  const start = from < first ? first : from;
  const stop = to > end ? end : to;
  const nights = nightsBetween(start, stop);
  if (nights <= 0) return null;
  return { column: nightsBetween(first, start) + 2, nights, before: from < first, after: to > end };
}

function place(span: Span, row = 1): CSSProperties {
  return { gridColumn: `${span.column} / span ${span.nights}`, gridRow: row };
}

function edges(span: Span): string {
  return `${span.before ? ' cont-before' : ''}${span.after ? ' cont-after' : ''}`;
}

const reasonLabel = (r: string) => BLOCK_REASONS.find((x) => x.value === r)?.label ?? r;

function dayHeader(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
}

export function CalendarGrid({ view, readOnly, onPickCell, onAssign }: CalendarGridProps) {
  const { days } = view;
  const dragging = useRef<UnassignedStay | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const columns: CSSProperties = { gridTemplateColumns: `${LABEL_COLUMN} repeat(${days.length}, minmax(36px, 1fr))` };

  const accepts = (unitTypeId: string | null) =>
    !readOnly && dragging.current !== null && unitTypeId !== null && dragging.current.unitTypeId === unitTypeId;

  function stayBar(
    key: string,
    bar: { reservationId: string; number: string; guest: string; arrival: string; departure: string },
    span: Span,
    row: number,
    extra: { status?: string; drag?: UnassignedStay },
  ) {
    const drag = extra.drag;
    return (
      <a
        key={key}
        href={`/rezervacije/${bar.reservationId}`}
        className={`bar stay${extra.status ? ` status-${extra.status}` : ' unassigned'}${edges(span)}`}
        style={place(span, row)}
        aria-label={`${bar.number} · ${bar.guest}`}
        title={span.before || span.after ? 'Boravak traje i van prikazanih dana; tačni datumi su u rezervaciji.' : undefined}
        draggable={drag !== undefined && !readOnly}
        onDragStart={(e: DragEvent) => {
          if (!drag || readOnly) return;
          dragging.current = drag;
          // Firefox starts a drag only with data set.
          e.dataTransfer?.setData('text/plain', drag.stayId);
        }}
        onDragEnd={() => {
          dragging.current = null;
          setDropOn(null);
        }}
      >
        <span className="bar-text">
          {bar.guest} · {bar.number}
        </span>
      </a>
    );
  }

  return (
    <div className="cal-scroll">
      <div className="cal" role="table" aria-label="Kalendar zauzetosti">
        <div className="cal-row cal-head" role="row" style={columns}>
          <div className="cal-label" role="columnheader">
            Jedinica
          </div>
          {days.map((d) => (
            <div key={d} className="cal-day" role="columnheader" aria-label={formatDay(d)}>
              {dayHeader(d)}
            </div>
          ))}
        </div>

        {view.units.map((u) => {
          const covered = new Set<string>();
          const bars = u.bars.flatMap((b: CalendarBar) => {
            const span = b.kind === 'stay' ? spanOf(days, b.arrival, b.departure) : spanOf(days, b.from, b.to);
            if (!span) return [];
            for (let i = 0; i < span.nights; i++) covered.add(days[span.column - 2 + i]);
            if (b.kind === 'stay') return [stayBar(b.stayId, b, span, 1, { status: b.status })];
            return [
              <div
                key={b.blockId}
                className={`bar block${edges(span)}`}
                style={place(span)}
                title={`Blokada: ${reasonLabel(b.reason)}`}
              >
                <span className="bar-text">{reasonLabel(b.reason)}</span>
              </div>,
            ];
          });
          return (
            <div
              key={u.id}
              className={`cal-row${dropOn === u.id ? ' drop' : ''}`}
              role="row"
              aria-label={u.name}
              style={columns}
              onDragOver={(e) => {
                if (!accepts(u.unitTypeId)) return;
                e.preventDefault();
                setDropOn(u.id);
              }}
              onDragLeave={() => setDropOn((cur) => (cur === u.id ? null : cur))}
              onDrop={(e) => {
                const stay = dragging.current;
                const ok = accepts(u.unitTypeId);
                dragging.current = null;
                setDropOn(null);
                if (!ok || !stay) return;
                e.preventDefault();
                onAssign(stay, u.id);
              }}
            >
              <div className="cal-label" role="rowheader" style={{ gridRow: 1, gridColumn: 1 }}>
                {u.name}
                {u.cleanliness === 'dirty' && <span className="muted"> · prljava</span>}
              </div>
              {days.map((d, i) =>
                covered.has(d) ? null : (
                  <button
                    key={d}
                    type="button"
                    className="cal-cell"
                    style={{ gridRow: 1, gridColumn: i + 2 }}
                    aria-label={`${u.name}, ${formatDay(d)}`}
                    disabled={readOnly}
                    onClick={() => onPickCell(u.id, d)}
                  />
                ),
              )}
              {bars}
            </div>
          );
        })}

        {view.unassigned.length > 0 && (
          <div className="cal-row unassigned-row" role="row" aria-label="Nedodeljeno" style={columns}>
            <div
              className="cal-label"
              role="rowheader"
              style={{ gridColumn: 1, gridRow: `1 / span ${view.unassigned.length}` }}
            >
              Nedodeljeno
            </div>
            {view.unassigned.map((s, i) => {
              const span = spanOf(days, s.arrival, s.departure);
              return span ? stayBar(s.stayId, s, span, i + 1, { drag: s }) : null;
            })}
          </div>
        )}

        {view.availability.map((a) => (
          <div
            key={`${a.scope.kind}:${a.scope.id}`}
            className="cal-row free-row"
            role="row"
            aria-label={`Slobodno: ${a.label}`}
            style={columns}
          >
            <div className="cal-label" role="rowheader">
              Slobodno: {a.label}
            </div>
            {a.free.map((n, i) => (
              <div key={days[i]} role="cell" className={`cal-free${n <= 0 ? ' full' : ''}`}>
                {n}
              </div>
            ))}
          </div>
        ))}
      </div>

      {view.unassigned.length > 0 && (
        <UnassignedList view={view} readOnly={readOnly} onAssign={onAssign} />
      )}
    </div>
  );
}

/** The way to assign without dragging (touch screens, keyboard). */
function UnassignedList({ view, readOnly, onAssign }: Pick<CalendarGridProps, 'view' | 'readOnly' | 'onAssign'>) {
  return (
    <section aria-label="Nedodeljeni boravci">
      <h2>Nedodeljeni boravci</h2>
      <ul className="list">
        {view.unassigned.map((s) => (
          <UnassignedItem key={s.stayId} stay={s} view={view} readOnly={readOnly} onAssign={onAssign} />
        ))}
      </ul>
    </section>
  );
}

function UnassignedItem(props: {
  stay: UnassignedStay;
  view: CalendarView;
  readOnly: boolean;
  onAssign: CalendarGridProps['onAssign'];
}) {
  const { stay, view } = props;
  const [unitId, setUnitId] = useState('');
  const units = view.units.filter((u) => u.unitTypeId === stay.unitTypeId);
  const typeLabel = view.availability.find((a) => a.scope.kind === 'unit_type' && a.scope.id === stay.unitTypeId)?.label;
  return (
    <li aria-label={`${stay.number} · ${stay.guest}`}>
      <div className="head">
        <strong>
          {stay.number} · {stay.guest}
        </strong>
        {typeLabel && <span className="badge">{typeLabel}</span>}
      </div>
      <div className="muted">
        {formatDay(stay.arrival)} – {formatDay(stay.departure)}
      </div>
      <div className="row">
        <label>
          Jedinica
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)} disabled={props.readOnly}>
            <option value="">Izaberite jedinicu</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={props.readOnly || unitId === ''}
          onClick={() => props.onAssign(stay, unitId)}
        >
          Dodeli
        </button>
      </div>
    </li>
  );
}
