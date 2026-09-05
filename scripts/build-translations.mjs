import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const OUT_DIR = "shared/locales";
const MODEL = process.env.GROQ_LLM_MODEL || "openai/gpt-oss-120b";
const BATCH = 12;
const PACE_MS = 9000;

const API_KEYS = [
  process.env.GROQ_API_KEY ?? "",
  process.env.GROQ_API_KEY_2 ?? "",
  process.env.GROQ_API_KEY_3 ?? "",
  ...(process.env.GROQ_FALLBACK_API_KEYS ?? "").split(","),
]
  .map((key) => key.trim())
  .filter((key, index, all) => key && all.indexOf(key) === index);

if (API_KEYS.length === 0) {
  console.error("GROQ_API_KEY is required to regenerate translations.");
  process.exit(1);
}

const exhaustedKeys = new Set();

const languagesSource = execFileSync(
  process.execPath,
  ["--experimental-strip-types", "-e", "import('./shared/languages.ts').then(m=>console.log(JSON.stringify(m.APP_LANGUAGES)))"],
  { encoding: "utf8" },
);
const LANGUAGES = JSON.parse(languagesSource.trim());

const english = JSON.parse(readFileSync(`${OUT_DIR}/en.json`, "utf8"));
const keys = Object.keys(english);

mkdirSync(OUT_DIR, { recursive: true });

async function translateBatch(target, entries) {
  const prompt = `You are localising the interface of KalaSetu, a mobile app that helps Indian artisans list handmade products for sale.

Translate each value from English into ${target.englishName} (${target.nativeName}), written in the ${target.script} script.

Rules:
1. Return every key exactly as given. Do not add, drop, or rename keys.
2. Translate only the values.
3. Keep placeholders like {n} exactly as they appear.
4. Keep the product name "KalaSetu" untranslated.
5. These are buttons, labels and short messages in a phone app. Keep them short and natural, the way a real app would say it, not a literal word for word rendering.
6. Use everyday language an artisan would understand, not formal or technical vocabulary.

Respond with a JSON object mapping every given key to its ${target.englishName} translation, and nothing else.

${JSON.stringify(entries, null, 2)}`;

  let lastError;

  for (const apiKey of API_KEYS) {
    if (exhaustedKeys.has(apiKey)) continue;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (response.ok) {
      const payload = await response.json();
      return JSON.parse(payload.choices[0].message.content);
    }

    const detail = await response.text();
    lastError = new Error(`Groq returned ${response.status}: ${detail.slice(0, 200)}`);
    lastError.status = response.status;
    const wait = /try again in ([0-9.]+)s/i.exec(detail);
    lastError.retryAfterMs = wait ? Math.ceil(parseFloat(wait[1]) * 1000) + 1500 : undefined;

    if (response.status !== 429) throw lastError;

    if (/tokens per day|TPD|requests per day|RPD/i.test(detail)) {
      exhaustedKeys.add(apiKey);
      const left = API_KEYS.length - exhaustedKeys.size;
      process.stdout.write(left > 0 ? `[key ${exhaustedKeys.size} spent, switching]` : "");
      continue;
    }

    throw lastError;
  }

  throw lastError ?? new Error("No usable Groq API key");
}

const only = process.argv.slice(2);

for (const language of LANGUAGES) {
  if (language.code === "en") continue;
  if (only.length > 0 && !only.includes(language.code)) continue;

  const outPath = `${OUT_DIR}/${language.code}.json`;
  const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
  const missing = keys.filter((key) => !existing[key]);

  if (missing.length === 0) {
    console.log(`${language.code.padEnd(4)} up to date`);
    continue;
  }

  process.stdout.write(`${language.code.padEnd(4)} ${language.englishName}: ${missing.length} keys `);
  const result = { ...existing };

  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH);
    const entries = Object.fromEntries(slice.map((key) => [key, english[key]]));

    let translated;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        translated = await translateBatch(language, entries);
        break;
      } catch (err) {
        if (attempt === 8) throw err;
        const wait = err.retryAfterMs ?? Math.min(60000, 5000 * attempt);
        process.stdout.write(err.status === 429 ? "~" : "!");
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    for (const key of slice) {
      result[key] = typeof translated[key] === "string" && translated[key].trim() ? translated[key] : english[key];
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  const ordered = Object.fromEntries(keys.map((key) => [key, result[key] ?? english[key]]));
  writeFileSync(outPath, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  console.log(" done");
}

writeIndex();
console.log("translations written to", OUT_DIR);

function writeIndex() {
  const codes = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))
    .sort();

  const lines = [
    "/* Generated by scripts/build-translations.mjs. Do not edit by hand. */",
    ...codes.map((c) => 'import ' + c + ' from "./' + c + '.json";'),
    "",
    "export type Dictionary = Record<string, string>;",
    "",
    "export const DICTIONARIES: Record<string, Dictionary> = {",
    ...codes.map((c) => '  "' + c + '": ' + c + ","),
    "};",
    "",
  ];

  writeFileSync(OUT_DIR + "/index.ts", lines.join(String.fromCharCode(10)));
}
