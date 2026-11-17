import type { UiControl } from "../agent/bridge";

export interface ActionCardAction {
  id: string;
  label: string;
  kind: "primary" | "secondary";
}

export interface ActionCard {
  id: string;
  title: string;
  detail: string | null;
  actions: ActionCardAction[];
}

const ID_PATTERN = /^[a-z0-9_-]{1,32}$/;
/** 模型不许写价格 / IP / 端口 / 版本号 / 地区名；命中就整张卡不渲染。 */
const FORBIDDEN = /(\d{1,3}\.){3}\d{1,3}|[¥$€]\s?\d|端口|v?\d+\.\d+|东京|新加坡|纽约|法兰克福|伦敦|悉尼|多伦多|旧金山|阿姆斯特丹/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  if (FORBIDDEN.test(trimmed)) return null;
  return trimmed;
}

function readAction(raw: unknown): ActionCardAction | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) return null;
  const label = text(value.label, 12);
  if (!label) return null;
  if (value.kind !== "primary" && value.kind !== "secondary") return null;
  return { id: value.id, label, kind: value.kind };
}

function readCard(raw: unknown): ActionCard | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) return null;
  const title = text(value.title, 40);
  if (!title) return null;
  let detail: string | null = null;
  if (value.detail !== undefined && value.detail !== null) {
    if (typeof value.detail !== "string") return null;
    const trimmed = value.detail.trim();
    if (trimmed.length > 120 || FORBIDDEN.test(trimmed)) return null;
    detail = trimmed || null;
  }
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 3) {
    return null;
  }
  const actions: ActionCardAction[] = [];
  const ids = new Set<string>();
  for (const item of value.actions) {
    const action = readAction(item);
    if (!action || ids.has(action.id)) return null;
    ids.add(action.id);
    actions.push(action);
  }
  return { id: value.id, title, detail, actions };
}

/**
 * 从布局里取 action_card。非法块只跳过这一张，不抛错、不影响其他块。
 * 布局本身可能来自旧版本或模型笔误，渲染层只做结构校验。
 */
export function readActionCards(layout: unknown): ActionCard[] {
  if (!layout || typeof layout !== "object") return [];
  const blocks = (layout as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return [];
  const cards: ActionCard[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const entry = block as { type?: unknown; props?: unknown };
    if (entry.type !== "action_card") continue;
    const card = readCard(entry.props);
    if (card) cards.push(card);
  }
  return cards;
}

/** action_card 的按钮也可以出现在 context.controls 里。 */
export function actionCardControls(cards: ActionCard[]): UiControl[] {
  return cards.flatMap((card) =>
    card.actions.map((action) => ({
      id: action.id,
      label: action.label,
      kind: "button" as const,
    })),
  );
}
