import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnv, resetEnvCache } from "./env";

const REQUIRED = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  JWT_SECRET: "test-secret-that-is-long-enough",
  GROQ_API_KEY: "groq-key",
};

let original: NodeJS.ProcessEnv;

function setEnv(values: Record<string, string | undefined>) {
  process.env = { ...values } as NodeJS.ProcessEnv;
  resetEnvCache();
}

beforeEach(() => {
  original = { ...process.env };
});

afterEach(() => {
  process.env = original;
  resetEnvCache();
});

describe("loadEnv", () => {
  it("fails loudly and names every missing variable", () => {
    setEnv({});
    expect(() => loadEnv()).toThrow(/SUPABASE_URL/);
    setEnv({});
    expect(() => loadEnv()).toThrow(/JWT_SECRET/);
  });

  it("rejects a JWT secret that is too short to be safe", () => {
    setEnv({ ...REQUIRED, JWT_SECRET: "short" });
    expect(() => loadEnv()).toThrow(/JWT_SECRET/);
  });

  it("applies the documented defaults", () => {
    setEnv(REQUIRED);
    const env = loadEnv();

    expect(env.SUPABASE_STORAGE_BUCKET).toBe("product-images");
    expect(env.JWT_EXPIRES_IN).toBe("7d");
    expect(env.DEMO_FALLBACK_OTP).toBe("5741");
  });

  it("leaves the demo fallback enabled unless it is explicitly turned off", () => {
    setEnv(REQUIRED);
    expect(loadEnv().DEMO_FALLBACK_OTP_ENABLED).toBe(true);

    setEnv({ ...REQUIRED, DEMO_FALLBACK_OTP_ENABLED: "false" });
    expect(loadEnv().DEMO_FALLBACK_OTP_ENABLED).toBe(false);

    setEnv({ ...REQUIRED, DEMO_FALLBACK_OTP_ENABLED: "FALSE" });
    expect(loadEnv().DEMO_FALLBACK_OTP_ENABLED).toBe(false);
  });

  it("allows the demo fallback code to be changed", () => {
    setEnv({ ...REQUIRED, DEMO_FALLBACK_OTP: "9999" });
    expect(loadEnv().DEMO_FALLBACK_OTP).toBe("9999");
  });

  it("treats a key left blank in .env exactly like an unset key", () => {
    setEnv({
      ...REQUIRED,
      SUPABASE_STORAGE_BUCKET: "",
      OTP_FROM_EMAIL: "",
    });
    const env = loadEnv();

    expect(env.SUPABASE_STORAGE_BUCKET).toBe("product-images");
    expect(env.OTP_FROM_EMAIL).toContain("@");
  });

  it("reports a blank required key as missing rather than accepting it", () => {
    setEnv({ ...REQUIRED, GROQ_API_KEY: "" });
    expect(() => loadEnv()).toThrow(/GROQ_API_KEY/);
  });

  it("defaults to the groq provider and requires its key", () => {
    setEnv(REQUIRED);
    expect(loadEnv().VOICE_AI_PROVIDER).toBe("groq");
  });

  it("requires the gemini key only when the provider is gemini", () => {
    const { GROQ_API_KEY, ...withoutGroq } = REQUIRED;
    setEnv({ ...withoutGroq, VOICE_AI_PROVIDER: "gemini", GEMINI_API_KEY: "gemini-key" });
    expect(loadEnv().VOICE_AI_PROVIDER).toBe("gemini");

    setEnv({ ...withoutGroq, VOICE_AI_PROVIDER: "gemini" });
    expect(() => loadEnv()).toThrow(/GEMINI_API_KEY/);
  });

  it("rejects an unknown provider", () => {
    setEnv({ ...REQUIRED, VOICE_AI_PROVIDER: "openai" });
    expect(() => loadEnv()).toThrow(/VOICE_AI_PROVIDER/);
  });
});
