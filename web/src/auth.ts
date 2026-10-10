import { createContext, useContext } from 'react';

export interface AuthContextValue {
  authenticated: boolean;
  /** Who is signed in — shown in the nav, since an instance can have several users. */
  email: string;
  setAuthenticated: (v: boolean, email?: string) => void;
}

export const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  email: '',
  setAuthenticated: () => {},
});

export const useAuth = () => useContext(AuthContext);

/**
 * A one-time link carries its token in the URL fragment, which the server never
 * sees. Read it once and remove it from the address bar, so it does not sit in
 * the history or get copied along with the page.
 */
export function takeTokenFromUrl(): string {
  const token = window.location.hash.replace(/^#/, '');
  if (token) window.history.replaceState(null, '', window.location.pathname);
  return token;
}
