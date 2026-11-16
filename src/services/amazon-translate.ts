import { Translate } from '@aws-sdk/client-translate';
import fs from 'fs';
import { decode } from 'html-entities';

import {
  replaceInterpolations,
  reInsertInterpolations,
  Matcher,
} from '../matchers';

import { TranslationService, TString } from '.';

type TranslationResult = { key: string; value: string; translated: string };

// Limits parallel TranslateText calls to avoid ThrottlingException
const TRANSLATE_CONCURRENCY = 10;
const MAX_ATTEMPTS = 10;
// Log progress every N strings (plain lines, since CI logs don't render \r)
const PROGRESS_LOG_INTERVAL = 100;

export class AmazonTranslate implements TranslationService {
  private translate: Translate;
  private interpolationMatcher: Matcher;
  private supportedLanguages: object = {
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
  private decodeEscapes: boolean;

  name = 'Amazon Translate';

  async initialize(
    config?: string,
    interpolationMatcher?: Matcher,
    decodeEscapes?: boolean,
  ) {
    const configJson = config
      ? JSON.parse(fs.readFileSync(config).toString())
      : {};
    this.translate = new Translate({
      maxAttempts: MAX_ATTEMPTS,
      retryMode: 'adaptive',
      ...configJson,
    });

    this.interpolationMatcher = interpolationMatcher;
    this.decodeEscapes = decodeEscapes;
  }

  supportsLanguage(language: string) {
    return Object.keys(this.supportedLanguages).includes(
      language.toLowerCase(),
    );
  }

  async translateStrings(
    strings: TString[],
    from: string,
    to: string,
    terminology: string,
  ) {
    const results: TranslationResult[] = [];
    for (let i = 0; i < strings.length; i += TRANSLATE_CONCURRENCY) {
      const chunk = strings.slice(i, i + TRANSLATE_CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async ({ key, value }) => {
          const { clean, replacements } = replaceInterpolations(
            value,
            this.interpolationMatcher,
          );
          const translateTextConfig = {
            Text: clean,
            SourceLanguageCode: this.supportedLanguages[from.toLowerCase()],
            TargetLanguageCode: this.supportedLanguages[to.toLowerCase()],
            TerminologyNames: [],
          };

          if (terminology) {
            translateTextConfig.TerminologyNames.push(terminology);
          }

          const { TranslatedText } = await this.translate.translateText(
            translateTextConfig,
          );

          const reInsterted = reInsertInterpolations(
            TranslatedText,
            replacements,
          );

          return {
            key,
            value,
            translated: this.decodeEscapes ? decode(reInsterted) : reInsterted,
          };
        }),
      );
      results.push(...chunkResults);

      const done = results.length;
      if (
        done === strings.length ||
        Math.floor(done / PROGRESS_LOG_INTERVAL) >
          Math.floor((done - chunkResults.length) / PROGRESS_LOG_INTERVAL)
      ) {
        console.log(`   [Translate ${to}] ${done}/${strings.length} strings`);
      }
    }
    return results;
  }
}
