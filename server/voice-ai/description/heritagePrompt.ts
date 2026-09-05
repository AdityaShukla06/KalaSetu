import { HeritageStoryInput } from "../types/voice-ai.types";

function field(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "(not provided, omit this from the story)";
}

export function buildHeritagePrompt(input: HeritageStoryInput): string {
  return `You are writing the "Product Story" section of a Craft Heritage Passport: a public, self-declared provenance certificate for a handmade product on an Indian artisan marketplace (KalaSetu). This is NOT a marketing page. It is closer to a museum object label: warm, factual, precise.

You will be given some of the fields below. Any field marked "(not provided, omit this from the story)" was not given by the artisan, at all, in any form.

category: ${input.category}
material: ${field(input.material)}
technique: ${field(input.technique)}
timeTaken: ${field(input.timeTaken)}
giTag: ${field(input.giTag)}
description: """${input.descriptionEn}"""

Your task: write ONE short story, 100 to 150 words, about this specific product: how it was made, from what, using what technique, how long it took, and the meaning of any motif or design the artisan mentioned in the description. Cover only what is actually present below.

STRICT RULES, follow every one of these without exception:
1. Use ONLY information explicitly present in the fields and description above. Do not add, infer, or assume anything that is not there.
2. Do NOT invent regional history, cultural traditions, heritage claims, or symbolism, EVEN IF the category, material, or region name would typically be associated with a known craft tradition. If the artisan did not state it, in these fields or in the description, it does not appear in the story, no matter how likely it seems.
3. If a field above is marked "(not provided, omit this from the story)", omit that part of the story entirely. Do not write a placeholder like "using traditional methods" or "a technique passed down through generations" to paper over a missing field.
4. Do not claim, imply, or reference any government verification, official certification, or third-party authentication. This is a self-declared record made by the artisan, not a certified one.
5. No superlatives or sales language: no "finest", "exquisite", "premium", "world-renowned", "must-have". Write like a museum placard, not an advertisement.
6. Third person, plain English prose, about the product and how it was made. Do not mention the artisan speaking, a transcript, translation, or AI.
7. Target 100 to 150 words.

Respond with a JSON object of the form {"story": "..."}.`;
}
