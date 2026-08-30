import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { lookup, AVAILABLE_LANGUAGES } from "./translations";
import { DEFAULT_LANGUAGE, isRtl } from "../../shared/languages";

export type Language = string;

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

const STORAGE_KEY = "kalasetu.language";

function isAvailable(code: string): boolean {
  return AVAILABLE_LANGUAGES.some((language) => language.code === code);
}

function getInitialLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && isAvailable(stored)) return stored;

  const preferred = navigator.languages ?? [navigator.language];
  for (const tag of preferred) {
    const base = tag.split("-")[0];
    if (isAvailable(base)) return base;
  }

  return DEFAULT_LANGUAGE;
}

function translate(language: Language, key: string, params?: Record<string, string | number>): string {
  const template = lookup(language, key) ?? key;
  if (!params) return template;
  return Object.entries(params).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = isRtl(language) ? "rtl" : "ltr";
    localStorage.setItem(STORAGE_KEY, language);
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage: (next) => setLanguageState(isAvailable(next) ? next : DEFAULT_LANGUAGE),
      t: (key, params) => translate(language, key, params),
    }),
    [language],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within a LanguageProvider");
  return ctx;
}
