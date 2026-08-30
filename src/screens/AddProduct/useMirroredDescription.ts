import { useEffect, useRef, useState } from "react";
import { translateText } from "../../services/api";

const DEBOUNCE_MS = 1200;

export type SyncStatus = "idle" | "syncing" | "failed";

interface Options {
  language: string;
  descriptionEn: string;
  descriptionLocal: string;
  onChangeEn: (value: string) => void;
  onChangeLocal: (value: string) => void;
}

/**
 * Keeps the English and local descriptions in step.
 *
 * Whichever box the artisan last typed in is the source, and the other is
 * regenerated from it after they pause. Only the side they are not editing is
 * ever written to, and a reply that arrives after they have switched sides is
 * discarded, so typing is never overwritten underneath them.
 */
export function useMirroredDescription({
  language,
  descriptionEn,
  descriptionLocal,
  onChangeEn,
  onChangeLocal,
}: Options) {
  const [status, setStatus] = useState<SyncStatus>("idle");
  const source = useRef<"en" | "local" | null>(null);
  const lastTranslated = useRef<string | null>(null);
  const requestId = useRef(0);
  const sameLanguage = language === "en";

  function editEn(value: string) {
    source.current = "en";
    onChangeEn(value);
    if (sameLanguage) onChangeLocal(value);
  }

  function editLocal(value: string) {
    source.current = "local";
    onChangeLocal(value);
    if (sameLanguage) onChangeEn(value);
  }

  const from = source.current;
  const text = from === "en" ? descriptionEn : from === "local" ? descriptionLocal : "";

  useEffect(() => {
    if (sameLanguage || !from) return;

    const trimmed = text.trim();

    if (!trimmed) {
      lastTranslated.current = null;
      setStatus("idle");
      if (from === "en") onChangeLocal("");
      else onChangeEn("");
      return;
    }

    if (trimmed === lastTranslated.current) return;

    const timer = setTimeout(async () => {
      const id = ++requestId.current;
      const target = from === "en" ? language : "en";
      setStatus("syncing");

      try {
        const { translation } = await translateText(trimmed, from === "en" ? "en" : language, target);
        if (id !== requestId.current || source.current !== from) return;

        lastTranslated.current = trimmed;
        if (from === "en") onChangeLocal(translation);
        else onChangeEn(translation);
        setStatus("idle");
      } catch {
        if (id !== requestId.current) return;
        setStatus("failed");
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, from, language, sameLanguage]);

  return { status, editEn, editLocal, sameLanguage };
}
