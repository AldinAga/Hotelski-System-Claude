'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, api, navigation, send } from '@/lib/api';
import { formatAmountInput, formatDateTime, formatDay, formatRsd, formatVatRate, parseRsd } from '@/lib/format';
import { useIdempotencyKey } from '@/lib/idempotency';
import { messageFor } from '@/lib/messages';
import {
  DOCUMENT_KIND_LABELS,
  PAYMENT_METHODS,
  paymentMethodLabel,
  type DocumentKind,
  type Folio,
  type FolioDocument,
  type FolioDocumentItem,
  type FolioLine,
  type FolioPayment,
  type FolioStatus,
  type Reservation,
  type ReservationStay,
  type Unit,
} from '@/lib/types';
import { useLicenceMode } from '@/lib/use-read-only';
import { useRole } from '@/lib/use-role';
import { Modal } from './modal';

/** The API's upper limit for one amount (folio.service.ts), so a typo is caught before it is sent. The API decides. */
const MAX_AMOUNT_MINOR = 10_000_000_000;
/** Stays a charge can be added to (folio.service.ts CHARGEABLE). */
const CHARGEABLE = new Set(['expected', 'in_house']);

const FOLIO_STATUS_LABELS: Record<FolioStatus, string> = {
  none: 'Bez stavki',
  open: 'Otvoren',
  closed: 'Zatvoren',
};

const FISCAL_NOTICE = 'Fiskalizacija još nije uključena; plaćanja se beleže bez fiskalnog računa.';

type Dialog =
  | { type: 'charge' }
  | { type: 'pay' }
  | { type: 'refund' }
  | { type: 'reverse'; line: FolioLine }
  | { type: 'void'; payment: FolioPayment };

interface Header {
  reservation: Reservation;
  stay: ReservationStay | undefined;
  unit: string | null;
}

function amountFrom(text: string): { minor: number } | { error: string } {
  const minor = parseRsd(text);
  if (minor === null) return { error: 'Unesite iznos u dinarima, na primer 1.500,00.' };
  if (minor < 1) return { error: 'Iznos mora biti veći od nule.' };
  if (minor > MAX_AMOUNT_MINOR) return { error: 'Iznos je prevelik.' };
  return { minor };
}

/** What the guest has paid ahead: the balance below zero, shown as a positive amount. */
function creditOf(folio: Folio): number {
  return folio.balanceMinor < 0 ? -folio.balanceMinor : 0;
}

/**
 * The folio of one stay: its lines and payments, the totals the server
 * computed, and the actions on it. Which actions are offered follows the
 * folio (closed: only documents), the role (corrections and refunds: owner and
 * manager) and the licence (safe mode: payments and documents only).
 */
