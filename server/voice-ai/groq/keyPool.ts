/**
 * Groq's free tier caps tokens per day, and that cap is shared by every key
 * belonging to the same Groq organisation. Extra keys therefore only add
 * headroom when they come from separate Groq accounts; keys minted inside one
 * account all draw down the same allowance and rotating between them buys
 * nothing.
 *
 * When a key does hit its cap, it is parked for a cooldown rather than
 * dropped, so a temporary per-minute limit and an exhausted daily allowance
 * both resolve on their own without a redeploy. The cooldown lives in memory,
 * so on Vercel it only spans a warm instance: the worst case is one wasted
 * probe per cold start, not a broken request.
 */

const DAILY_COOLDOWN_MS = 15 * 60 * 1000;
const SHORT_COOLDOWN_MS = 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

export interface GroqKeyEnv {
  GROQ_API_KEY?: string;
  GROQ_API_KEY_2?: string;
  GROQ_API_KEY_3?: string;
  GROQ_FALLBACK_API_KEYS?: string;
}

/**
 * Numbered slots and the comma-separated list are two spellings of the same
 * thing, both supported because one key per line is far easier to manage in a
 * .env file and in Vercel's environment UI, while a single list is easier to
 * paste around. They merge, in slot order, and duplicates are dropped.
 */
export function collectGroqApiKeys(env: GroqKeyEnv): string[] {
  const fallbacks = [env.GROQ_API_KEY_2, env.GROQ_API_KEY_3, env.GROQ_FALLBACK_API_KEYS]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(",");

  return parseGroqApiKeys(env.GROQ_API_KEY, fallbacks);
}

export function parseGroqApiKeys(primary: string | undefined, fallbacks: string | undefined): string[] {
  const raw = [primary ?? "", ...(fallbacks ?? "").split(",")];
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const entry of raw) {
    const key = entry.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  return keys;
}

export function isDailyQuotaMessage(detail: string): boolean {
  return /tokens per day|TPD|requests per day|RPD/i.test(detail);
}

export function retryAfterMsFromDetail(detail: string): number | undefined {
  const match = /try again in ([0-9.]+)(ms|s|m|h)?/i.exec(detail);
  if (!match) return undefined;

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;

  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 1000;
  return Math.min(MAX_COOLDOWN_MS, Math.ceil(value * multiplier) + 1500);
}

export function cooldownForDetail(detail: string): number {
  return retryAfterMsFromDetail(detail) ?? (isDailyQuotaMessage(detail) ? DAILY_COOLDOWN_MS : SHORT_COOLDOWN_MS);
}

function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export class GroqKeyPool {
  private readonly keys: string[];
  private readonly restingUntil = new Map<string, number>();

  constructor(keys: string[]) {
    this.keys = keys;
  }

  get size(): number {
    return this.keys.length;
  }

  /**
   * Keys that are not currently resting, in configured order, falling back to
   * every key when they are all resting. Never returning an empty list matters:
   * an expired cooldown we mis-timed should cost a failed attempt, not turn a
   * recoverable request into an instant failure.
   */
  usableKeys(now: number = Date.now()): string[] {
    const usable = this.keys.filter((key) => (this.restingUntil.get(key) ?? 0) <= now);
    return usable.length > 0 ? usable : this.keys;
  }

  rest(key: string, detail: string, now: number = Date.now()): void {
    const cooldown = cooldownForDetail(detail);
    this.restingUntil.set(key, now + cooldown);

    console.warn("[voice-ai] Groq key rate limited, resting it", {
      key: maskKey(key),
      forSeconds: Math.round(cooldown / 1000),
      dailyQuota: isDailyQuotaMessage(detail),
      remainingKeys: this.usableKeys(now).length,
    });
  }
}
