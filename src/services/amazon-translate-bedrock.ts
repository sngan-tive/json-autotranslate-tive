import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { Translate } from '@aws-sdk/client-translate';
import fs from 'fs';
import { decode } from 'html-entities';

import {
  replaceInterpolations,
  reInsertInterpolations,
  Matcher,
} from '../matchers';

import {
  ServiceOptions,
  TranslationResult,
  TranslationService,
  TString,
} from '.';

const DEFAULT_BEDROCK_REGION = 'us-east-1';
const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MIN_REFINEMENT_LENGTH = 0;

const SYSTEM_PROMPT = `You are a professional translator and editor. You refine machine-translated text to improve naturalness, grammar, and tone while preserving the original meaning.

Rules:
1. Preserve all interpolation placeholders exactly as they appear (e.g., {{name}}, {count}, <0 />, %s, %d). Do not translate, modify, or reorder them.
2. Preserve all HTML tags and attributes exactly as they appear (e.g., <b>, <a href="...">, <br />, <span class="...">). Do not add, remove, or modify any HTML markup.
3. Keep translations concise and appropriate for UI text (buttons, labels, messages).
4. Fix grammar, spelling, and awkward phrasing from overly-literal machine translation.
5. Ensure the tone is professional and natural for the target language.
6. Do not add explanations or commentary.
7. Return ONLY a valid JSON array in the exact format specified.`;

const SUPPORTED_LANGUAGES: Record<string, string> = {
  af: 'af',
  sq: 'sq',
  am: 'am',
  ar: 'ar',
  hy: 'hy',
  az: 'az',
  bn: 'bn',
  bs: 'bs',
  bg: 'bg',
  ca: 'ca',
  zh: 'zh',
  'zh-tw': 'zh-TW',
  hr: 'hr',
  cs: 'cs',
  da: 'da',
  'fa-af': 'fa-AF',
  nl: 'nl',
  en: 'en',
  et: 'et',
  fa: 'fa',
  tl: 'tl',
  fi: 'fi',
  fr: 'fr',
  'fr-ca': 'fr-CA',
  ka: 'ka',
  de: 'de',
  el: 'el',
  gu: 'gu',
  ht: 'ht',
  ha: 'ha',
  he: 'he',
  hi: 'hi',
  hu: 'hu',
  is: 'is',
  id: 'id',
  ga: 'ga',
  it: 'it',
  ja: 'ja',
  kn: 'kn',
  kk: 'kk',
  ko: 'ko',
  lv: 'lv',
  lt: 'lt',
  mk: 'mk',
  ms: 'ms',
  ml: 'ml',
  mt: 'mt',
  mr: 'mr',
  mn: 'mn',
  no: 'no',
  ps: 'ps',
  pl: 'pl',
  pt: 'pt',
  'pt-pt': 'pt-PT',
  pa: 'pa',
  ro: 'ro',
  ru: 'ru',
  sr: 'sr',
  si: 'si',
  sk: 'sk',
  sl: 'sl',
  so: 'so',
  es: 'es',
  'es-mx': 'es-MX',
  sw: 'sw',
  sv: 'sv',
  ta: 'ta',
  te: 'te',
  th: 'th',
  tr: 'tr',
  uk: 'uk',
  ur: 'ur',
  uz: 'uz',
  vi: 'vi',
  cy: 'cy',
};

export class AmazonTranslateBedrock implements TranslationService {
  private translate: Translate;
  private bedrockClient: BedrockRuntimeClient;
  private interpolationMatcher: Matcher;
  private decodeEscapes: boolean;
  private modelId: string;
  private batchSize: number;
  private maxTokens: number;
  private minRefinementLength: number;

  name = 'Amazon Translate + Bedrock';

  async initialize(
    config?: string,
    interpolationMatcher?: Matcher,
    decodeEscapes?: boolean,
    options?: ServiceOptions,
  ) {
    // --config is optional: if provided, it configures the AWS Translate client
    const translateConfig = config
      ? JSON.parse(fs.readFileSync(config).toString())
      : {};
    this.translate = new Translate(translateConfig);

    // Bedrock settings come from CLI flags (with defaults)
    const bedrockRegion =
      (options?.bedrockRegion as string) ||
      translateConfig.region ||
      DEFAULT_BEDROCK_REGION;

    this.bedrockClient = new BedrockRuntimeClient({ region: bedrockRegion });
    this.modelId = (options?.bedrockModelId as string) || DEFAULT_MODEL_ID;
    this.batchSize = Number(options?.bedrockBatchSize) || DEFAULT_BATCH_SIZE;
    this.maxTokens = Number(options?.bedrockMaxTokens) || DEFAULT_MAX_TOKENS;
    this.minRefinementLength =
      Number(options?.bedrockMinLength) || DEFAULT_MIN_REFINEMENT_LENGTH;
    this.interpolationMatcher = interpolationMatcher;
    this.decodeEscapes = decodeEscapes;
  }

