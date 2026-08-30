import { APP_LANGUAGES, DEFAULT_LANGUAGE } from "../../shared/languages";

export type Language = string;

type Dictionary = Record<string, string>;

const modules = import.meta.glob<{ default: Dictionary }>("./locales/*.json", { eager: true });

function buildDictionaries(): Record<string, Dictionary> {
  const out: Record<string, Dictionary> = {};
  for (const [path, mod] of Object.entries(modules)) {
    const code = path.replace("./locales/", "").replace(".json", "");
    out[code] = mod.default;
  }
  return out;
}

export const translations = buildDictionaries();

export const AVAILABLE_LANGUAGES = APP_LANGUAGES.filter((language) => translations[language.code]);

export function lookup(language: string, key: string): string | undefined {
  return translations[language]?.[key] ?? translations[DEFAULT_LANGUAGE]?.[key];
}
