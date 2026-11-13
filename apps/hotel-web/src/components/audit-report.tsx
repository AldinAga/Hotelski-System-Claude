'use client';

import { forwardRef } from 'react';
import { formatDate, formatDay, formatRsd } from '@/lib/format';
import {
  LINE_KIND_LABELS,
  PAYMENT_METHOD_LABELS,
  formatTime,
  type AuditReport as Report,
} from '@/lib/business';

/** "Gotovina" for cash; a key the screen does not know is shown as it came. */
function labelOf(labels: Record<string, string>, key: string): string {
  return labels[key] ?? key;
}

function Amounts({ title, amounts, labels }: { title: string; amounts: Record<string, number>; labels: Record<string, string> }) {
  const keys = Object.keys(amounts);
  return (
    <section aria-label={title}>
      <h3 className="report-subhead">{title}</h3>
      {keys.length === 0 ? (
        <p className="muted">Nema knjiženja.</p>
      ) : (
        <dl className="report-amounts">
          {keys.map((k) => (
            <div key={k}>
              <dt>{labelOf(labels, k)}</dt>
              <dd className="num">{formatRsd(amounts[k])}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * The report of a closed day, as the server stored it. Every number and
 * amount is shown as received; nothing is added up here. The heading takes
 * focus when the report appears after a close.
 */
export const AuditReport = forwardRef<HTMLHeadingElement, { report: Report }>(function AuditReport({ report }, headingRef) {
  return (
    <section className="card report" aria-labelledby="report-heading">
      <h2 id="report-heading" tabIndex={-1} ref={headingRef}>
        {`Izveštaj za dan ${formatDay(report.day)}`}
      </h2>
      <p className="muted">
        {`${report.mode === 'auto' ? 'Zatvoren automatski' : 'Zatvoren ručno'} ${formatDate(report.closedAt)} u ${formatTime(report.closedAt)}`}
      </p>

      <dl className="report-figures">
        <div>
          <dt>Prijave</dt>
          <dd>{report.arrivals}</dd>
        </div>
        <div>
          <dt>Odjave</dt>
          <dd>{report.departures}</dd>
        </div>
        <div>
          <dt>Gosti kojima je noć proknjižena</dt>
          <dd>{report.inHouse}</dd>
        </div>
        <div>
          <dt>Proknjižene noći</dt>
          <dd>{report.postedNights}</dd>
        </div>
        <div>
          <dt>Prihod od smeštaja</dt>
          <dd className="num">{formatRsd(report.roomRevenueMinor)}</dd>
        </div>
      </dl>

      <section aria-label="Gosti koji nisu došli">
        <h3 className="report-subhead">Gosti koji nisu došli</h3>
        {report.noShows.length === 0 ? (
          <p className="muted">Nijedan gost.</p>
        ) : (
          <ul className="list">
            {report.noShows.map((n) => (
              <li key={n.stayId}>
                <div className="head">
                  <strong>{n.number}</strong>
                  <span className="num">{n.chargedMinor > 0 ? `Naplaćeno ${formatRsd(n.chargedMinor)}` : 'Bez naplate'}</span>
                </div>
                <div className="muted">{`${n.guest} · dolazak ${formatDay(n.arrival)}`}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Amounts title="Stavke po vrsti" amounts={report.chargesByKindMinor} labels={LINE_KIND_LABELS} />
      <Amounts title="Plaćanja po načinu" amounts={report.paymentsByMethodMinor} labels={PAYMENT_METHOD_LABELS} />
    </section>
  );
});
