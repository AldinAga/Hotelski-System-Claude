'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, checkSetup, navigation, send } from '@/lib/api';
import { messageFor } from '@/lib/messages';

/**
 * Email and password; owners and managers also need the current code from
 * their authenticator. The code field appears once the API answers
 * totp_required (or totp_invalid), so receptionists never see it.
 */
export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // An installation still in first-run setup has nobody to sign in yet;
    // checkSetup sends the browser to /aktivacija in that case.
    checkSetup().catch(() => undefined);
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { email: email.trim(), password };
      if (needsCode) body.totp = totp.replace(/\s/g, '');
      await api('/auth/login', send('POST', body));
      navigation.go('/');
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'totp_required' || err.code === 'totp_invalid')) {
        setNeedsCode(true);
        setTotp('');
      }
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <h1>Prijava</h1>
      <form className="card stack" onSubmit={onSubmit}>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <label>
          E-adresa
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Lozinka
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {needsCode && (
          <>
            <label>
              Kod iz aplikacije
              <input
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </label>
            <p className="help">Šestocifreni kod iz aplikacije za autentifikaciju; menja se na 30 sekundi.</p>
          </>
        )}
        <button type="submit" disabled={busy}>
          Prijavi se
        </button>
      </form>
    </main>
  );
}
