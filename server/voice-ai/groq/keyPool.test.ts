import { describe, it, expect, vi, afterEach } from "vitest";
import {
  GroqKeyPool,
  parseGroqApiKeys,
  isDailyQuotaMessage,
  retryAfterMsFromDetail,
  cooldownForDetail,
} from "./keyPool";
import { groqChat, GroqRateLimitError } from "./chat";

const DAILY_QUOTA_BODY =
  '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_abc` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199453"}}';

const PER_MINUTE_BODY =
  '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM). Please try again in 4.2s"}}';

function completion(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

function rateLimited(body: string) {
  return { ok: false, status: 429, text: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseGroqApiKeys", () => {
  it("keeps the primary key first and appends the fallbacks in order", () => {
    expect(parseGroqApiKeys("gsk_primary", "gsk_two, gsk_three")).toEqual([
      "gsk_primary",
      "gsk_two",
      "gsk_three",
    ]);
  });

  it("drops blanks, whitespace and duplicates", () => {
    expect(parseGroqApiKeys("gsk_one", " , gsk_two ,, gsk_one , ")).toEqual(["gsk_one", "gsk_two"]);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(parseGroqApiKeys(undefined, undefined)).toEqual([]);
    expect(parseGroqApiKeys("", "  ")).toEqual([]);
  });

  it("works with only fallback keys set", () => {
    expect(parseGroqApiKeys(undefined, "gsk_two")).toEqual(["gsk_two"]);
  });
});

describe("rate limit detail parsing", () => {
  it("recognises a daily quota message", () => {
    expect(isDailyQuotaMessage(DAILY_QUOTA_BODY)).toBe(true);
    expect(isDailyQuotaMessage(PER_MINUTE_BODY)).toBe(false);
  });

  it("reads the provider's own retry hint when it gives one", () => {
    expect(retryAfterMsFromDetail(PER_MINUTE_BODY)).toBe(4200 + 1500);
    expect(retryAfterMsFromDetail(DAILY_QUOTA_BODY)).toBeUndefined();
  });

  it("rests a daily-quota key for far longer than a per-minute one", () => {
    expect(cooldownForDetail(DAILY_QUOTA_BODY)).toBeGreaterThan(cooldownForDetail(PER_MINUTE_BODY));
  });

  it("never rests a key for longer than an hour", () => {
    expect(cooldownForDetail("try again in 90m")).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

describe("GroqKeyPool", () => {
  it("skips a resting key but brings it back once the cooldown passes", () => {
    const pool = new GroqKeyPool(["a", "b"]);
    const now = 1_000_000;

    pool.rest("a", DAILY_QUOTA_BODY, now);
    expect(pool.usableKeys(now)).toEqual(["b"]);
    expect(pool.usableKeys(now + 16 * 60 * 1000)).toEqual(["a", "b"]);
  });

  it("falls back to every key rather than none when all are resting", () => {
    const pool = new GroqKeyPool(["a", "b"]);
    const now = 1_000_000;

    pool.rest("a", DAILY_QUOTA_BODY, now);
    pool.rest("b", DAILY_QUOTA_BODY, now);

    expect(pool.usableKeys(now)).toEqual(["a", "b"]);
  });
});

describe("groqChat key rotation", () => {
  it("moves to the next key when the first one is out of daily quota", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited(DAILY_QUOTA_BODY))
      .mockResolvedValueOnce(rateLimited(DAILY_QUOTA_BODY))
      .mockResolvedValueOnce(completion('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const pool = new GroqKeyPool(["gsk_spent", "gsk_fresh"]);
    const out = await groqChat({
      keyPool: pool,
      model: "primary",
      fallbackModel: "secondary",
      json: true,
      prompt: "hello",
    });

    expect(out).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer gsk_spent");
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer gsk_fresh");
  });

  it("tries both models on a key before spending the next one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited(DAILY_QUOTA_BODY))
      .mockResolvedValueOnce(completion('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    await groqChat({
      keyPool: new GroqKeyPool(["gsk_one", "gsk_two"]),
      model: "primary",
      fallbackModel: "secondary",
      json: true,
      prompt: "hello",
    });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("secondary");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer gsk_one");
  });

  it("gives up with the rate limit error once every key is spent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rateLimited(DAILY_QUOTA_BODY)));

    await expect(
      groqChat({
        keyPool: new GroqKeyPool(["a", "b"]),
        model: "primary",
        json: true,
        prompt: "hello",
      }),
    ).rejects.toBeInstanceOf(GroqRateLimitError);
  });

  it("does not burn other keys on an error that is not a rate limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      groqChat({
        keyPool: new GroqKeyPool(["a", "b", "c"]),
        model: "primary",
        json: true,
        prompt: "hello",
      }),
    ).rejects.toThrow(/500/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips a key already known to be spent on the next call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited(DAILY_QUOTA_BODY))
      .mockResolvedValue(completion('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const pool = new GroqKeyPool(["gsk_spent", "gsk_fresh"]);
    const options = { keyPool: pool, model: "primary", json: true, prompt: "hello" };

    await groqChat(options);
    fetchMock.mockClear();
    await groqChat(options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer gsk_fresh");
  });
});
