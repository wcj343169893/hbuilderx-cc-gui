import i18n from 'i18next';
import type { BackendModule, ReadCallback } from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './locales/zh.json';
import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';
import { fetchWebviewJsonAsset } from '../utils/webviewAssets';

/**
 * 语言包按需加载。
 *
 * 10 份语言包全量内联进单文件产物要 754KB，而用户只会用其中一份。这里只内置
 * 中文（默认）、繁体中文与英文（fallback），其余语言运行时经资源通道取
 * `locale-<lng>.json`（见 utils/webviewAssets.ts）。
 *
 * 取不到时 i18next 自动回落到 fallbackLng（英文），不会白屏。
 */
const BUNDLED_RESOURCES = {
  zh: { translation: zh }, // Simplified Chinese
  'zh-TW': { translation: zhTW }, // Traditional Chinese
  en: { translation: en }, // English
} as const;

/** 未内置、需要按需加载的语言（与 webview/scripts/emit-locale-chunks.mjs 保持一致） */
export const LAZY_LANGUAGES = ['hi', 'es', 'fr', 'ja', 'ru', 'ko', 'pt-BR'] as const;

// Retrieve the saved language from localStorage; default to Simplified Chinese if not set
const getInitialLanguage = (): string => {
  const savedLanguage = localStorage.getItem('language');
  return savedLanguage || 'zh'; // Default to Simplified Chinese
};

/**
 * i18next 后端：只负责内置语言之外的按需加载。
 * 走宿主资源通道而不是 http，因为 webview 文档没有基准 URL，fetch 相对路径取不到东西。
 */
const webviewAssetBackend: BackendModule = {
  type: 'backend',
  init: () => undefined,
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    if (!(LAZY_LANGUAGES as readonly string[]).includes(language)) {
      // 内置语言不该走到这里；真走到了就当作无资源，交给 fallbackLng
      callback(null, {});
      return;
    }
    fetchWebviewJsonAsset<Record<string, unknown>>(`locale-${language}.json`)
      .then((data) => {
        if (data) {
          callback(null, data);
        } else {
          // 取不到（宿主未实现/文件缺失/超时）：报错让 i18next 回落到 fallbackLng
          callback(new Error(`locale asset unavailable: ${language}`), false);
        }
      })
      .catch((error) => callback(error as Error, false));
  },
};

i18n
  .use(webviewAssetBackend)
  .use(initReactI18next) // Integrate i18n with React
  .init({
    resources: BUNDLED_RESOURCES,
    // 已有内置资源的同时仍允许后端补齐缺失语言
    partialBundledLanguages: true,
    lng: getInitialLanguage(), // Initial language
    fallbackLng: 'en', // Fallback to English when a translation is missing
    interpolation: {
      escapeValue: false, // React already handles XSS protection
    },
  });

export default i18n;
