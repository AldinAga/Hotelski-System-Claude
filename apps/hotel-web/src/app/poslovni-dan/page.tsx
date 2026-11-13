'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AuditReport } from '@/components/audit-report';
import { CloseDayDialog } from '@/components/close-day-dialog';
import { ApiError, api, send } from '@/lib/api';
import {
  CLOSED_DAYS_SHOWN,
  announceBusinessDayChange,
  dayMonth,
  daysLabel,
  formatTime,
  type AuditReport as Report,
  type BusinessDayView,
  type ClosedDay,
  type ClosedDaySummary,
  type CloseResult,
} from '@/lib/business';
import { addDays, formatDate, formatDay, formatRsd } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import { useLicenceMode } from '@/lib/use-read-only';

/** The message of the automatic close that failed, in the words of the same code on a manual close. */
function autoErrorText(e: NonNullable<BusinessDayView['lastAutoError']>): string {
  const details = typeof e.details === 'object' && e.details !== null && !Array.isArray(e.details) ? (e.details as Record<string, unknown>) : null;
  return `Automatsko zatvaranje nije uspelo (${formatDate(e.at)} u ${formatTime(e.at)}): ${messageFor(new ApiError(409, e.code, '', details))}`;
}

export default function BusinessDayPage() {
  const licence = useLicenceMode();
  const [view, setView] = useState<BusinessDayView | null>(null);
  const [closed, setClosed] = useState<ClosedDaySummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  // State lands after the next click can already fire; the refs close that gap.
  const inFlight = useRef(false);
  const openingRef = useRef(false);
  const reportHeading = useRef<HTMLHeadingElement>(null);
  const focusReport = useRef(false);

  /**
   * The open day with its blockers and counts, then the closed days before it.
   * Reads never overlap: the first runs at mount, the next only after a close
   * or a 409, when the buttons that start them are off or gone.
   */
  const load = useCallback(async () => {
    const v = await api<BusinessDayView>('/business-day');
    setView(v);
    try {
      const rows = await api<ClosedDaySummary[]>(`/business-days?from=${addDays(v.day, -CLOSED_DAYS_SHOWN)}&to=${v.day}`);
      setClosed([...rows].reverse());
      setListError(null);
    } catch (err) {
      setListError(messageFor(err));
    }
  }, []);

  useEffect(() => {
    load().catch((err: unknown) => setError(messageFor(err)));
  }, [load]);

  useEffect(() => {
    if (report && focusReport.current) {
      focusReport.current = false;
      reportHeading.current?.focus();
    }
  }, [report]);

  async function closeDay() {
    if (!view || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<CloseResult>('/business-day/close', send('POST', { day: view.day }));
      focusReport.current = true;
      setConfirming(false);
      setReport(res.report);
      setNotice(
        res.alreadyClosed
          ? `Dan ${formatDay(res.report.day)} je već bio zatvoren. Prikazan je sačuvan izveštaj.`
          : `Dan ${formatDay(res.report.day)} je zatvoren.`,
      );
      announceBusinessDayChange();
      await load();
    } catch (err) {
      setConfirming(false);
      setError(messageFor(err));
      // A 409 says the day moved on (another close, new blockers): show the current state.
      if (err instanceof ApiError && err.status === 409) await load().catch(() => undefined);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function openReport(day: string) {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(day);
    setError(null);
    setNotice(null);
    try {
      const res = await api<ClosedDay>(`/business-days/${day}`);
      focusReport.current = true;
      setReport(res.report);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      openingRef.current = false;
      setOpening(null);
    }
  }

  const late = view !== null && view.lagDays > 0;
  const ahead = view !== null && view.lagDays < 0;
  const blocked = view !== null && view.blockers.length > 0;
  const canClose = view !== null && !blocked && !ahead && licence !== 'none';

  return (
    <main className="bday">
      <h1 tabIndex={-1}>Poslovni dan</h1>
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

      {view && (
        <>
          <section className="card bday-hero" aria-labelledby="open-day-label">
            <p id="open-day-label" className="eyebrow">
              Otvoreni poslovni dan
            </p>
            <p className="bday-date">{formatDay(view.day)}</p>
            <p className="muted">{`Danas je ${formatDay(view.today)}.`}</p>
            {view.lastClosed && (
              <p className="muted">
                {`Poslednji zatvoren dan: ${formatDay(view.lastClosed.day)} (${view.lastClosed.mode === 'auto' ? 'automatski' : 'ručno'}, ${formatTime(view.lastClosed.closedAt)}).`}
              </p>
            )}
          </section>

          {late && (
            <p role="status" className="warn">
              {`Poslovni dan kasni ${daysLabel(view.lagDays)}. Zatvorite dan ${dayMonth(view.day)} da biste prijavljivali današnje goste.`}
            </p>
          )}
          {view.lastAutoError && (
            <p role="alert" className="error">
              {autoErrorText(view.lastAutoError)}
            </p>
          )}

          <section aria-label="Stanje otvorenog dana" className="card">
            <dl className="report-figures">
              <div>
                <dt>Prijave na ovaj dan</dt>
                <dd>{view.pending.arrivals}</dd>
              </div>
              <div>
                <dt>Odjave na ovaj dan</dt>
                <dd>{view.pending.departures}</dd>
              </div>
              <div>
                <dt>Gosti u objektu sada</dt>
                <dd>{view.pending.inHouse}</dd>
              </div>
              <div>
                <dt>Noći za knjiženje</dt>
                <dd>{view.pending.nightsToPost}</dd>
              </div>
              <div>
                <dt>Gosti koji nisu došli</dt>
                <dd>{view.pending.noShows}</dd>
              </div>
            </dl>
          </section>

          {blocked && (
            <section aria-labelledby="blockers-heading" className="card">
              <h2 id="blockers-heading">Gosti koji još nisu odjavljeni</h2>
              <p className="muted">Odjavite ih da biste zatvorili dan.</p>
              <ul className="list">
                {view.blockers.map((b) => (
                  <li key={b.stayId}>
                    <div className="head">
                      <a href={`/rezervacije/${b.reservationId}`}>{`Rezervacija ${b.number}`}</a>
                      <span className="muted">{`odlazak ${formatDay(b.departure)}`}</span>
                    </div>
                    <div className="muted">{b.unitName ?? 'Bez jedinice'}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="bday-close">
            {ahead && <p className="muted">{`Dan ${formatDay(view.day)} još nije počeo, pa ne može da se zatvori.`}</p>}
            <button
              type="button"
              disabled={!canClose || busy}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              {`Zatvori dan ${dayMonth(view.day)}`}
            </button>
          </div>

          {confirming && (
            <CloseDayDialog
              day={view.day}
              nightsToPost={view.pending.nightsToPost}
              noShows={view.pending.noShows}
              busy={busy}
              onConfirm={() => void closeDay()}
              onCancel={() => setConfirming(false)}
            />
          )}
        </>
      )}

      {report && <AuditReport ref={reportHeading} report={report} />}

      {view && (
        <section aria-labelledby="closed-heading">
          <h2 id="closed-heading">Zatvoreni dani</h2>
          {listError && (
            <p role="alert" className="error">
              {listError}
            </p>
          )}
          {closed.length === 0 && !listError ? (
            <p className="muted">Još nema zatvorenih dana.</p>
          ) : (
            <ul className="list">
              {closed.map((d) => (
                <li key={d.day}>
                  <div className="head">
                    <strong>{formatDay(d.day)}</strong>
                    <span className="badge">{d.mode === 'auto' ? 'Automatski' : 'Ručno'}</span>
                  </div>
                  <div className="closed-row">
                    <span className="muted">
                      {`Smeštaj ${formatRsd(d.roomRevenueMinor)} · nisu došli: ${d.noShows}`}
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      disabled={opening !== null}
                      aria-label={`Izveštaj za ${formatDay(d.day)}`}
                      onClick={() => void openReport(d.day)}
                    >
                      Izveštaj
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
