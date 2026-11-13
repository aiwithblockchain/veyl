import type { StorageLike } from "./panelPreference";

export type Destination = "client" | "servers";

export const DESTINATION_KEY = "veyl.ui.destination";
export const DESTINATION_VERSION_KEY = "veyl.ui.destinationVersion";
/** 界面改版版本：变化后旧记录作废，回到默认的客户端。 */
export const DESTINATION_VERSION = "servers-1";

function parse(value: string | null): Destination | null {
  return value === "client" || value === "servers" ? value : null;
}

/** 启动落点：没有记录、记录损坏、版本不符时一律回客户端。 */
export function readDestination(storage: StorageLike): Destination {
  try {
    if (storage.getItem(DESTINATION_VERSION_KEY) !== DESTINATION_VERSION) {
      return "client";
    }
    return parse(storage.getItem(DESTINATION_KEY)) ?? "client";
  } catch {
    return "client";
  }
}

/** 只记「上次在看哪」，不记忆页面栈里的二级页。 */
export function writeDestination(storage: StorageLike, value: Destination): void {
  try {
    storage.setItem(DESTINATION_KEY, value);
    storage.setItem(DESTINATION_VERSION_KEY, DESTINATION_VERSION);
  } catch {
    // 存不了就只在本次会话里记住。
  }
}
