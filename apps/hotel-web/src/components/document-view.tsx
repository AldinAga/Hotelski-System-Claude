'use client';

import { useEffect, useState } from 'react';
import { api, navigation } from '@/lib/api';
import { formatDateTime, formatDay, formatRsd, formatVatRate } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import { DOCUMENT_KIND_LABELS, paymentMethodLabel, type FolioDocument } from '@/lib/types';

/** The words every non-fiscal document carries (Ruling 4); shown whatever the stored snapshot says. */
const NOT_FISCAL = 'Ovo nije fiskalni račun.';

type PrintFormat = 'a4' | 'thermal';

const FORMATS: Array<{ value: PrintFormat; label: string }> = [
  { value: 'a4', label: 'A4' },
  { value: 'thermal', label: 'Termalni 80 mm' },
];

function addressLine(s: FolioDocument['content']['seller']): string | null {
  const place = [s.postalCode, s.city].filter(Boolean).join(' ');
  return [s.address, place].filter(Boolean).join(', ') || null;
}

/** A masked JMBG starts with bullets; anything else is a registry number (MB). */
function registryLabel(value: string): string {
  return value.startsWith('•') ? 'JMBG' : 'MB';
}

/**
 * A non-fiscal receipt or pro forma, exactly as it was issued. The totals,
 * the due amount and the VAT table are the server's; the page only lays them
 * out. Prints on A4 or on an 80 mm thermal roll (@media print in globals.css:
 * only the document is printed, not the menu or the buttons).
 */
export function DocumentView({ id }: { id: string }) {
  const [doc, setDoc] = useState<FolioDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<PrintFormat>('a4');

  useEffect(() => {
    let live = true;
    api<FolioDocument>(`/folio-documents/${id}`)
      .then((d) => {
        if (live) setDoc(d);
      })
      .catch((err: unknown) => {
        if (live) setError(messageFor(err));
      });
    return () => {
      live = false;
    };
  }, [id]);

  function back() {
    if (window.history.length > 1) window.history.back();
    else navigation.go('/kalendar');
  }

  const c = doc?.content;
  const seller = c?.seller;
  const sellerLines = seller
    ? [
        seller.legalName ? { strong: true, text: seller.legalName } : null,
        addressLine(seller) ? { strong: false, text: addressLine(seller) as string } : null,
        seller.taxId ? { strong: false, text: `PIB ${seller.taxId}` } : null,
        seller.registryId ? { strong: false, text: `${registryLabel(seller.registryId)} ${seller.registryId}` } : null,
        seller.bankAccount ? { strong: false, text: `Račun ${seller.bankAccount}` } : null,
      ].filter((l): l is { strong: boolean; text: string } => l !== null)
    : [];

  return (
    <main className="doc-page">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!doc && !error && <p className="muted">Učitavanje…</p>}
      {!doc && (
        <h1 tabIndex={-1} className="sr-only">
          Dokument
        </h1>
      )}

      {doc && c && (
        <>
          <div className="doc-toolbar no-print">
            <button type="button" className="secondary" onClick={back}>
              ‹ Nazad
            </button>
            <fieldset className="doc-format">
              <legend>Format štampe</legend>
              {FORMATS.map((f) => (
                <label key={f.value} className="doc-format-option">
                  <input type="radio" name="print-format" value={f.value} checked={format === f.value} onChange={() => setFormat(f.value)} />
                  {f.label}
                </label>
              ))}
            </fieldset>
            <button type="button" onClick={() => window.print()}>
              Štampaj
            </button>
          </div>

          <article className={`doc doc--${format}`} aria-labelledby="doc-title">
            <header className="doc-header">
              <h1 id="doc-title" tabIndex={-1}>
                {`${DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind} ${doc.number}`}
              </h1>
              <p className="doc-notice">{NOT_FISCAL}</p>
              <p className="doc-dates">
                {`Izdato ${formatDateTime(doc.issuedAt)} · poslovni datum ${formatDay(c.businessDate)}`}
              </p>
            </header>

            {sellerLines.length > 0 && (
              <section className="doc-block" aria-label="Izdavalac">
                {sellerLines.map((l) => (
                  <p key={l.text} className={l.strong ? 'doc-seller-name' : undefined}>
                    {l.text}
                  </p>
                ))}
              </section>
            )}

            <section className="doc-block" aria-label="Gost i rezervacija">
              <p>
                <span className="doc-label">Gost</span> {c.guest.name}
              </p>
              <p>
                <span className="doc-label">Rezervacija</span> {c.reservation.number}
                {c.reservation.unit ? ` · jedinica ${c.reservation.unit}` : ''}
              </p>
              <p>
                <span className="doc-label">Boravak</span> {`${formatDay(c.reservation.arrival)} – ${formatDay(c.reservation.departure)}`}
              </p>
            </section>

            {c.lines.some((l) => l.expected) && (
              <p className="doc-expected-note">Predračun uključuje noći koje još nisu proknjižene; one su označene kao očekivane.</p>
            )}

            <table className="doc-table">
              <caption className="sr-only">Stavke dokumenta</caption>
              <thead>
                <tr>
                  <th scope="col">Opis</th>
                  <th scope="col" className="num">
                    Iznos
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.lines.map((l, i) => (
                  <tr key={`${i}-${l.description}`}>
                    <td>
                      {l.description}
                      {l.expected && <span className="doc-tag">očekivano</span>}
                    </td>
                    <td className="num">{formatRsd(l.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {c.payments.length > 0 && (
              <table className="doc-table">
                <caption className="doc-caption">Plaćanja</caption>
                <thead>
                  <tr>
                    <th scope="col">Način</th>
                    <th scope="col" className="num">
                      Iznos
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {c.payments.map((p, i) => (
                    <tr key={`${i}-${p.businessDate}-${p.method}`}>
                      <td>{`${paymentMethodLabel(p.method)} · ${formatDay(p.businessDate)}`}</td>
                      <td className="num">{formatRsd(p.amountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <dl className="doc-totals">
              <div>
                <dt>Ukupno</dt>
                <dd>{formatRsd(c.totalMinor)}</dd>
              </div>
              <div>
                <dt>Plaćeno</dt>
                <dd>{formatRsd(c.paidMinor)}</dd>
              </div>
              <div className="doc-due">
                <dt>{c.dueMinor < 0 ? 'Preplata' : 'Za uplatu'}</dt>
                <dd>{formatRsd(Math.abs(c.dueMinor))}</dd>
              </div>
            </dl>

            {c.vat && (
              <table className="doc-table doc-vat">
                <caption className="doc-caption">PDV rekapitulacija</caption>
                <thead>
                  <tr>
                    <th scope="col">Stopa</th>
                    <th scope="col" className="num">
                      Osnovica
                    </th>
                    <th scope="col" className="num">
                      PDV
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {c.vat.map((v) => (
                    <tr key={v.rateBp}>
                      <td>{formatVatRate(v.rateBp)}</td>
                      <td className="num">{formatRsd(v.baseMinor)}</td>
                      <td className="num">{formatRsd(v.vatMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        </>
      )}
    </main>
  );
}
