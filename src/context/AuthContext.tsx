import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { onIdTokenChanged } from "firebase/auth";
import { getFirebaseAuth } from "../services/firebase";

interface AuthState {
  token: string | null;
  userId: string | null;
  phoneNumber: string | null;
}

interface AuthContextValue extends AuthState {
  isAuthenticated: boolean;
  login: (token: string, userId: string, phoneNumber: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const TOKEN_KEY = "kalasetu.token";
const USER_ID_KEY = "kalasetu.userId";
const PHONE_NUMBER_KEY = "kalasetu.phoneNumber";

function getInitialState(): AuthState {
  return {
    token: localStorage.getItem(TOKEN_KEY),
    userId: localStorage.getItem(USER_ID_KEY),
    phoneNumber: localStorage.getItem(PHONE_NUMBER_KEY),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(getInitialState);

  useEffect(() => {
    let auth;
    try {
      auth = getFirebaseAuth();
    } catch {
      return;
    }

    return onIdTokenChanged(auth, async (user) => {
      if (!user) {
        if (localStorage.getItem(TOKEN_KEY) === null) return;
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_ID_KEY);
        localStorage.removeItem(PHONE_NUMBER_KEY);
        setState({ token: null, userId: null, phoneNumber: null });
        return;
      }

      const token = await user.getIdToken();
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_ID_KEY, user.uid);
      setState((prev) => ({ ...prev, token, userId: user.uid }));
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      isAuthenticated: state.token !== null,
      login: (token, userId, phoneNumber) => {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(USER_ID_KEY, userId);
        localStorage.setItem(PHONE_NUMBER_KEY, phoneNumber);
        setState({ token, userId, phoneNumber });
      },
      logout: () => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_ID_KEY);
        localStorage.removeItem(PHONE_NUMBER_KEY);
        setState({ token: null, userId: null, phoneNumber: null });
        try {
          getFirebaseAuth().signOut();
        } catch {
          return;
        }
      },
    }),
    [state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
