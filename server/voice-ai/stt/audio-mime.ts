import { InvalidAudioError } from "../errors/voice-ai.errors";

const ALIASES: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/m4a",
  "audio/mp4": "audio/m4a",
  "audio/vorbis": "audio/ogg",
};

const EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/aiff": "aiff",
};

export function normaliseAudioMimeType(mimeType: string, supported: readonly string[]): string {
  const bare = (mimeType || "").split(";")[0].trim().toLowerCase();
  const aliased = ALIASES[bare] ?? bare;

  if (supported.includes(aliased)) {
    return aliased;
  }

  throw new InvalidAudioError(
    `Audio format "${bare || "unknown"}" is not supported for transcription`,
  );
}

export function extensionForAudio(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? "wav";
}
