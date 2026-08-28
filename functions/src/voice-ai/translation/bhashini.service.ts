import { TranslationService, SupportedLanguageCode } from "../types/voice-ai.types";
import { TranslationFailedError, MalformedModelResponseError } from "../errors/voice-ai.errors";

/**
 * Real BHASHINI (ULCA) translation adapter.
 *
 * BHASHINI credentials are NOT available at the time this was written. What
 * follows is built ONLY from what is publicly verifiable about the ULCA API
 * shape (Bhashini's own GitBook docs + the reference client patterns they
 * publish), specifically:
 *
 *   - Base URL:      https://meity-auth.ulcacontrib.org
 *   - Config call:    POST /ulca/apis/v0/model/getModelsPipeline
 *     Headers:        { userID, ulcaApiKey }
 *     Body:           { pipelineTasks: [{ taskType, config: { language: {...} } }],
 *                        pipelineRequestConfig: { pipelineId } }
 *   - Compute call:   the config call's response returns the actual inference
 *     endpoint URL + an authorization header value + a serviceId to use for
 *     the compute call. That response shape is NOT hardcoded here because it
 *     is only fully knowable once we can make a real call with real
 *     credentials and inspect it — inventing field names for it would
 *     violate the "never invent request/response fields" requirement.
 *
 * WHAT'S REAL vs. WHAT'S A PLACEHOLDER, explicitly:
 *   REAL (from public docs): base URL, config-call path, header names,
 *   config-call body shape, and the two-call (config → compute) flow itself.
 *   PLACEHOLDER (isolated in one place, `runComputeCall`): the exact shape
 *   of the compute-call request/response. This is intentionally left as a
 *   single clearly-marked TODO rather than guessed at, per project
 *   requirements. Do not fill this in without the actual ULCA response in
 *   front of you.
 *
 * Until Phase 2 (real credentials + a verified compute-call shape), use
 * MockTranslationService instead — see pipeline/factory.ts, which picks
 * between the two automatically based on whether BHASHINI env vars are set.
 */
export class BhashiniTranslationService implements TranslationService {
  private static readonly ULCA_BASE_URL = "https://meity-auth.ulcacontrib.org";
  private static readonly MODEL_PIPELINE_ENDPOINT = "/ulca/apis/v0/model/getModelsPipeline";

  constructor(
    private readonly credentials: {
      userId: string;
      apiKey: string;
      pipelineId: string;
    },
  ) {}

  async translate(
    text: string,
    sourceLanguage: SupportedLanguageCode,
    targetLanguage: SupportedLanguageCode,
  ): Promise<string> {
    if (sourceLanguage === targetLanguage) return text;

    try {
      const pipelineConfig = await this.fetchPipelineConfig(sourceLanguage, targetLanguage);
      return await this.runComputeCall(pipelineConfig, text, sourceLanguage, targetLanguage);
    } catch (err) {
      if (err instanceof MalformedModelResponseError) throw err;
      throw new TranslationFailedError(
        `BHASHINI translation failed (${sourceLanguage} -> ${targetLanguage})`,
        err,
      );
    }
  }

  /**
   * Verified real call: gets the pipeline's model/service config for the
   * requested language pair. This part of the shape is directly documented.
   */
  private async fetchPipelineConfig(
    sourceLanguage: SupportedLanguageCode,
    targetLanguage: SupportedLanguageCode,
  ): Promise<unknown> {
    const response = await fetch(`${BhashiniTranslationService.ULCA_BASE_URL}${BhashiniTranslationService.MODEL_PIPELINE_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        userID: this.credentials.userId,
        ulcaApiKey: this.credentials.apiKey,
      },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType: "translation",
            config: {
              language: {
                sourceLanguage,
                targetLanguage,
              },
            },
          },
        ],
        pipelineRequestConfig: {
          pipelineId: this.credentials.pipelineId,
        },
      }),
    });

    if (!response.ok) {
      throw new TranslationFailedError(`Pipeline config call failed with status ${response.status}`);
    }

    return response.json();
  }

  /**
   * TODO (Phase 2, blocked on BHASHINI credentials):
   *
   * The pipeline-config response above includes a callback/compute URL and
   * an authorization token for the actual inference call, plus a
   * `serviceId` identifying which model to invoke for this task. The exact
   * field names for that response, and for the compute-call request/response
   * bodies, are NOT filled in here because they cannot be verified without
   * live credentials — see bhashini.gitbook.io/bhashini-apis, "Pipeline
   * Compute Call" page, once access is available.
   *
   * Implement this method to:
   *   1. Extract the compute endpoint URL + auth header + serviceId from
   *      `pipelineConfig` (real field names, once observed).
   *   2. POST the text to that endpoint with the correct request shape.
   *   3. Extract the translated string from the correct response field.
   *
   * Until then, this throws so that misconfigured deployments fail loudly
   * instead of silently returning untranslated text.
   */
  private async runComputeCall(
    _pipelineConfig: unknown,
    _text: string,
    _sourceLanguage: SupportedLanguageCode,
    _targetLanguage: SupportedLanguageCode,
  ): Promise<string> {
    throw new TranslationFailedError(
      "BHASHINI compute-call integration is not yet implemented — this is blocked on real ULCA " +
        "credentials so the exact request/response shape can be verified. Use MockTranslationService " +
        "until Phase 2. See the TODO on BhashiniTranslationService.runComputeCall.",
    );
  }
}
