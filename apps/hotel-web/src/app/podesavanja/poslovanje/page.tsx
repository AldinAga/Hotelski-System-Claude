'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { SelectField, TextField } from '@/components/form-fields';
import { ApiError, api, send } from '@/lib/api';
import { MAX_VAT_RATES, NO_SHOW_CHARGES, formatPercent, parsePercent, type BusinessSettings } from '@/lib/business';
import { messageFor } from '@/lib/messages';
import { useLicenceMode } from '@/lib/use-read-only';
import { useCanChangeSettings } from '@/lib/use-role';

/** The API's own rule for the automatic close time (hotel-api settings.service.ts); 24:00 does not exist. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type Errors = Partial<Record<'autoCloseTime' | 'accommodationVatBp' | 'newRate', string>>;

export default function BusinessSettingsPage() {
  const canChange = useCanChangeSettings();
  const licence = useLicenceMode();
  const [loaded, setLoaded] = useState(false);
  const [autoCloseTime, setAutoCloseTime] = useState('');
  const [noShowCharge, setNoShowCharge] = useState<BusinessSettings['noShowCharge']>('none');
  const [vat, setVat] = useState('');
  const [rates, setRates] = useState<number[]>([]);
  const [newRate, setNewRate] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  function show(s: BusinessSettings) {
    setAutoCloseTime(s.autoCloseTime ?? '');
    setNoShowCharge(s.noShowCharge);
    setVat(s.accommodationVatBp === null ? '' : formatPercent(s.accommodationVatBp));
    setRates(s.vatRatesBp);
    setNewRate('');
    setErrors({});
    setLoaded(true);
  }

  useEffect(() => {
    let live = true;
    api<BusinessSettings>('/settings/business')
      .then((s) => {
        if (live) show(s);
      })
      .catch((err: unknown) => {
        if (live) setError(messageFor(err));
      });
    return () => {
      live = false;
    };
  }, []);

  /** Moves the typed rate into the list, or says why it cannot go there. */
  function addRate() {
    const bp = parsePercent(newRate);
    if (bp === null) {
      setErrors((e) => ({ ...e, newRate: 'Upišite stopu od 0 do 100 %, na primer 20 ili 10,5.' }));
      return;
    }
    if (rates.includes(bp)) {
      setErrors((e) => ({ ...e, newRate: 'Ta stopa je već na spisku.' }));
      return;
    }
    if (rates.length >= MAX_VAT_RATES) {
      setErrors((e) => ({ ...e, newRate: `Na spisku može biti najviše ${MAX_VAT_RATES} stopa.` }));
      return;
    }
    setRates([...rates, bp]);
    setNewRate('');
    setErrors((e) => ({ ...e, newRate: undefined }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || licence !== 'full') return;

    const next: Errors = {};
    if (autoCloseTime !== '' && !TIME.test(autoCloseTime)) {
      next.autoCloseTime = 'Upišite vreme od 00:00 do 23:59, na primer 03:00. Za ručno zatvaranje ostavite polje prazno.';
    }
    const vatBp = vat.trim() === '' ? null : parsePercent(vat);
    if (vat.trim() !== '' && vatBp === null) next.accommodationVatBp = 'Upišite stopu od 0 do 100 %, na primer 10 ili 10,5.';
    if (newRate.trim() !== '') next.newRate = 'Dodajte stopu dugmetom „Dodaj stopu“ ili obrišite polje.';
    setErrors(next);
    const first = (['autoCloseTime', 'accommodationVatBp', 'newRate'] as const).find((k) => next[k]);
    if (first) {
      document.getElementById(first)?.focus();
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api<BusinessSettings>(
        '/settings/business',
        send('PUT', {
          autoCloseTime: autoCloseTime === '' ? null : autoCloseTime,
          noShowCharge,
          accommodationVatBp: vatBp,
          vatRatesBp: rates,
        }),
      );
      show(saved);
      setNotice('Podešavanja su sačuvana.');
    } catch (err) {
      setError(messageFor(err));
      // The API names the field it refused: mark that one as well.
      const field = err instanceof ApiError && err.code === 'validation_failed' ? err.details?.field : null;
      if (field === 'autoCloseTime' || field === 'accommodationVatBp') {
        const refused: Errors = {};
        refused[field] = messageFor(err);
        setErrors(refused);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const locked = licence !== 'full';

  return (
    <main className="settings-page">
      <h1 tabIndex={-1}>Poslovanje</h1>
      {!canChange ? (
        <p className="muted">Podešavanja poslovanja menjaju vlasnik i menadžer.</p>
      ) : (
        <>
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
          {locked && <p className="muted">Licenca ne dozvoljava izmene. Podešavanja su samo za pregled.</p>}

          {loaded && (
            <form className="card stack" noValidate aria-label="Podešavanja poslovanja" onSubmit={(e) => void save(e)}>
              <fieldset className="fieldset" disabled={locked || busy}>
                <legend>Zatvaranje dana</legend>
                <TextField
                  id="autoCloseTime"
                  label="Vreme automatskog zatvaranja"
                  value={autoCloseTime}
                  onChange={setAutoCloseTime}
                  inputMode="numeric"
                  maxLength={5}
                  placeholder="03:00"
                  help="Prazno polje znači da dan zatvarate ručno."
                  error={errors.autoCloseTime}
                />
                <SelectField
                  id="noShowCharge"
                  label="Kad gost ne dođe"
                  value={noShowCharge}
                  onChange={(v) => setNoShowCharge(v as BusinessSettings['noShowCharge'])}
                  options={NO_SHOW_CHARGES}
                />
              </fieldset>

              <fieldset className="fieldset" disabled={locked || busy}>
                <legend>PDV</legend>
                <TextField
                  id="accommodationVatBp"
                  label="PDV stopa smeštaja (%)"
                  value={vat}
                  onChange={setVat}
                  inputMode="decimal"
                  placeholder="10"
                  help="Prazno polje znači da se PDV smeštaja ne prikazuje."
                  error={errors.accommodationVatBp}
                />

                <div className="field">
                  <span className="field-label" id="vatRates-label">
                    Dozvoljene stope za zaduženja (%)
                  </span>
                  {rates.length === 0 ? (
                    <p className="muted">Nijedna stopa nije dodata.</p>
                  ) : (
                    <ul className="chips" aria-labelledby="vatRates-label">
                      {rates.map((bp) => (
                        <li key={bp} className="chip">
                          <span>{`${formatPercent(bp)} %`}</span>
                          <button
                            type="button"
                            className="chip-remove"
                            aria-label={`Ukloni stopu ${formatPercent(bp)} %`}
                            onClick={() => setRates(rates.filter((r) => r !== bp))}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="row">
                  <div className="grow">
                    <TextField
                      id="newRate"
                      label="Nova stopa (%)"
                      value={newRate}
                      onChange={(v) => {
                        setNewRate(v);
                        setErrors((e) => ({ ...e, newRate: undefined }));
                      }}
                      inputMode="decimal"
                      placeholder="20"
                      error={errors.newRate}
                    />
                  </div>
                  <button type="button" className="secondary" onClick={addRate}>
                    Dodaj stopu
                  </button>
                </div>
              </fieldset>

              <button type="submit" disabled={locked || busy}>
                Sačuvaj
              </button>
            </form>
          )}
        </>
      )}
    </main>
  );
}
