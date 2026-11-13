'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { BUSINESS_DAY_CHANGED, dayMonth, daysLabel, type BusinessDayView } from '@/lib/business';

/**
 * "Poslovni dan: 3.11." beside the menu, red while the business day lags
 * behind the calendar. It reads GET /business-day by itself and says nothing
 * when the answer fails (a role without access, a licence without the folio
 * module): the badge is extra information. The screen that closes the day
 * announces it (BUSINESS_DAY_CHANGED), so the badge never keeps the old day.
 */
export function BusinessDayBadge() {
  const [view, setView] = useState<Pick<BusinessDayView, 'day' | 'lagDays'> | null>(null);

  const load = useCallback(() => {
    let live = true;
    api<BusinessDayView>('/business-day')
      .then((v) => {
        if (live) setView({ day: v.day, lagDays: v.lagDays });
      })
      .catch(() => {
        if (live) setView(null);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let stop = load();
    const again = () => {
      stop();
      stop = load();
    };
    window.addEventListener(BUSINESS_DAY_CHANGED, again);
    return () => {
      window.removeEventListener(BUSINESS_DAY_CHANGED, again);
      stop();
    };
  }, [load]);

  if (!view) return null;
  // lagDays is negative after an evening close: the day is ahead, not late.
  const late = view.lagDays > 0;
  return (
    <span className={late ? 'day-badge is-late' : 'day-badge'} data-late={late ? 'true' : 'false'}>
      {`Poslovni dan: ${dayMonth(view.day)}`}
      {late && <span className="visually-hidden">{` (kasni ${daysLabel(view.lagDays)})`}</span>}
    </span>
  );
}
