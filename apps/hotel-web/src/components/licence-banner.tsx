'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { MESSAGES } from '@/lib/messages';

export interface LicenceSnapshot {
  activated: boolean;
  state: 'VALID' | 'GRACE' | 'EXPIRED' | 'INVALID' | 'NOT_ACTIVATED';
  modules: string[];
  limits: Record<string, number | null>;
  validUntil?: string;
  graceUntil?: string;
  reason?: string;
}

/**
 * The licence state from GET /licence, shown above every signed-in screen:
 * GRACE says until when everything still works, EXPIRED that the system is
 * in safe mode (viewing yes, changes no). Nothing while the licence is valid.
 */
export function LicenceBanner() {
  const [licence, setLicence] = useState<LicenceSnapshot | null>(null);

  useEffect(() => {
    let live = true;
    api<LicenceSnapshot>('/licence')
      .then((l) => {
        if (live) setLicence(l);
      })
      // The banner is extra information; the screen shows its own errors.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!licence) return null;
  switch (licence.state) {
    case 'GRACE': {
      const until = licence.graceUntil ? ` do ${formatDate(licence.graceUntil)}` : '';
      return (
        <div role="status" className="banner grace">
          {`Licenca je istekla. Sistem radi bez ograničenja${until}. Obnovite licencu na vreme.`}
        </div>
      );
    }
    case 'EXPIRED':
      return (
        <div role="alert" className="banner expired">
          {MESSAGES.safe_mode_blocked}
        </div>
      );
    case 'INVALID':
      return (
        <div role="alert" className="banner expired">
          {MESSAGES.invalid_license}
        </div>
      );
    case 'NOT_ACTIVATED':
      return (
        <div role="alert" className="banner expired">
          {MESSAGES.not_activated}
        </div>
      );
    default:
      return null;
  }
}
