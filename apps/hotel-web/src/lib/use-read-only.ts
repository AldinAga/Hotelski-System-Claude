'use client';

import { useEffect, useState } from 'react';
import type { LicenceSnapshot } from '@/components/licence-banner';
import { api } from './api';

/**
 * What the licence lets a screen do, from GET /licence:
 * - full: VALID and GRACE, everything;
 * - safe: EXPIRED (safe mode), only the actions in SAFE_MODE_ALLOWED
 *   (hotel-api licensing/safe-mode.ts): viewing, check-out, payment, documents, closing the day;
 * - none: INVALID and NOT_ACTIVATED, the API refuses every change.
 */
export type LicenceMode = 'full' | 'safe' | 'none';

function modeOf(state: LicenceSnapshot['state']): LicenceMode {
  if (state === 'EXPIRED') return 'safe';
  if (state === 'INVALID' || state === 'NOT_ACTIVATED') return 'none';
  return 'full';
}

/**
 * The licence mode, so a screen can disable controls instead of letting the
 * API say 403. Until the answer arrives (or when it fails) the mode is full:
 * the controls stay on and the API still refuses what it must.
 */
export function useLicenceMode(): LicenceMode {
  const [mode, setMode] = useState<LicenceMode>('full');
  useEffect(() => {
    let live = true;
    api<LicenceSnapshot>('/licence')
      .then((l) => {
        if (live) setMode(modeOf(l.state));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return mode;
}

/** True outside full: the screens whose every control is a change disable them all. */
export function useReadOnly(): boolean {
  return useLicenceMode() !== 'full';
}
