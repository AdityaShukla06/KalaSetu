import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { UserRole } from "../services/api";

interface AuthState {
  token: string | null;
  userId: string | null;
  email: string | null;
  role: UserRole | null;
}

interface AuthContextValue extends AuthState {
  isAuthenticated: boolean;
  login: (token: string, userId: string, email: string, role: UserRole) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const TOKEN_KEY = "kalasetu.token";
const USER_ID_KEY = "kalasetu.userId";
const EMAIL_KEY = "kalasetu.email";
const ROLE_KEY = "kalasetu.role";

function isUserRole(value: string | null): value is UserRole {
  return value === "artisan" || value === "buyer" || value === "admin";
}

function getInitialState(): AuthState {
  const storedRole = localStorage.getItem(ROLE_KEY);
  return {
    token: localStorage.getItem(TOKEN_KEY),
    userId: localStorage.getItem(USER_ID_KEY),
    email: localStorage.getItem(EMAIL_KEY),
    role: isUserRole(storedRole) ? storedRole : null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(getInitialState);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      isAuthenticated: state.token !== null,
      login: (token, userId, email, role) => {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(USER_ID_KEY, userId);
        localStorage.setItem(EMAIL_KEY, email);
        localStorage.setItem(ROLE_KEY, role);
        setState({ token, userId, email, role });
      },
      logout: () => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_ID_KEY);
        localStorage.removeItem(EMAIL_KEY);
        localStorage.removeItem(ROLE_KEY);
        setState({ token: null, userId: null, email: null, role: null });
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

export function roleLandingPath(role: UserRole): string {
  if (role === "buyer") return "/marketplace";
  if (role === "admin") return "/internal/console";
  return "/";
}
