import { describe, it, expect } from "vitest";
import { isAppLanguage } from "../../shared/languages";

describe("translate request validation", () => {
  it("accepts the languages the app offers", () => {
    for (const code of ["en", "hi", "ta", "brx", "sat"]) {
      expect(isAppLanguage(code)).toBe(true);
    }
  });

  it("rejects anything outside the registry", () => {
    for (const code of ["", "fr", "zz", "english"]) {
      expect(isAppLanguage(code)).toBe(false);
    }
  });
});
