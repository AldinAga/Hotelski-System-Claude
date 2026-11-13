'use client';

import { SETTINGS_ROLES, useRole } from '@/lib/use-role';
import { BusinessDayBadge } from './business-day-badge';

/**
 * Menu entries of the business day and the business settings. Each is hidden
 * only for a role known to lack the right (housekeeping has no business day;
 * the settings are owner and manager, as @Roles in hotel-api); until the role
 * is known they stay and the API still refuses what it must.
 */
export function BusinessMenu() {
  const role = useRole();
  const showDay = role !== 'housekeeping';
  const showSettings = role === null || SETTINGS_ROLES.has(role);
  return (
    <>
      {showDay && (
        <>
          <a href="/poslovni-dan">Poslovni dan</a>
          <BusinessDayBadge />
        </>
      )}
      {showSettings && (
        <>
          <a href="/podesavanja/poslovanje">Poslovanje</a>
          <a href="/podesavanja/pravni-profil">Pravni profil</a>
        </>
      )}
    </>
  );
}
