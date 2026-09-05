import { describe, it, expect } from "vitest";
import { normalizeWhatsAppNumber, isValidWhatsAppNumber, buildWhatsAppUrl } from "./whatsapp";

describe("normalizeWhatsAppNumber", () => {
  it("strips spaces, dashes, parentheses, and a leading plus", () => {
    expect(normalizeWhatsAppNumber("+91 98765-43210")).toBe("919876543210");
    expect(normalizeWhatsAppNumber("(987) 654-3210")).toBe("9876543210");
  });
});

describe("isValidWhatsAppNumber", () => {
  it("accepts a plausible Indian mobile number with country code", () => {
    expect(isValidWhatsAppNumber("+91 98765 43210")).toBe(true);
  });

  it("rejects something far too short to be a phone number", () => {
    expect(isValidWhatsAppNumber("12345")).toBe(false);
  });

  it("rejects something far too long", () => {
    expect(isValidWhatsAppNumber("1234567890123456")).toBe(false);
  });
});

describe("buildWhatsAppUrl", () => {
  it("builds a wa.me link with the number normalized and the message URL-encoded", () => {
    const url = buildWhatsAppUrl("+91 98765 43210", "Hi! Is this available?");
    expect(url).toBe("https://wa.me/919876543210?text=Hi!%20Is%20this%20available%3F");
  });

  it("never leaves formatting characters in the number portion of the URL", () => {
    const url = buildWhatsAppUrl("(987) 654-3210", "test");
    expect(url).toContain("wa.me/9876543210");
    expect(url).not.toMatch(/wa\.me\/[^0-9]/);
  });
});
