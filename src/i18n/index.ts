import { useSyncExternalStore } from "react";
import { en } from "./en";
import { zh } from "./zh";
import type { MessageKey } from "./zh";

export type { MessageKey };
export type Language = "zh" | "en";

/**
 * 界面语言的外部 store。
 * 启动时由 initLanguage() 从 Rust 的 app_language_get 读入；设置里写成功后再同步一次。
 */
let current: Language = "zh";
/** 每次 setLanguage 递增：晚到的启动读取不能覆盖用户刚做的切换。 */
let epoch = 0;
const listeners = new Set<() => void>();
const warned = new Set<string>();

function applyDocumentLanguage(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = current === "en" ? "en" : "zh-CN";
}

applyDocumentLanguage();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(next: Language): void {
  epoch += 1;
  if (next === current) {
    applyDocumentLanguage();
    return;
  }
  current = next;
  applyDocumentLanguage();
  for (const listener of listeners) listener();
}

export function getLanguageEpoch(): number {
  return epoch;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 同一个 key 只提醒一次，避免长列表刷屏。 */
function warnMissing(key: string): void {
  const tag = `${current}:${key}`;
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`i18n missing key=${key} lang=${current}`);
}

function interpolate(
  text: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name)
      ? String(vars[name])
      : whole,
  );
}

export function translate(
  language: Language,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const dict: Partial<Record<MessageKey, string>> = language === "en" ? en : zh;
  const text = dict[key];
  if (text !== undefined) return interpolate(text, vars);

  // 英文缺 key：不把 key 露给用户，回退中文并记一行日志。
  warnMissing(key);
  const fallback = (zh as Partial<Record<MessageKey, string>>)[key];
  return fallback === undefined ? "" : interpolate(fallback, vars);
}

/** 组件外（事件处理、纯函数）直接用 t()；需要跟随切换重绘的组件用 useT()。 */
export function t(
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  return translate(current, key, vars);
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

export function useT(): (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string {
  const language = useLanguage();
  return (key, vars) => translate(language, key, vars);
}
