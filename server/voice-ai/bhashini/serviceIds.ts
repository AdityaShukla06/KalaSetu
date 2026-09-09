const CONFORMER_HI = "ai4bharat/conformer-hi-gpu--t4";
const CONFORMER_DRAVIDIAN = "ai4bharat/conformer-multilingual-dravidian-gpu--t4";
const CONFORMER_INDO_ARYAN = "ai4bharat/conformer-multilingual-indo_aryan-gpu--t4";
const CONFORMER_MULTILINGUAL = "bhashini/ai4bharat/conformer-multilingual-asr";

const SERVICE_IDS: Record<string, string> = {
  hi: CONFORMER_HI,

  te: CONFORMER_DRAVIDIAN,
  ta: CONFORMER_DRAVIDIAN,
  kn: CONFORMER_DRAVIDIAN,
  ml: CONFORMER_DRAVIDIAN,

  bn: CONFORMER_INDO_ARYAN,
  mr: CONFORMER_INDO_ARYAN,
  ur: CONFORMER_INDO_ARYAN,
  or: CONFORMER_INDO_ARYAN,
  pa: CONFORMER_INDO_ARYAN,
  gu: CONFORMER_INDO_ARYAN,
  sa: CONFORMER_INDO_ARYAN,

  as: CONFORMER_MULTILINGUAL,
  ne: CONFORMER_MULTILINGUAL,
  mai: CONFORMER_MULTILINGUAL,
  ks: CONFORMER_MULTILINGUAL,
  kok: CONFORMER_MULTILINGUAL,
  doi: CONFORMER_MULTILINGUAL,
  mni: CONFORMER_MULTILINGUAL,
  brx: CONFORMER_MULTILINGUAL,
  sat: CONFORMER_MULTILINGUAL,
  sd: CONFORMER_MULTILINGUAL,
};

/**
 * English is deliberately absent. Bhashini's English model is a downgrade on
 * Whisper, and "en" is also the language of anyone who never picked one, so an
 * artisan speaking Marathi through the English UI is better served by Whisper
 * detecting that than by Bhashini being told "English" and believing it.
 */
export function serviceIdFor(languageCode: string): string | undefined {
  return SERVICE_IDS[languageCode];
}

export function bhashiniSupportsLanguage(languageCode: string): boolean {
  return languageCode in SERVICE_IDS;
}
