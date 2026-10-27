'use client';

import { api, navigation, send } from '@/lib/api';

export function SignOutButton() {
  async function signOut() {
    // A session that is already gone still ends on the sign-in page.
    await api('/auth/logout', send('POST')).catch(() => undefined);
    navigation.go('/prijava');
  }
  return (
    <button type="button" className="secondary" onClick={signOut}>
      Odjava
    </button>
  );
}
