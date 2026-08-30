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
 * `speechSupported` records whether the transcription model recognises the
 * language by name. It is informational only: an artisan can speak any
 * language and the pipeline will still transcribe and translate, because the
 * detected language is never used to gate the request.
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
  { code: "or", englishName: "Odia", nativeName: "ଓଡ଼ିଆ", script: "Odia", speechSupported: false },
  { code: "mai", englishName: "Maithili", nativeName: "मैथिली", script: "Devanagari", speechSupported: false },
  { code: "ks", englishName: "Kashmiri", nativeName: "کٲشُر", script: "Arabic", speechSupported: false },
  { code: "kok", englishName: "Konkani", nativeName: "कोंकणी", script: "Devanagari", speechSupported: false },
  { code: "doi", englishName: "Dogri", nativeName: "डोगरी", script: "Devanagari", speechSupported: false },
  { code: "mni", englishName: "Manipuri", nativeName: "ꯃꯤꯇꯩꯂꯣꯟ", script: "Meetei Mayek", speechSupported: false },
  { code: "brx", englishName: "Bodo", nativeName: "बड़ो", script: "Devanagari", speechSupported: false },
  { code: "sat", englishName: "Santali", nativeName: "ᱥᱟᱱᱛᱟᱲᱤ", script: "Ol Chiki", speechSupported: false },
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
