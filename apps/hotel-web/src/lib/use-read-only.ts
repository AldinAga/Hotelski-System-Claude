'use client';

import { useEffect, useState } from 'react';
import type { LicenceSnapshot } from '@/components/licence-banner';
import { api } from './api';

/** States in which the API refuses every change (safe mode, or no usable licence). */
const READ_ONLY_STATES: ReadonlySet<LicenceSnapshot['state']> = new Set(['EXPIRED', 'INVALID', 'NOT_ACTIVATED']);

/**
 * True while GET /licence reports a state in which changes are refused, so
 * a screen can disable its change controls instead of letting the API say
 * 403 safe_mode_blocked. Until the answer arrives (or when it fails) the
 * controls stay on: the API still refuses what it must.
 */
export function useReadOnly(): boolean {
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    let live = true;
    api<LicenceSnapshot>('/licence')
      .then((l) => {
        if (live) setReadOnly(READ_ONLY_STATES.has(l.state));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return readOnly;
}
