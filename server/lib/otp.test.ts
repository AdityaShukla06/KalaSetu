import { describe, it, expect } from "vitest";
import {
  OTP_LENGTH,
  generateOtp,
  hashOtp,
  otpMatches,
  normaliseEmail,
} from "./otp";

describe("generateOtp", () => {
  it("always returns a code of the expected length", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOtp()).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`));
    }
  });

  it("keeps leading zeros rather than shortening the code", () => {
    const codes = Array.from({ length: 500 }, generateOtp);
    expect(codes.every((c) => c.length === OTP_LENGTH)).toBe(true);
  });

  it("does not return the same code every time", () => {
    const codes = new Set(Array.from({ length: 50 }, generateOtp));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("hashOtp", () => {
  it("never stores the code in the clear", () => {
    const hash = hashOtp("1234");
    expect(hash).not.toContain("1234");
    expect(hash).toHaveLength(64);
  });

  it("is deterministic for the same code", () => {
    expect(hashOtp("4321")).toBe(hashOtp("4321"));
  });

  it("differs for different codes", () => {
    expect(hashOtp("1111")).not.toBe(hashOtp("2222"));
  });
});

describe("otpMatches", () => {
  it("accepts the correct code", () => {
    expect(otpMatches("7391", hashOtp("7391"))).toBe(true);
  });

  it("rejects an incorrect code", () => {
    expect(otpMatches("7391", hashOtp("7392"))).toBe(false);
  });

  it("rejects a malformed stored hash without throwing", () => {
    expect(otpMatches("7391", "not-a-hash")).toBe(false);
  });
});

describe("normaliseEmail", () => {
  it("lowercases and trims so the same address is one account", () => {
    expect(normaliseEmail("  Artisan@Example.COM ")).toBe("artisan@example.com");
  });
});
