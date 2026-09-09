import { describe, it, expect } from "vitest";
import { isWrittenInOwnScript, isAppLanguage, getLanguage } from "./languages";

describe("isWrittenInOwnScript", () => {
  it("recognises each language written in its own script", () => {
    const cases: [string, string][] = [
      ["hi", "तीन दिन लगेंगे"],
      ["or", "ଏହା କେତେ ଦିନରେ ପହଞ୍ଚିବ"],
      ["te", "ఎంత సమయం పడుతుంది"],
      ["bn", "কত দিন লাগবে"],
      ["ta", "எவ்வளவு நாள் ஆகும்"],
      ["gu", "કેટલા દિવસ લાગશે"],
      ["kn", "ಎಷ್ಟು ದಿನ ಬೇಕು"],
      ["ml", "എത്ര ദിവസം എടുക്കും"],
      ["pa", "ਕਿੰਨੇ ਦਿਨ ਲੱਗਣਗੇ"],
      ["ur", "کتنے دن لگیں گے"],
      ["sat", "ᱛᱤᱱᱟᱜ ᱫᱤᱱ"],
      ["mni", "ꯀꯌꯥ ꯅꯨꯃꯤꯠ"],
      ["en", "How long will it take"],
    ];

    for (const [code, text] of cases) {
      expect(isWrittenInOwnScript(text, code), code).toBe(true);
    }
  });

  it("treats romanised text as not being in its own script, so it still gets offered a translation", () => {
    const cases: [string, string][] = [
      ["hi", "kitne din lagenge"],
      ["or", "kete dinare pahanchiba"],
      ["te", "entha samayam padutundi"],
      ["bn", "koto din lagbe"],
      ["ta", "evvalavu naal aagum"],
      ["mr", "kiti divas lagtil"],
      ["ur", "kitne din lagenge"],
    ];

    for (const [code, text] of cases) {
      expect(isWrittenInOwnScript(text, code), code).toBe(false);
    }
  });

  it("does not confuse languages that share a script", () => {
    expect(isWrittenInOwnScript("तीन दिन लगेंगे", "mr")).toBe(true);
    expect(isWrittenInOwnScript("তিন দিন", "as")).toBe(true);
    expect(isWrittenInOwnScript("তিন দিন", "or")).toBe(false);
    expect(isWrittenInOwnScript("तीन दिन", "gu")).toBe(false);
  });

  it("counts a message as being in its script when the script appears at all, so mixed text is not sent for translation", () => {
    expect(isWrittenInOwnScript("Delivery कितने दिन", "hi")).toBe(true);
  });

  it("has a usable script pattern for every language the app offers", () => {
    const sample = "abc";
    for (const code of ["en", "hi", "bn", "mr", "te", "ta", "gu", "ur", "kn", "ml", "pa", "as", "ne", "sa", "sd", "or", "mai", "ks", "kok", "doi", "mni", "brx", "sat"]) {
      expect(isAppLanguage(code), code).toBe(true);
      expect(getLanguage(code).script.length).toBeGreaterThan(0);
      expect(typeof isWrittenInOwnScript(sample, code)).toBe("boolean");
    }
  });
});
