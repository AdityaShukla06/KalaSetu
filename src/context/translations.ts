import { APP_LANGUAGES, DEFAULT_LANGUAGE } from "../../shared/languages";
import { DICTIONARIES } from "../../shared/locales";

export type Language = string;

export const translations = DICTIONARIES;

export const AVAILABLE_LANGUAGES = APP_LANGUAGES.filter((language) => translations[language.code]);

export function lookup(language: string, key: string): string | undefined {
  return translations[language]?.[key] ?? translations[DEFAULT_LANGUAGE]?.[key];
}
