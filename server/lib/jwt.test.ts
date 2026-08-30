import { describe, it, expect, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { signSessionToken, verifySessionToken } from "./jwt";
import { resetEnvCache } from "./env";

const BASE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  JWT_SECRET: "test-secret-that-is-long-enough",
  GROQ_API_KEY: "groq-key",
};

let original: NodeJS.ProcessEnv;

beforeEach(() => {
  original = { ...process.env };
  Object.assign(process.env, BASE_ENV);
  resetEnvCache();
});

afterEach(() => {
  process.env = original;
  resetEnvCache();
});

describe("session tokens", () => {
  it("round trips the user id and email", () => {
    const token = signSessionToken({ sub: "user-1", email: "artisan@example.com" });
    expect(verifySessionToken(token)).toMatchObject({
      sub: "user-1",
      email: "artisan@example.com",
    });
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign({ sub: "user-1", email: "a@b.com" }, "some-other-secret");
    expect(() => verifySessionToken(forged)).toThrow();
  });

  it("rejects a tampered token", () => {
    const token = signSessionToken({ sub: "user-1", email: "artisan@example.com" });
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "user-2", email: "attacker@example.com" }),
    ).toString("base64url");

    expect(() => verifySessionToken(`${header}.${forgedPayload}.${signature}`)).toThrow();
  });

  it("rejects an expired token", () => {
    const expired = jwt.sign(
      { sub: "user-1", email: "a@b.com" },
      BASE_ENV.JWT_SECRET,
      { expiresIn: -10 },
    );
    expect(() => verifySessionToken(expired)).toThrow();
  });

  it("rejects a well signed token that is missing an email", () => {
    const noEmail = jwt.sign({ sub: "user-1" }, BASE_ENV.JWT_SECRET);
    expect(() => verifySessionToken(noEmail)).toThrow(/email/);
  });

  it("rejects garbage", () => {
    expect(() => verifySessionToken("not.a.token")).toThrow();
  });
});
