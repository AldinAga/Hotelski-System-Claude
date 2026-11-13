'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { SelectField, TextField } from '@/components/form-fields';
import { ApiError, api, send } from '@/lib/api';
import {
  ACCOMMODATION_CATEGORIES,
  FISCAL_COMPLIANCE_MODES,
  FISCAL_NOTICE,
  LEGAL_KINDS,
  missingLabel,
  type LegalKind,
  type LegalProfile,
} from '@/lib/business';
import { FORM_ORDER, bodyOf, formOf, isShownMask, validate, type LegalForm, type LegalFormErrors, type LegalFormField } from '@/lib/legal-form';
import { messageFor } from '@/lib/messages';
import { useLicenceMode } from '@/lib/use-read-only';
import { useCanChangeSettings } from '@/lib/use-role';

const KIND_LABEL = Object.fromEntries(LEGAL_KINDS.map((k) => [k.value, k.label])) as Record<LegalKind, string>;

function isField(name: unknown): name is LegalFormField {
  return typeof name === 'string' && (FORM_ORDER as string[]).includes(name);
}

export default function LegalProfilePage() {
  const canChange = useCanChangeSettings();
  const licence = useLicenceMode();
  const [profile, setProfile] = useState<LegalProfile | null>(null);
  const [form, setForm] = useState<LegalForm | null>(null);
  const [errors, setErrors] = useState<LegalFormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  function show(p: LegalProfile) {
    setProfile(p);
    setForm(formOf(p));
    setErrors({});
  }

  useEffect(() => {
    let live = true;
    api<LegalProfile>('/legal-profile')
      .then((p) => {
        if (live) show(p);
      })
      .catch((err: unknown) => {
        if (live) setError(messageFor(err));
      });
    return () => {
      live = false;
    };
  }, []);

  function set<K extends LegalFormField>(field: K, value: LegalForm[K]) {
    setForm((f) => (f ? { ...f, [field]: value } : f));
    setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function focusField(field: LegalFormField) {
    // The kind is a group of radios: the first one carries the focus.
    const target = field === 'kind' ? document.querySelector<HTMLElement>('input[name="kind"]') : document.getElementById(field);
    target?.focus();
  }

  function focusFirst(found: LegalFormErrors) {
    const first = FORM_ORDER.find((f) => found[f]);
    if (first) focusField(first);
  }

  // The fields are off while a save runs, and a disabled field cannot take the focus:
  // the field the API refused gets it once the form is on again.
  const [refusedField, setRefusedField] = useState<LegalFormField | null>(null);
  useEffect(() => {
    if (refusedField === null || busy) return;
    focusField(refusedField);
    setRefusedField(null);
  }, [refusedField, busy]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!profile || !form || inFlight.current || licence !== 'full') return;
    const found = validate(form, profile);
    setErrors(found);
    if (Object.values(found).some(Boolean)) {
      focusFirst(found);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show(await api<LegalProfile>('/legal-profile', send('PUT', bodyOf(form, profile))));
      setNotice('Pravni profil je sačuvan.');
    } catch (err) {
      const message = messageFor(err);
      setError(message);
      // The API names the field it refused: mark that one as well.
      const field = err instanceof ApiError && err.code === 'validation_failed' ? err.details?.field : null;
      if (isField(field)) {
        const refused: LegalFormErrors = {};
        refused[field] = message;
        setErrors(refused);
        setRefusedField(field);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const locked = licence !== 'full';
  const kind: LegalKind | null = profile?.kind ?? (form && form.kind !== '' ? form.kind : null);
  const natural = kind === 'natural_person';
  const masked = profile && form ? isShownMask(form, profile) : false;
  const idsEmpty = form !== null && !natural && (form.taxId.trim() === '' || form.registryId.trim() === '');

  return (
    <main className="settings-page legal-form">
      <h1 tabIndex={-1}>Pravni profil</h1>
      {!canChange ? (
        <p className="muted">Pravni profil menjaju vlasnik i menadžer.</p>
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
          {locked && <p className="muted">Licenca ne dozvoljava izmene. Pravni profil je samo za pregled.</p>}

          {profile && profile.missing.length > 0 && (
            <p role="status" className="warn">
              {`Za račune nedostaje: ${profile.missing.map((m) => missingLabel(m, profile.kind)).join(', ')}.`}
            </p>
          )}
          {profile?.fiscalNotice === 'not_available_yet' && (
            <p role="status" className="warn">
              {FISCAL_NOTICE}
            </p>
          )}

          {profile && form && (
            <form className="card stack" noValidate aria-label="Pravni profil objekta" onSubmit={(e) => void save(e)}>
              <fieldset className="fieldset" disabled={locked || busy}>
                <legend>Vrsta lica</legend>
                {profile.kind === null ? (
                  <div className="field">
                    <div className="radios" role="radiogroup" aria-label="Vrsta lica" aria-describedby={errors.kind ? 'kind-error' : undefined}>
                      {LEGAL_KINDS.map((k) => (
                        <label key={k.value} className="radio">
                          <input
                            type="radio"
                            name="kind"
                            value={k.value}
                            checked={form.kind === k.value}
                            onChange={() => set('kind', k.value)}
                          />
                          {k.label}
                        </label>
                      ))}
                    </div>
                    {errors.kind && (
                      <p id="kind-error" className="field-error">
                        {errors.kind}
                      </p>
                    )}
                    <p className="help">Vrsta lica se posle prvog čuvanja ne menja.</p>
                  </div>
                ) : (
                  <p>
                    <strong>{KIND_LABEL[profile.kind]}</strong>
                    <span className="muted">{' · ne menja se posle prvog čuvanja'}</span>
                  </p>
                )}
              </fieldset>

              <fieldset className="fieldset" disabled={locked || busy}>
                <legend>Podaci za račune</legend>
                <TextField id="legalName" label="Pun naziv" value={form.legalName} onChange={(v) => set('legalName', v)} maxLength={200} autoComplete="organization" error={errors.legalName} />
                <div className="row">
                  <div className="grow">
                    <TextField
                      id="taxId"
                      label="PIB"
                      value={form.taxId}
                      onChange={(v) => set('taxId', v)}
                      inputMode="numeric"
                      maxLength={9}
                      required={!natural}
                      help="9 cifara."
                      error={errors.taxId}
                    />
                  </div>
                  <div className="grow">
                    <TextField
                      id="registryId"
                      label={natural ? 'JMBG' : kind === null ? 'Matični broj / JMBG' : 'Matični broj (MB)'}
                      value={form.registryId}
                      onChange={(v) => set('registryId', v)}
                      inputMode="numeric"
                      maxLength={20}
                      required={!natural && kind !== null}
                      help={masked ? 'Prikazan je maskiran. Upišite novi JMBG da biste ga zamenili.' : natural ? '13 cifara, nije obavezan.' : '8 cifara.'}
                      error={errors.registryId}
                    />
                  </div>
                </div>
                <label className="check">
                  <input type="checkbox" checked={form.vatPayer} onChange={(e) => set('vatPayer', e.target.checked)} />
                  Obveznik PDV-a
                </label>
                <TextField id="address" label="Adresa" value={form.address} onChange={(v) => set('address', v)} maxLength={200} autoComplete="street-address" error={errors.address} />
                <div className="row">
                  <div className="grow">
                    <TextField id="postalCode" label="Poštanski broj" value={form.postalCode} onChange={(v) => set('postalCode', v)} maxLength={20} autoComplete="postal-code" error={errors.postalCode} />
                  </div>
                  <div className="grow">
                    <TextField id="city" label="Mesto" value={form.city} onChange={(v) => set('city', v)} maxLength={100} autoComplete="address-level2" error={errors.city} />
                  </div>
                </div>
                <div className="row">
                  <div className="grow">
                    <TextField id="activityCode" label="Šifra delatnosti" value={form.activityCode} onChange={(v) => set('activityCode', v)} maxLength={10} inputMode="numeric" error={errors.activityCode} />
                  </div>
                  <div className="grow">
                    <TextField id="bankAccount" label="Broj računa" value={form.bankAccount} onChange={(v) => set('bankAccount', v)} maxLength={30} placeholder="160-0000000123456-78" error={errors.bankAccount} />
                  </div>
                </div>
                <div className="row">
                  <div className="grow">
                    <TextField id="email" label="E-adresa" value={form.email} onChange={(v) => set('email', v)} inputMode="email" autoComplete="email" error={errors.email} />
                  </div>
                  <div className="grow">
                    <TextField id="phone" label="Telefon" value={form.phone} onChange={(v) => set('phone', v)} inputMode="tel" maxLength={50} autoComplete="tel" error={errors.phone} />
                  </div>
                </div>
              </fieldset>

              <fieldset className="fieldset" disabled={locked || busy}>
                <legend>Smeštaj</legend>
                <SelectField
                  id="accommodationCategory"
                  label="Kategorija smeštaja"
                  value={form.accommodationCategory}
                  onChange={(v) => set('accommodationCategory', v as LegalForm['accommodationCategory'])}
                  options={[{ value: '', label: 'Nije izabrana' }, ...ACCOMMODATION_CATEGORIES]}
                  error={errors.accommodationCategory}
                />
                <TextField id="categorizationNumber" label="Broj rešenja o kategorizaciji" value={form.categorizationNumber} onChange={(v) => set('categorizationNumber', v)} maxLength={50} error={errors.categorizationNumber} />
              </fieldset>

              <fieldset className="fieldset" disabled={locked || busy}>
                <legend>Fiskalizacija</legend>
                <SelectField
                  id="fiscalComplianceMode"
                  label="Način fiskalizacije"
                  value={form.fiscalComplianceMode}
                  onChange={(v) => set('fiscalComplianceMode', v as LegalForm['fiscalComplianceMode'])}
                  options={[{ value: '', label: 'Prema vrsti lica' }, ...FISCAL_COMPLIANCE_MODES]}
                  help={idsEmpty ? 'Prvo upišite PIB i matični broj; bez njih se profil ne čuva.' : undefined}
                  error={errors.fiscalComplianceMode}
                />
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