export function FolioView({ stayId }: { stayId: string }) {
  const licence = useLicenceMode();
  const role = useRole();
  const [folio, setFolio] = useState<Folio | null>(null);
  const [header, setHeader] = useState<Header | null>(null);
  const [docs, setDocs] = useState<FolioDocumentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [issuing, setIssuing] = useState<DocumentKind | null>(null);
  const issueInFlight = useRef(false);
  const latest = useRef(0);
  const receiptKey = useIdempotencyKey();
  const proformaKey = useIdempotencyKey();

  const read = useCallback(async (seq: number) => {
    const [f, d] = await Promise.all([
      api<Folio>(`/stays/${stayId}/folio`),
      api<FolioDocumentItem[]>(`/stays/${stayId}/folio/documents`).catch(() => null),
    ]);
    // The heading of the page (guest, unit, dates) is extra: the folio shows without it.
    const [reservation, units] = await Promise.all([
      api<Reservation>(`/reservations/${f.reservationId}`).catch(() => null),
      api<Unit[]>('/units').catch(() => null),
    ]);
    if (seq !== latest.current) return;
    setFolio(f);
    setDocs((previous) => d ?? previous);
    if (reservation) {
      const stay = reservation.stays.find((s) => s.id === stayId);
      const unit = stay?.unitId ? (units?.find((u) => u.id === stay.unitId)?.name ?? null) : null;
      setHeader({ reservation, stay, unit });
    }
  }, [stayId]);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    try {
      await read(seq);
    } catch (err) {
      // A newer read has started: its answer counts, this failure is old news.
      if (seq === latest.current) throw err;
    }
  }, [read]);

  const refresh = useCallback(
    () => load().catch((err: unknown) => setError(messageFor(err))),
    [load],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function done(text: string) {
    setDialog(null);
    setError(null);
    setNotice(text);
    await refresh();
  }

  /** A refusal that means the screen is out of date: read it again; a state conflict also closes the dialog and says why. */
  async function refused(err: ApiError, closes: boolean) {
    if (closes) {
      setDialog(null);
      setNotice(null);
      setError(messageFor(err));
    }
    await refresh();
  }

  async function issue(kind: DocumentKind) {
    if (issueInFlight.current) return;
    issueInFlight.current = true;
    setIssuing(kind);
    setError(null);
    setNotice(null);
    const keys = kind === 'receipt' ? receiptKey : proformaKey;
    try {
      const doc = await api<FolioDocument>(`/stays/${stayId}/folio/documents`, send('POST', { kind, key: keys.key() }));
      keys.renew();
      // Stay "busy" while the browser leaves the page: a second click must not issue a second document.
      navigation.go(`/dokumenti/${doc.id}`);
    } catch (err) {
      setError(messageFor(err));
      if (err instanceof ApiError && err.status === 409) await refresh();
      issueInFlight.current = false;
      setIssuing(null);
    }
  }

  const canCorrect = role === 'owner' || role === 'manager';
  const stay = header?.stay;
  const guest = stay?.guests[0] ?? header?.reservation.holder;
  const chargeable = stay ? CHARGEABLE.has(stay.status) : true;

  return (
    <main className="folio-page">
      <p>
        <a href={folio ? `/rezervacije/${folio.reservationId}` : '/kalendar'}>
          {header ? `‹ Rezervacija ${header.reservation.number}` : '‹ Kalendar'}
        </a>
      </p>
      <div className="folio-title-row">
        <h1 tabIndex={-1}>Folio</h1>
        {folio && <span className={`badge folio-status is-${folio.status}`}>{FOLIO_STATUS_LABELS[folio.status]}</span>}
      </div>
      {guest && (
        <p className="folio-meta">
          <strong>{`${guest.firstName} ${guest.lastName}`}</strong>
          <span>
            {[
              header ? `Rezervacija ${header.reservation.number}` : null,
              header?.unit ? `Jedinica ${header.unit}` : null,
              stay ? `${formatDay(stay.arrival)} – ${formatDay(stay.departure)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </p>
      )}

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
      {!folio && !error && <p className="muted">Učitavanje…</p>}

      {folio && (
        <>
          {folio.fiscalNotice && (
            <p className="fiscal-notice" role="note">
              {FISCAL_NOTICE}
            </p>
          )}

          <dl className="folio-totals">
            <div className="folio-total">
              <dt>Ukupno</dt>
              <dd>{formatRsd(folio.chargesMinor)}</dd>
            </div>
            <div className="folio-total">
              <dt>Plaćeno</dt>
              <dd>{formatRsd(folio.paymentsMinor)}</dd>
            </div>
            <div className={`folio-total${folio.balanceMinor < 0 ? ' is-credit' : ''}`}>
              <dt>Saldo</dt>
              <dd>{formatRsd(folio.balanceMinor)}</dd>
              {folio.balanceMinor < 0 && <dd className="folio-total-note">{`Gost ima kredit ${formatRsd(creditOf(folio))}`}</dd>}
            </div>
          </dl>

          <FolioActions
            folio={folio}
            licence={licence}
            canCorrect={canCorrect}
            chargeable={chargeable}
            issuing={issuing}
            onOpen={setDialog}
            onIssue={(kind) => void issue(kind)}
          />

          {folio.unpostedNights.length > 0 && (
            <section aria-labelledby="folio-expected">
              <h2 id="folio-expected">Očekivane noći</h2>
              <p className="muted">Ove noći još nisu proknjižene. Knjiže se pri zatvaranju dana ili pri odjavi.</p>
              <table className="nights">
                <tbody>
                  {folio.unpostedNights.map((n) => (
                    <tr key={n.night}>
                      <td>{formatDay(n.night)}</td>
                      <td className="num">{formatRsd(n.priceMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section aria-labelledby="folio-lines">
            <h2 id="folio-lines">Stavke</h2>
            <LinesTable
              folio={folio}
              canReverse={canCorrect && folio.status === 'open'}
              disabled={licence !== 'full'}
              onReverse={(line) => setDialog({ type: 'reverse', line })}
            />
          </section>

          <section aria-labelledby="folio-payments">
            <h2 id="folio-payments">Plaćanja</h2>
            <PaymentsTable
              folio={folio}
              canVoid={canCorrect && folio.status === 'open'}
              disabled={licence !== 'full'}
              onVoid={(payment) => setDialog({ type: 'void', payment })}
            />
          </section>

          {docs.length > 0 && (
            <section aria-labelledby="folio-documents">
              <h2 id="folio-documents">Izdati dokumenti</h2>
              <ul className="list">
                {docs.map((d) => (
                  <li key={d.id}>
                    <div className="head">
                      <a href={`/dokumenti/${d.id}`}>{`${DOCUMENT_KIND_LABELS[d.kind] ?? d.kind} ${d.number}`}</a>
                      <span className="muted">{formatDateTime(d.issuedAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {folio && dialog?.type === 'charge' && (
        <ChargeDialog stayId={stayId} rates={folio.vatRatesBp} onClose={() => setDialog(null)} onDone={() => done('Zaduženje je dodato.')} onRefused={refused} />
      )}
      {folio && dialog?.type === 'pay' && (
        <PayDialog stayId={stayId} balanceMinor={folio.balanceMinor} onClose={() => setDialog(null)} onDone={() => done('Naplata je zabeležena.')} onRefused={refused} />
      )}
      {folio && dialog?.type === 'refund' && (
        <RefundDialog stayId={stayId} creditMinor={creditOf(folio)} onClose={() => setDialog(null)} onDone={() => done('Povraćaj je zabeležen.')} onRefused={refused} />
      )}
      {dialog?.type === 'reverse' && (
        <ReasonDialog
          title="Storniraj stavku"
          submitLabel="Storniraj"
          intro={`Stavka „${dialog.line.description}“ (${formatRsd(dialog.line.amountMinor)}) dobija storno stavku. Original ostaje na foliju, precrtan.`}
          path={`/folio-lines/${dialog.line.id}/reverse`}
          onClose={() => setDialog(null)}
          onDone={() => done('Stavka je stornirana.')}
          onRefused={refused}
        />
      )}
      {dialog?.type === 'void' && (
        <ReasonDialog
          title="Storniraj plaćanje"
          submitLabel="Storniraj"
          intro={`Plaćanje „${paymentMethodLabel(dialog.payment.method)}“ (${formatRsd(dialog.payment.amountMinor)}) dobija storno. Original ostaje na foliju, precrtan.`}
          path={`/payments/${dialog.payment.id}/void`}
          onClose={() => setDialog(null)}
          onDone={() => done('Plaćanje je stornirano.')}
          onRefused={refused}
        />
      )}
    </main>
  );
}

// ---- the actions ----

function FolioActions({
  folio,
  licence,
  canCorrect,
  chargeable,
  issuing,
  onOpen,
  onIssue,
}: {
  folio: Folio;
  licence: 'full' | 'safe' | 'none';
  canCorrect: boolean;
  chargeable: boolean;
  issuing: DocumentKind | null;
  onOpen: (dialog: Dialog) => void;
  onIssue: (kind: DocumentKind) => void;
}) {
  const open = folio.status !== 'closed';
  const hint =
    licence === 'safe'
      ? 'Licenca je istekla: naplata i dokumenti rade, zaduženja i storno ne.'
      : licence === 'none'
        ? 'Licenca nije ispravna: izmene i dokumenti nisu dostupni.'
        : open
          ? null
          : 'Folio je zatvoren: možete ga pregledati i izdati dokumente.';
  return (
    <div className="stack folio-actions-block">
      <div className="folio-actions">
        {open && chargeable && (
          <button type="button" disabled={licence !== 'full'} onClick={() => onOpen({ type: 'charge' })}>
            Dodaj zaduženje
          </button>
        )}
        {open && (
          <button type="button" disabled={licence === 'none'} onClick={() => onOpen({ type: 'pay' })}>
            Naplati
          </button>
        )}
        {open && canCorrect && creditOf(folio) > 0 && (
          <button type="button" className="secondary" disabled={licence === 'none'} onClick={() => onOpen({ type: 'refund' })}>
            Vrati novac
          </button>
        )}
        <button type="button" className="secondary" disabled={licence === 'none' || issuing !== null} onClick={() => onIssue('receipt')}>
          Nefiskalni račun
        </button>
        <button type="button" className="secondary" disabled={licence === 'none' || issuing !== null} onClick={() => onIssue('proforma')}>
          Predračun
        </button>
      </div>
      {hint && <p className="muted">{hint}</p>}
    </div>
  );
}

// ---- the tables ----

function LinesTable({
  folio,
  canReverse,
  disabled,
  onReverse,
}: {
  folio: Folio;
  canReverse: boolean;
  disabled: boolean;
  onReverse: (line: FolioLine) => void;
}) {
  if (folio.lines.length === 0) return <p className="muted">Na foliju još nema stavki.</p>;
  return (
    <table className="folio-table">
      <caption className="sr-only">Stavke folija</caption>
      <thead>
        <tr>
          <th scope="col">Datum</th>
          <th scope="col">Opis</th>
          <th scope="col" className="num">
            Iznos
          </th>
          <th scope="col" className="actions">
            <span className="sr-only">Radnje</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {folio.lines.map((l) => (
          <tr key={l.id} id={`line-${l.id}`} className={l.reversedBy ? 'is-reversed' : undefined}>
            <td data-label="Datum">{formatDay(l.businessDate)}</td>
            <td data-label="Opis">
              <div className="cell">
                <span className="desc">{l.description}</span>
                {l.reversedBy && (
                  <a className="trail" href={`#line-${l.reversedBy}`}>
                    Stornirano (vidi storno)
                  </a>
                )}
                {l.reversesLineId && (
                  <a className="trail" href={`#line-${l.reversesLineId}`}>
                    Storno stavke (vidi original)
                  </a>
                )}
                {l.reason && <span className="muted">{`Razlog: ${l.reason}`}</span>}
              </div>
            </td>
            <td data-label="Iznos" className="num">
              {formatRsd(l.amountMinor)}
            </td>
            <td className="actions">
              {canReverse && l.kind !== 'correction' && l.reversedBy === null && (
                <button
                  type="button"
                  className="danger small"
                  disabled={disabled}
                  aria-label={`Storniraj: ${l.description}`}
                  onClick={() => onReverse(l)}
                >
                  Storniraj
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function paymentKindLabel(p: FolioPayment): string {
  if (p.reversesPaymentId) return `Storno plaćanja: ${paymentMethodLabel(p.method)}`;
  if (p.amountMinor < 0) return `Povraćaj: ${paymentMethodLabel(p.method)}`;
  return paymentMethodLabel(p.method);
}

function PaymentsTable({
  folio,
  canVoid,
  disabled,
  onVoid,
}: {
  folio: Folio;
  canVoid: boolean;
  disabled: boolean;
  onVoid: (payment: FolioPayment) => void;
}) {
  if (folio.payments.length === 0) return <p className="muted">Još nema plaćanja.</p>;
  return (
    <table className="folio-table">
      <caption className="sr-only">Plaćanja na foliju</caption>
      <thead>
        <tr>
          <th scope="col">Datum</th>
          <th scope="col">Način</th>
          <th scope="col" className="num">
            Iznos
          </th>
          <th scope="col" className="actions">
            <span className="sr-only">Radnje</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {folio.payments.map((p) => (
          <tr key={p.id} id={`payment-${p.id}`} className={p.voidedBy ? 'is-reversed' : undefined}>
            <td data-label="Datum">{formatDay(p.businessDate)}</td>
            <td data-label="Način">
              <div className="cell">
                <span className="desc">{paymentKindLabel(p)}</span>
                {p.voidedBy && (
                  <a className="trail" href={`#payment-${p.voidedBy}`}>
                    Stornirano (vidi storno)
                  </a>
                )}
                {p.reversesPaymentId && (
                  <a className="trail" href={`#payment-${p.reversesPaymentId}`}>
                    Storno plaćanja (vidi original)
                  </a>
                )}
                {p.reference && <span className="muted">{`Referenca: ${p.reference}`}</span>}
                {p.reason && <span className="muted">{`Razlog: ${p.reason}`}</span>}
              </div>
            </td>
            <td data-label="Iznos" className="num">
              {formatRsd(p.amountMinor)}
            </td>
            <td className="actions">
              {canVoid && p.reversesPaymentId === null && p.voidedBy === null && (
                <button
                  type="button"
                  className="danger small"
                  disabled={disabled}
                  aria-label={`Storniraj plaćanje: ${paymentKindLabel(p)} ${formatRsd(p.amountMinor)}`}
                  onClick={() => onVoid(p)}
                >
                  Storniraj
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- the dialogs ----

type Prepared = { path: string; body: Record<string, unknown> } | { error: string };

interface DialogHandlers {
  onClose: () => void;
  onDone: () => void | Promise<void>;
  onRefused: (err: ApiError, closes: boolean) => void | Promise<void>;
}

/**
 * A money dialog. It makes its request key when it opens (a new dialog, a new
 * intent) and keeps it for every attempt: a second click or a retry after a
 * network error sends the same key, so the server answers with the first
 * result. A repeated 200 is a success like the first 201.
 */
function FormDialog({
  title,
  submitLabel,
  intro,
  prepare,
  onClose,
  onDone,
  onRefused,
  children,
}: DialogHandlers & {
  title: string;
  submitLabel: string;
  intro?: string;
  prepare: () => Prepared;
  children?: ReactNode;
}) {
  const keys = useIdempotencyKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // State updates land after the next click can already fire; the ref closes that gap.
  const inFlight = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const prepared = prepare();
    if ('error' in prepared) {
      setError(prepared.error);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api(prepared.path, send('POST', { ...prepared.body, key: keys.key() }));
      keys.renew();
      await onDone();
    } catch (err) {
      setError(messageFor(err));
      // A 409 means the folio moved on: read it again, and close unless the key itself is the problem
      // (then the person has to look at the folio first, with the dialog still open).
      if (err instanceof ApiError && (err.status === 409 || err.code === 'refund_exceeds_credit')) {
        await onRefused(err, err.status === 409 && err.code !== 'idempotency_key_reused');
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <form className="stack" noValidate aria-busy={busy} onSubmit={(e) => void submit(e)}>
        {intro && <p className="muted">{intro}</p>}
        {children}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="submit" disabled={busy}>
            {submitLabel}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Odustani
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string, describedBy?: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, hint ? `${id}-hint` : undefined)}
      {hint && (
        <p className="help" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function ChargeDialog({ stayId, rates, ...handlers }: DialogHandlers & { stayId: string; rates: number[] }) {
  const [kind, setKind] = useState('service');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  return (
    <FormDialog
      {...handlers}
      title="Dodaj zaduženje"
      submitLabel="Dodaj"
      prepare={() => {
        const text = description.trim();
        if (!text) return { error: 'Unesite opis zaduženja.' };
        const parsed = amountFrom(amount);
        if ('error' in parsed) return parsed;
        if (rates.length > 0 && rate === '') return { error: 'Izaberite PDV stopu.' };
        return {
          path: `/stays/${stayId}/folio/charges`,
          body: { kind, description: text, amountMinor: parsed.minor, vatRateBp: rates.length > 0 ? Number(rate) : null },
        };
      }}
    >
      <Field label="Vrsta">
        {(id) => (
          <select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="service">Usluga</option>
            <option value="fee">Naknada</option>
          </select>
        )}
      </Field>
      <Field label="Opis">
        {(id) => <input id={id} value={description} maxLength={200} autoComplete="off" onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <Field label="Iznos (RSD)" hint="Iznos sa uračunatim PDV-om.">
        {(id, describedBy) => (
          <input
            id={id}
            value={amount}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,00"
            aria-describedby={describedBy}
            onChange={(e) => setAmount(e.target.value)}
          />
        )}
      </Field>
      {rates.length > 0 && (
        <Field label="PDV stopa">
          {(id) => (
            <select id={id} value={rate} onChange={(e) => setRate(e.target.value)}>
              <option value="">Izaberite stopu</option>
              {rates.map((bp) => (
                <option key={bp} value={String(bp)}>
                  {formatVatRate(bp)}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
    </FormDialog>
  );
}

function MethodField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Field label="Način plaćanja">
      {(id) => (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {PAYMENT_METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function PayDialog({ stayId, balanceMinor, ...handlers }: DialogHandlers & { stayId: string; balanceMinor: number }) {
  const [method, setMethod] = useState('cash');
  // The balance the server computed is the default amount; the person can type any other.
  const [amount, setAmount] = useState(balanceMinor > 0 ? formatAmountInput(balanceMinor) : '');
  const [reference, setReference] = useState('');
  return (
    <FormDialog
      {...handlers}
      title="Naplata"
      submitLabel="Naplati"
      intro={balanceMinor > 0 ? `Saldo folija je ${formatRsd(balanceMinor)}.` : undefined}
      prepare={() => {
        const parsed = amountFrom(amount);
        if ('error' in parsed) return parsed;
        const ref = reference.trim();
        return {
          path: `/stays/${stayId}/folio/payments`,
          body: { method, amountMinor: parsed.minor, ...(ref ? { reference: ref } : {}) },
        };
      }}
    >
      <MethodField value={method} onChange={setMethod} />
      <Field label="Iznos (RSD)">
        {(id) => (
          <input id={id} value={amount} inputMode="decimal" autoComplete="off" placeholder="0,00" onChange={(e) => setAmount(e.target.value)} />
        )}
      </Field>
      <Field label="Referenca (nije obavezna)">
        {(id) => <input id={id} value={reference} maxLength={100} autoComplete="off" onChange={(e) => setReference(e.target.value)} />}
      </Field>
    </FormDialog>
  );
}

function RefundDialog({ stayId, creditMinor, ...handlers }: DialogHandlers & { stayId: string; creditMinor: number }) {
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState(formatAmountInput(creditMinor));
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      {...handlers}
      title="Vrati novac"
      submitLabel="Vrati novac"
      intro={`Gost ima kredit ${formatRsd(creditMinor)}. Možete vratiti najviše toliko.`}
      prepare={() => {
        const parsed = amountFrom(amount);
        if ('error' in parsed) return parsed;
        const why = reason.trim();
        if (!why) return { error: 'Unesite razlog povraćaja.' };
        return { path: `/stays/${stayId}/folio/refunds`, body: { method, amountMinor: parsed.minor, reason: why } };
      }}
    >
      <MethodField value={method} onChange={setMethod} />
      <Field label="Iznos (RSD)">
        {(id) => (
          <input id={id} value={amount} inputMode="decimal" autoComplete="off" placeholder="0,00" onChange={(e) => setAmount(e.target.value)} />
        )}
      </Field>
      <Field label="Razlog">
        {(id) => <textarea id={id} value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </FormDialog>
  );
}

/** Reversing a line and voiding a payment both ask for a reason only. */
function ReasonDialog({
  title,
  submitLabel,
  intro,
  path,
  ...handlers
}: DialogHandlers & { title: string; submitLabel: string; intro: string; path: string }) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      {...handlers}
      title={title}
      submitLabel={submitLabel}
      intro={intro}
      prepare={() => {
        const why = reason.trim();
        if (!why) return { error: 'Unesite razlog storna.' };
        return { path, body: { reason: why } };
      }}
    >
      <Field label="Razlog">
        {(id) => <textarea id={id} value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </FormDialog>
  );
}
