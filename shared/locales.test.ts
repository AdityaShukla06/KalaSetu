import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_LANGUAGES } from "./languages";

const DIR = "src/context/locales";

function read(file: string): Record<string, string> {
  return JSON.parse(readFileSync(join(DIR, file), "utf8"));
}

const files: string[] = readdirSync(DIR).filter((f: string) => f.endsWith(".json"));
const english = read("en.json");
const englishKeys = Object.keys(english).sort();

describe("locales", () => {
  it("has an English source dictionary", () => {
    expect(englishKeys.length).toBeGreaterThan(50);
  });

  it("only contains files for languages the app offers", () => {
    const known = new Set(APP_LANGUAGES.map((l) => l.code));
    for (const file of files) {
      expect(known.has(file.replace(".json", ""))).toBe(true);
    }
  });

  it.each(files)("%s has exactly the English key set", (file: string) => {
    const dictionary = read(file);
    expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
  });

  it.each(files)("%s has no empty values", (file: string) => {
    const dictionary = read(file);
    const empty = Object.entries(dictionary)
      .filter(([, value]) => typeof value !== "string" || value.trim() === "")
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it.each(files)("%s preserves the {n} placeholder where English uses it", (file: string) => {
    const dictionary = read(file);
    for (const key of englishKeys) {
      if (english[key].includes("{n}")) {
        expect(dictionary[key]).toContain("{n}");
      }
    }
  });
});
