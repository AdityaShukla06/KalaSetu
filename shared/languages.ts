export interface AppLanguage {
  code: string;
  englishName: string;
  nativeName: string;
  script: string;
  speechSupported: boolean;
}

/**
 * English plus the 22 languages of the Eighth Schedule of the Constitution.
 *
 * `speechSupported` records whether a transcription model covers the language.
 * Every one of them is now covered by Bhashini's ASR services. It stays
 * informational only: an artisan can speak any language and the pipeline will
 * still transcribe and translate, because the language is never used to gate
 * the request, only to pick a Bhashini service.
 */
export const APP_LANGUAGES: AppLanguage[] = [
  { code: "en", englishName: "English", nativeName: "English", script: "Latin", speechSupported: true },
  { code: "hi", englishName: "Hindi", nativeName: "हिंदी", script: "Devanagari", speechSupported: true },
  { code: "bn", englishName: "Bengali", nativeName: "বাংলা", script: "Bengali", speechSupported: true },
  { code: "mr", englishName: "Marathi", nativeName: "मराठी", script: "Devanagari", speechSupported: true },
  { code: "te", englishName: "Telugu", nativeName: "తెలుగు", script: "Telugu", speechSupported: true },
  { code: "ta", englishName: "Tamil", nativeName: "தமிழ்", script: "Tamil", speechSupported: true },
  { code: "gu", englishName: "Gujarati", nativeName: "ગુજરાતી", script: "Gujarati", speechSupported: true },
  { code: "ur", englishName: "Urdu", nativeName: "اردو", script: "Arabic", speechSupported: true },
  { code: "kn", englishName: "Kannada", nativeName: "ಕನ್ನಡ", script: "Kannada", speechSupported: true },
  { code: "ml", englishName: "Malayalam", nativeName: "മലയാളം", script: "Malayalam", speechSupported: true },
  { code: "pa", englishName: "Punjabi", nativeName: "ਪੰਜਾਬੀ", script: "Gurmukhi", speechSupported: true },
  { code: "as", englishName: "Assamese", nativeName: "অসমীয়া", script: "Bengali", speechSupported: true },
  { code: "ne", englishName: "Nepali", nativeName: "नेपाली", script: "Devanagari", speechSupported: true },
  { code: "sa", englishName: "Sanskrit", nativeName: "संस्कृतम्", script: "Devanagari", speechSupported: true },
  { code: "sd", englishName: "Sindhi", nativeName: "سنڌي", script: "Arabic", speechSupported: true },
  { code: "or", englishName: "Odia", nativeName: "ଓଡ଼ିଆ", script: "Odia", speechSupported: true },
  { code: "mai", englishName: "Maithili", nativeName: "मैथिली", script: "Devanagari", speechSupported: true },
  { code: "ks", englishName: "Kashmiri", nativeName: "کٲشُر", script: "Arabic", speechSupported: true },
  { code: "kok", englishName: "Konkani", nativeName: "कोंकणी", script: "Devanagari", speechSupported: true },
  { code: "doi", englishName: "Dogri", nativeName: "डोगरी", script: "Devanagari", speechSupported: true },
  { code: "mni", englishName: "Manipuri", nativeName: "ꯃꯤꯇꯩꯂꯣꯟ", script: "Meetei Mayek", speechSupported: true },
  { code: "brx", englishName: "Bodo", nativeName: "बड़ो", script: "Devanagari", speechSupported: true },
  { code: "sat", englishName: "Santali", nativeName: "ᱥᱟᱱᱛᱟᱲᱤ", script: "Ol Chiki", speechSupported: true },
];

export const DEFAULT_LANGUAGE = "en";

export const LANGUAGE_CODES = APP_LANGUAGES.map((l) => l.code);

const BY_CODE = new Map(APP_LANGUAGES.map((l) => [l.code, l]));

export function isAppLanguage(value: string): boolean {
  return BY_CODE.has(value);
}

export function getLanguage(code: string): AppLanguage {
  return BY_CODE.get(code) ?? BY_CODE.get(DEFAULT_LANGUAGE)!;
}

export function languageName(code: string): string {
  return getLanguage(code).englishName;
}

/** Languages written right to left, so the UI can flip direction. */
const RTL = new Set(["ur", "sd", "ks"]);

export function isRtl(code: string): boolean {
  return RTL.has(code);
}

/**
 * The Unicode block each script occupies. Used only to tell whether a message
 * was typed in its language's own script or romanised into Latin letters, so
 * "kitne din lagenge" is recognised as Hindi worth translating rather than
 * taken for English.
 */
const SCRIPT_PATTERNS: Record<string, RegExp> = {
  Latin: /[A-Za-z]/,
  Devanagari: /[\u0900-\u097F]/,
  Bengali: /[\u0980-\u09FF]/,
  Gurmukhi: /[\u0A00-\u0A7F]/,
  Gujarati: /[\u0A80-\u0AFF]/,
  Odia: /[\u0B00-\u0B7F]/,
  Tamil: /[\u0B80-\u0BFF]/,
  Telugu: /[\u0C00-\u0C7F]/,
  Kannada: /[\u0C80-\u0CFF]/,
  Malayalam: /[\u0D00-\u0D7F]/,
  Arabic: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF]/,
  "Meetei Mayek": /[\uABC0-\uABFF\uAAE0-\uAAFF]/,
  "Ol Chiki": /[\u1C50-\u1C7F]/,
};

/**
 * Whether the text is actually written in the script the language uses. False
 * for romanised text such as Hindi or Odia typed in Latin letters, which reads
 * as a different language to anyone who cannot sound it out.
 *
 * Asks whether most of the letters are in that script rather than whether any
 * are, because a mostly Bengali message carrying one English word is not
 * readable to an English speaker, and treating it as readable would withhold
 * the translate button from the person who needs it most. Text with no letters
 * in any known script (bare digits, punctuation) counts as readable: there is
 * nothing there to translate.
 */
export function isWrittenInOwnScript(text: string, code: string): boolean {
  const script = getLanguage(code).script;
  if (!SCRIPT_PATTERNS[script]) return true;

  let own = 0;
  let scripted = 0;

  for (const character of text) {
    let inOwnScript = false;
    let inAnyScript = false;

    for (const [name, pattern] of Object.entries(SCRIPT_PATTERNS)) {
      if (!pattern.test(character)) continue;
      inAnyScript = true;
      if (name === script) inOwnScript = true;
    }

    if (inAnyScript) scripted += 1;
    if (inOwnScript) own += 1;
  }

  return scripted === 0 || own * 2 >= scripted;
}
