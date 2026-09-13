import { describe, expect, it } from 'vitest';
import {
  isValidCodexCustomModel,
  isValidModelPricing,
  PROVIDER_PRESETS,
  validateCodexCustomModels,
} from './provider';

describe('PROVIDER_PRESETS', () => {
  it('uses the current DeepSeek Anthropic-compatible defaults', () => {
    const deepseek = PROVIDER_PRESETS.find(provider => provider.id === 'deepseek');

    expect(deepseek?.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    });
  });

  it('uses the current Xiaomi MiMo model for all Claude model slots', () => {
    const xiaomi = PROVIDER_PRESETS.find(provider => provider.id === 'xiaomi');

    expect(xiaomi?.env).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    });
  });
});

describe('custom model pricing validation', () => {
  it('accepts optional non-negative per-million-token pricing fields', () => {
    expect(isValidModelPricing({
      inputCostPer1M: 1.25,
      outputCostPer1M: 3,
      cacheWriteCostPer1M: 0,
      cacheReadCostPer1M: 0.1,
    })).toBe(true);

    expect(isValidCodexCustomModel({
      id: 'vendor/custom-model',
      label: 'Custom Model',
      pricing: {
        inputCostPer1M: 0.2,
        outputCostPer1M: 0.8,
      },
    })).toBe(true);
  });

  it('rejects invalid custom pricing values', () => {
    expect(isValidModelPricing({ inputCostPer1M: -1 })).toBe(false);
    expect(isValidModelPricing({ outputCostPer1M: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isValidModelPricing({ cacheReadCostPer1M: '0.1' })).toBe(false);

    expect(validateCodexCustomModels([
      { id: 'valid-model', label: 'Valid', pricing: { inputCostPer1M: 0.1 } },
      { id: 'invalid-model', label: 'Invalid', pricing: { outputCostPer1M: -2 } },
    ])).toEqual([
      { id: 'valid-model', label: 'Valid', pricing: { inputCostPer1M: 0.1 } },
    ]);
  });
});