  supportsLanguage(language: string) {
    return Object.keys(SUPPORTED_LANGUAGES).includes(language.toLowerCase());
  }

  async translateStrings(
    strings: TString[],
    from: string,
    to: string,
    terminology: string,
  ): Promise<TranslationResult[]> {
    if (strings.length === 0) {
      return [];
    }

    // Phase 1: AWS Translate
    const translateResults = await Promise.all(
      strings.map(async ({ key, value }) => {
        const { clean, replacements } = replaceInterpolations(
          value,
          this.interpolationMatcher,
        );

        const translateTextConfig = {
          Text: clean,
          SourceLanguageCode: SUPPORTED_LANGUAGES[from.toLowerCase()],
          TargetLanguageCode: SUPPORTED_LANGUAGES[to.toLowerCase()],
          TerminologyNames: [] as string[],
        };

        if (terminology) {
          translateTextConfig.TerminologyNames.push(terminology);
        }

        const { TranslatedText } = await this.translate.translateText(
          translateTextConfig,
        );

        const reInserted = reInsertInterpolations(TranslatedText, replacements);

        return {
          key,
          value,
          translated: this.decodeEscapes ? decode(reInserted) : reInserted,
        };
      }),
    );

    // Phase 2: Bedrock Refinement (skip short strings)
    const toRefine: TranslationResult[] = [];
    const skipped: TranslationResult[] = [];

    for (const result of translateResults) {
      if (result.value.length < this.minRefinementLength) {
        skipped.push(result);
      } else {
        toRefine.push(result);
      }
    }

    if (skipped.length > 0) {
      console.log(
        `\n   Skipping Bedrock refinement for ${skipped.length} short string(s)`,
      );
    }

    const refined = await this.refineInBatches(toRefine, from, to);

    // Recombine in original order
    const refinedMap = new Map(refined.map((r) => [r.key, r]));
    const skippedMap = new Map(skipped.map((r) => [r.key, r]));

    return translateResults.map(
      (r) => refinedMap.get(r.key) || skippedMap.get(r.key),
    );
  }

  private async refineInBatches(
    results: TranslationResult[],
    from: string,
    to: string,
  ): Promise<TranslationResult[]> {
    const refined: TranslationResult[] = [];

    for (let i = 0; i < results.length; i += this.batchSize) {
      const chunk = results.slice(i, i + this.batchSize);
      const refinedChunk = await this.refineBatch(chunk, from, to);
      refined.push(...refinedChunk);
    }

    return refined;
  }

  private async refineBatch(
    results: TranslationResult[],
    from: string,
    to: string,
  ): Promise<TranslationResult[]> {
    try {
      const input = results.map((r) => ({
        key: r.key,
        source: r.value,
        translation: r.translated,
      }));

      const userPrompt = `Refine the following machine translations from ${from} to ${to}.

Input format: JSON array of objects with "key", "source", and "translation" fields.
Output format: JSON array of objects with "key" and "refined" fields, in the same order.

Input:
${JSON.stringify(input, null, 2)}

Return ONLY the JSON array, no markdown fences, no explanation.`;

      const command = new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: this.maxTokens,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      const response = await this.bedrockClient.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      const responseText: string = responseBody.content[0].text;

      const parsed = this.parseBedrockResponse(responseText);
      return this.mergeRefinedResults(results, parsed);
    } catch (error) {
      console.warn(
        `\n   ⚠️  Bedrock refinement failed, using unrefined translations: ${error.message}`,
      );
      return results;
    }
  }

  private parseBedrockResponse(
    text: string,
  ): Array<{ key: string; refined: string }> {
    let cleaned = text.trim();

    // Strip markdown code fences if present
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    return JSON.parse(cleaned);
  }

  private mergeRefinedResults(
    original: TranslationResult[],
    refined: Array<{ key: string; refined: string }>,
  ): TranslationResult[] {
    const refinedMap = new Map(refined.map((r) => [r.key, r.refined]));

    return original.map((result) => {
      const refinedValue = refinedMap.get(result.key);

      if (refinedValue === undefined) {
        return result;
      }

      if (!this.validatePlaceholders(result.value, refinedValue)) {
        console.warn(
          `\n   ⚠️  Placeholder corrupted for key "${result.key}", using unrefined translation`,
        );
        return result;
      }

      return { ...result, translated: refinedValue };
    });
  }

  private validatePlaceholders(
    sourceValue: string,
    refinedText: string,
  ): boolean {
    if (!this.interpolationMatcher) {
      return true;
    }

    const sourcePlaceholders = this.interpolationMatcher(
      sourceValue,
      (i) => `__PLACEHOLDER_${i}__`,
    );

    for (const { from } of sourcePlaceholders) {
      if (!refinedText.includes(from)) {
        return false;
      }
    }

    return true;
  }
}
