import { createContext, useContext } from 'react';

export interface AuthContextValue {
  authenticated: boolean;
  /** Who is signed in — shown in the nav, since an instance can have several users. */
  email: string;
  setAuthenticated: (v: boolean, email?: string) => void;
  /** What the account still has to agree to before the app shows anything; null when it has agreed. */
  consentNeeded: { health: boolean; terms: boolean } | null | undefined;
  consentGiven: () => void;
  /** The account has no vault yet and is asked to make one. */
  vaultNeeded: boolean;
  vaultMade: () => void;
  /** Whether the records are open on this device (the vault is opened with a key made from the master password). */
  deviceState: 'starting' | 'locked' | 'open';
  deviceOpened: () => void;
  /** The demo is open: sample records in this browser's memory, with no account and no vault behind them. */
  demo: boolean;
  /** Starts the demo and loads the sample records; throws if the core could not start. */
  startDemo: (language: 'en' | 'ro') => Promise<void>;
  /** Ends the demo; what was in it is gone. */
  leaveDemo: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  email: '',
  setAuthenticated: () => {},
  consentNeeded: null,
  consentGiven: () => {},
  vaultNeeded: false,
  vaultMade: () => {},
  deviceState: 'open',
  deviceOpened: () => {},
  demo: false,
  startDemo: async () => {},
  leaveDemo: async () => {},
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
