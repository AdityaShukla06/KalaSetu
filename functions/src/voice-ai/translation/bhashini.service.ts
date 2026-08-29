import { z } from "zod";
import { TranslationService, SupportedLanguageCode } from "../types/voice-ai.types";
import { TranslationFailedError, MalformedModelResponseError } from "../errors/voice-ai.errors";

const PipelineConfigSchema = z.object({
  pipelineResponseConfig: z
    .array(
      z.object({
        taskType: z.string(),
        config: z
          .array(
            z.object({
              serviceId: z.string(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  pipelineInferenceAPIEndPoint: z.object({
    callbackUrl: z.string().url(),
    inferenceApiKey: z.object({
      name: z.string(),
      value: z.string(),
    }),
  }),
});

const ComputeResponseSchema = z.object({
  pipelineResponse: z
    .array(
      z.object({
        taskType: z.string(),
        output: z
          .array(
            z.object({
              target: z.string(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

interface ResolvedPipeline {
  serviceId: string;
  callbackUrl: string;
  authHeaderName: string;
  authHeaderValue: string;
}

export class BhashiniTranslationService implements TranslationService {
  private static readonly ULCA_BASE_URL = "https://meity-auth.ulcacontrib.org";
  private static readonly MODEL_PIPELINE_ENDPOINT = "/ulca/apis/v0/model/getModelsPipeline";
  private static readonly TASK_TYPE = "translation";

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
    if (sourceLanguage === targetLanguage || !text || text.trim().length === 0) {
      return text;
    }

    try {
      const pipeline = await this.fetchPipelineConfig(sourceLanguage, targetLanguage);
      return await this.runComputeCall(pipeline, text, sourceLanguage, targetLanguage);
    } catch (err) {
      if (err instanceof MalformedModelResponseError) throw err;
      if (err instanceof TranslationFailedError) throw err;
      throw new TranslationFailedError(
        `BHASHINI translation failed (${sourceLanguage} -> ${targetLanguage})`,
        err,
      );
    }
  }

  private async fetchPipelineConfig(
    sourceLanguage: SupportedLanguageCode,
    targetLanguage: SupportedLanguageCode,
  ): Promise<ResolvedPipeline> {
    const url = `${BhashiniTranslationService.ULCA_BASE_URL}${BhashiniTranslationService.MODEL_PIPELINE_ENDPOINT}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        userID: this.credentials.userId,
        ulcaApiKey: this.credentials.apiKey,
      },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType: BhashiniTranslationService.TASK_TYPE,
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
      throw new TranslationFailedError(
        `BHASHINI pipeline config call failed with status ${response.status}`,
      );
    }

    const parsed = PipelineConfigSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new MalformedModelResponseError(
        "translation",
        `BHASHINI pipeline config response did not match the expected shape: ${formatIssues(parsed.error)}`,
      );
    }

    const translationTask = parsed.data.pipelineResponseConfig.find(
      (entry) => entry.taskType === BhashiniTranslationService.TASK_TYPE,
    );
    if (!translationTask) {
      throw new MalformedModelResponseError(
        "translation",
        "BHASHINI pipeline config contained no translation task",
      );
    }

    const endpoint = parsed.data.pipelineInferenceAPIEndPoint;
    return {
      serviceId: translationTask.config[0].serviceId,
      callbackUrl: endpoint.callbackUrl,
      authHeaderName: endpoint.inferenceApiKey.name,
      authHeaderValue: endpoint.inferenceApiKey.value,
    };
  }

  private async runComputeCall(
    pipeline: ResolvedPipeline,
    text: string,
    sourceLanguage: SupportedLanguageCode,
    targetLanguage: SupportedLanguageCode,
  ): Promise<string> {
    const response = await fetch(pipeline.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [pipeline.authHeaderName]: pipeline.authHeaderValue,
      },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType: BhashiniTranslationService.TASK_TYPE,
            config: {
              language: {
                sourceLanguage,
                targetLanguage,
              },
              serviceId: pipeline.serviceId,
            },
          },
        ],
        inputData: {
          input: [{ source: text }],
        },
      }),
    });

    if (!response.ok) {
      throw new TranslationFailedError(
        `BHASHINI compute call failed with status ${response.status}`,
      );
    }

    const parsed = ComputeResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new MalformedModelResponseError(
        "translation",
        `BHASHINI compute response did not match the expected shape: ${formatIssues(parsed.error)}`,
      );
    }

    const translationTask = parsed.data.pipelineResponse.find(
      (entry) => entry.taskType === BhashiniTranslationService.TASK_TYPE,
    );
    if (!translationTask) {
      throw new MalformedModelResponseError(
        "translation",
        "BHASHINI compute response contained no translation task",
      );
    }

    const translated = translationTask.output[0].target.trim();
    if (!translated) {
      throw new TranslationFailedError(
        `BHASHINI returned an empty translation (${sourceLanguage} -> ${targetLanguage})`,
      );
    }

    return translated;
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}
