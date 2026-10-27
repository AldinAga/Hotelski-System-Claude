'use client';

import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, send, type SetupStatus } from '@/lib/api';
import { MESSAGES, messageFor } from '@/lib/messages';

type Step = 'loading' | 'already' | 'activate' | 'owner' | 'totp' | 'finished';

const LEGAL_KINDS = [
  { value: 'legal_entity', label: 'Pravno lice' },
  { value: 'entrepreneur', label: 'Preduzetnik' },
  { value: 'natural_person', label: 'Fizičko lice' },
] as const;

const STEP_TITLES: Array<[Step, string]> = [
  ['activate', '1. Aktivacija'],
  ['owner', '2. Objekat i vlasnik'],
  ['totp', '3. Aplikacija za kod'],
];

function secretOf(totpUri: string): string | null {
  try {
    return new URL(totpUri).searchParams.get('secret');
  } catch {
    return null;
  }
}

/**
 * First-run setup, three steps against /setup/*: activation code, property
 * and owner, then the owner's authenticator (QR from totpUri) confirmed with
 * its first code. Every call carries the setup token from the server log.
 */
export default function ActivationPage() {
  const [step, setStep] = useState<Step>('loading');
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [setupToken, setSetupToken] = useState('');
  const [code, setCode] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const [legalKind, setLegalKind] = useState<string>('legal_entity');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [totp, setTotp] = useState('');

  useEffect(() => {
    let live = true;
    api<SetupStatus>('/setup/status')
      .then((s) => {
        if (!live) return;
        setActivated(s.activated);
        setStep('activate');
      })
      .catch((err: unknown) => {
        if (!live) return;
        // 410: setup is done; this page has nothing left to do.
        if (err instanceof ApiError && err.status === 410) setStep('already');
        else {
          setError(messageFor(err));
          setStep('activate');
        }
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!totpUri) return;
    let live = true;
    // Drawn here, never sent to a QR service: the URI holds the TOTP secret.
    QRCode.toString(totpUri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((svg) => {
        if (live) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (live) setQr(null);
      });
    return () => {
      live = false;
    };
  }, [totpUri]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(messageFor(err));
      if (err instanceof ApiError && err.code === 'setup_done') setStep('already');
      else if (err instanceof ApiError && (err.code === 'setup_token_invalid' || err.code === 'not_activated')) {
        setStep('activate');
      }
    } finally {
      setBusy(false);
    }
  }

  function onActivate(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      if (!activated) {
        await api('/setup/activate', send('POST', { setupToken: setupToken.trim(), code: code.trim() }));
        setActivated(true);
      }
      setStep('owner');
    });
  }

  function onOwner(e: FormEvent) {
    e.preventDefault();
    if (password !== password2) {
      setError('Lozinke se ne poklapaju.');
      return;
    }
    void run(async () => {
      const res = await api<{ totpUri: string }>(
        '/setup/owner',
        send('POST', {
          setupToken: setupToken.trim(),
          propertyName: propertyName.trim(),
          legalKind,
          name: name.trim(),
          email: email.trim(),
          password,
        }),
      );
      setTotpUri(res.totpUri);
      setStep('totp');
    });
  }

  function onConfirm(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api('/setup/confirm', send('POST', { setupToken: setupToken.trim(), totp: totp.trim() }));
      setPassword('');
      setPassword2('');
      setStep('finished');
    });
  }

  const secret = totpUri ? secretOf(totpUri) : null;

  return (
    <main className="narrow">
      <h1>Prvo podešavanje</h1>

      {step !== 'loading' && step !== 'already' && step !== 'finished' && (
        <ol className="steps">
          {STEP_TITLES.map(([s, title]) => (
            <li key={s} className={s === step ? 'current' : undefined} aria-current={s === step ? 'step' : undefined}>
              {title}
            </li>
          ))}
        </ol>
      )}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {step === 'loading' && <p className="muted">Učitavanje…</p>}

      {step === 'already' && (
        <div className="card stack">
          <p>{MESSAGES.setup_done}</p>
          <a href="/prijava">Prijava</a>
        </div>
      )}

      {step === 'activate' && (
        <form className="card stack" onSubmit={onActivate}>
          <label>
            Kod za prvo podešavanje
            <input
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
            />
          </label>
          <p className="help">Kod ispisuje hotel-api u logu pri svakom pokretanju dok podešavanje ne završite.</p>
          {activated ? (
            <>
              <p className="notice">Instalacija je već aktivirana. Nastavite na podatke objekta.</p>
              <button type="submit" disabled={busy}>
                Nastavi
              </button>
            </>
          ) : (
            <>
              <label>
                Aktivacioni kod
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
              <p className="help">Aktivacioni kod dobijate iz Centralnog admina; važi za jednu instalaciju.</p>
              <button type="submit" disabled={busy}>
                Aktiviraj
              </button>
            </>
          )}
        </form>
      )}

      {step === 'owner' && (
        <form className="card stack" onSubmit={onOwner}>
          <label>
            Naziv objekta
            <input value={propertyName} onChange={(e) => setPropertyName(e.target.value)} required />
          </label>
          <label>
            Pravni oblik
            <select value={legalKind} onChange={(e) => setLegalKind(e.target.value)}>
              {LEGAL_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ime i prezime vlasnika
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
          <label>
            E-adresa
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
          <label>
            Lozinka
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            Ponovite lozinku
            <input
              type="password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            Nastavi
          </button>
        </form>
      )}

      {step === 'totp' && (
        <form className="card stack" onSubmit={onConfirm}>
          <p>
            Skenirajte QR kod aplikacijom za autentifikaciju (npr. Google Authenticator ili Microsoft Authenticator), pa
            unesite kod koji aplikacija prikaže. Vlasnik se bez tog koda ne može prijaviti.
          </p>
          {qr && <img className="qr" src={qr} alt="QR kod za aplikaciju za autentifikaciju" width={220} height={220} />}
          {secret && (
            <p className="help">
              Ako ne možete da skenirate, unesite ručno ovaj ključ: <code className="secret">{secret}</code>
            </p>
          )}
          <label>
            Kod iz aplikacije
            <input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            Potvrdi
          </button>
        </form>
      )}

      {step === 'finished' && (
        <div className="card stack">
          <p className="notice">
            Podešavanje je završeno. Za prvu prijavu sačekajte da aplikacija prikaže novi kod (menja se na 30 sekundi):
            isti kod ne može se upotrebiti dva puta.
          </p>
          <a href="/prijava">Prijava</a>
        </div>
      )}
    </main>
  );
}
