import { describe, it, expect, vi } from "vitest";
import { classifyWithChain } from "./chain";
import { CraftClassification, CraftClassifierService } from "../types/classification.types";

class FakeClassifier implements CraftClassifierService {
  constructor(
    readonly source: CraftClassification["source"],
    private readonly result: CraftClassification | Error,
  ) {}

  async classify(): Promise<CraftClassification> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe("classifyWithChain", () => {
  it("returns the first tier's result without trying the rest", async () => {
    const gemini = new FakeClassifier("gemini", { category: "pottery", confidence: "high", source: "gemini" });
    const groq = new FakeClassifier("groq", { category: "textiles", confidence: "high", source: "groq" });
    const classifySpy = vi.spyOn(groq, "classify");

    const result = await classifyWithChain([gemini, groq], Buffer.from("x"), "image/jpeg");

    expect(result).toEqual({ category: "pottery", confidence: "high", source: "gemini" });
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it("falls through to the next tier when one fails", async () => {
    const gemini = new FakeClassifier("gemini", new Error("gemini is down"));
    const render = new FakeClassifier("render", { category: "jewelry", confidence: "medium", source: "render" });

    const result = await classifyWithChain([gemini, render], Buffer.from("x"), "image/jpeg");

    expect(result).toEqual({ category: "jewelry", confidence: "medium", source: "render" });
  });

  it("returns null when every tier fails", async () => {
    const gemini = new FakeClassifier("gemini", new Error("gemini is down"));
    const groq = new FakeClassifier("groq", new Error("groq is down"));

    const result = await classifyWithChain([gemini, groq], Buffer.from("x"), "image/jpeg");

    expect(result).toBeNull();
  });

  it("returns null immediately for an empty chain", async () => {
    const result = await classifyWithChain([], Buffer.from("x"), "image/jpeg");
    expect(result).toBeNull();
  });
});
