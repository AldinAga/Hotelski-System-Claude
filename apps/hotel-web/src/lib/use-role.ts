'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

export type UserRole = 'owner' | 'manager' | 'receptionist' | 'housekeeping';

/**
 * Roles the API lets change units, unit types, blocks and prices
 * (@Roles('owner', 'manager') on those routes in hotel-api).
 */
export const SETTINGS_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['owner', 'manager']);

/**
 * The signed-in user's role from GET /auth/me, or null until it is known (or
 * when the call fails). Screens hide change controls only for a role they
 * know lacks the right; while unknown the controls stay and the API still
 * refuses what it must (forbidden_role), as with useReadOnly.
 */
export function useRole(): UserRole | null {
  const [role, setRole] = useState<UserRole | null>(null);
  useEffect(() => {
    let live = true;
    api<{ role: UserRole }>('/auth/me')
      .then((me) => {
        if (live) setRole(me.role);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return role;
}

/** False only when the role is known and the API would refuse settings changes. */
export function useCanChangeSettings(): boolean {
  const role = useRole();
  return role === null || SETTINGS_ROLES.has(role);
}
