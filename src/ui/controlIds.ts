import type { UiContext, UiControl, UiLastAction, UiScreen } from "../agent/bridge";
import { t } from "../i18n";
import type { MessageKey } from "../i18n";

/**
 * 静态控件登记表（commands.md §9.1.1）。
 * 这是 UI 与系统提示词共用的唯一来源：只允许这里的 id，或当前 action_card 的按钮 id。
 */
interface StaticControl {
  id: string;
  screen: UiScreen;
  kind: UiControl["kind"];
  label: MessageKey;
}

const STATIC_CONTROLS: StaticControl[] = [
  { id: "onboarding.connect", screen: "onboarding", kind: "button", label: "controls.connect" },
  {
    id: "onboarding.other_provider",
    screen: "onboarding",
    kind: "button",
    label: "controls.otherProvider",
  },
  {
    id: "onboarding.get_key",
    screen: "onboarding",
    kind: "button",
    label: "controls.getKey",
  },

  { id: "client.primary", screen: "client", kind: "button", label: "controls.connect" },
  { id: "client.node_pick", screen: "client", kind: "choice", label: "controls.nodePick" },
  { id: "client.probe", screen: "client", kind: "button", label: "controls.probe" },
  { id: "client.ask_ai", screen: "client", kind: "button", label: "controls.assistant" },

  { id: "no_nodes.trial", screen: "no_nodes", kind: "button", label: "controls.trial" },
  { id: "no_nodes.new_node", screen: "no_nodes", kind: "button", label: "controls.newNode" },

  { id: "new_node.region", screen: "new_node", kind: "choice", label: "controls.region" },
  { id: "new_node.plan", screen: "new_node", kind: "choice", label: "controls.plan" },
  { id: "new_node.create", screen: "new_node", kind: "button", label: "controls.create" },

  { id: "servers.item", screen: "servers", kind: "row", label: "controls.server" },
  { id: "servers.destroy", screen: "servers", kind: "button", label: "controls.destroy" },
  { id: "servers.ai_locate", screen: "servers", kind: "button", label: "controls.aiLocate" },

  {
    id: "trial_expired.new_node",
    screen: "trial_expired",
    kind: "button",
    label: "controls.newNode",
  },

  { id: "settings.ai", screen: "settings", kind: "button", label: "controls.ai" },
  {
    id: "settings.connection",
    screen: "settings",
    kind: "button",
    label: "settings.tab.connection",
  },
  {
    id: "settings.advanced",
    screen: "settings",
    kind: "button",
    label: "controls.advanced",
  },
];

const KNOWN_IDS = new Set(STATIC_CONTROLS.map((item) => item.id));

export function isKnownControlId(id: string): boolean {
  return KNOWN_IDS.has(id);
}

/** 当前屏幕的静态控件；labels 覆盖界面上实际显示的文案。 */
export function staticControlsFor(
  screen: UiScreen,
  labels: Record<string, string> = {},
): UiControl[] {
  return STATIC_CONTROLS.filter((item) => item.screen === screen).map((item) => ({
    id: item.id,
    label: normalizeLabel(labels[item.id] ?? t(item.label)) ?? t(item.label),
    kind: item.kind,
  }));
}

function normalizeLabel(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  return text.length > 24 ? text.slice(0, 24) : text;
}

function sanitizeValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * 组装这一轮的界面状态：静态控件 + 当前 action_card 的按钮；
 * last_action 必须落在同一份 controls 里，否则按 null 处理。
 */
export function buildUiContext(input: {
  screen: UiScreen;
  labels?: Record<string, string>;
  actionControls?: UiControl[];
  lastAction?: UiLastAction | null;
  /** 当前屏幕里暂时不可点/不渲染的静态控件（例如测速中）。 */
  omitControls?: readonly string[];
}): UiContext {
  const omitted = new Set(input.omitControls ?? []);
  const seen = new Set<string>();
  const controls: UiControl[] = [];
  for (const control of [
    ...staticControlsFor(input.screen, input.labels),
    ...(input.actionControls ?? []),
  ]) {
    if (seen.has(control.id) || omitted.has(control.id)) continue;
    const label = normalizeLabel(control.label);
    if (!label) continue;
    seen.add(control.id);
    controls.push({ id: control.id, label, kind: control.kind });
    if (controls.length >= 20) break;
  }

  let lastAction: UiLastAction | null = null;
  const wanted = input.lastAction;
  if (wanted && seen.has(wanted.id)) {
    const value = sanitizeValue(wanted.value);
    lastAction = value ? { id: wanted.id, value } : { id: wanted.id };
  }
  return { screen: input.screen, controls, last_action: lastAction };
}
