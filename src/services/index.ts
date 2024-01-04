import { Matcher } from '../matchers';

import { AmazonTranslate } from './amazon-translate';
import { AzureTranslator } from './azure-translator';
import { DeepL } from './deepl';
import { DryRun } from './dry-run';
import { GoogleTranslate } from './google-translate';
import { ManualTranslation } from './manual';

export interface TranslationResult {
  key: string;
  value: string;
  translated: string;
}

export interface TString {
  key: string;
  value: string;
}
export interface TranslationService {
  name: string;
  initialize: (
    config?: string,
    interpolationMatcher?: Matcher,
    decodeEscapes?: boolean,
  ) => Promise<void>;
  supportsLanguage: (language: string) => boolean;
  translateStrings: (
    strings: TString[],
    from: string,
    to: string,
  ) => Promise<TranslationResult[]>;
}

export const serviceMap: {
  [k: string]: TranslationService;
} = {
  'google-translate': new GoogleTranslate(),
  deepl: new DeepL(false),
  'deepl-free': new DeepL(true),
  'dry-run': new DryRun(),
  azure: new AzureTranslator(),
  manual: new ManualTranslation(),
  'amazon-translate': new AmazonTranslate(),
};
