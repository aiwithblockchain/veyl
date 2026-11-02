/**
 * 监听器生命周期管理（对齐 TweetPilot 的 `createListenerManager` 实现方式）。
 *
 * 三个作用：
 * 1. 统一登记 `listen()` 返回的 handle，`dispose()` 一次性清干净；
 * 2. dispose 之后才返回的 listen 立即被取消，不会留下野监听；
 * 3. 重复 unlisten 的报错（Tauri 内部 `listeners[eventId].handlerId`）静默吞掉，
 *    这是它自己的已知噪声，不该让调用方处理。
 */

export type ListenerCleanup = () => void | Promise<void>;
export type ListenerHandle = ListenerCleanup | { unlisten?: ListenerCleanup } | null | undefined;

function resolveCleanup(handle: ListenerHandle): ListenerCleanup | null {
  if (typeof handle === "function") return handle;
  if (handle && typeof handle.unlisten === "function") return handle.unlisten.bind(handle);
  return null;
}

async function cleanupSafely(handle: ListenerHandle): Promise<void> {
  const cleanup = resolveCleanup(handle);
  if (!cleanup) return;

  try {
    await cleanup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("listeners[eventId].handlerId")) {
      // 只记结论，不打印 handle 内容。
      console.debug(`[bridge] unlisten failed: ${message}`);
    }
  }
}

export function createListenerManager() {
  let active = true;
  const handles = new Set<ListenerHandle>();

  const register = async (label: string, handle: ListenerHandle): Promise<ListenerHandle> => {
    if (!active) {
      await cleanupSafely(handle);
      return handle;
    }
    handles.add(handle);
    void label;
    return handle;
  };

  return {
    async listen(label: string, registration: Promise<ListenerHandle>): Promise<ListenerHandle> {
      return register(label, await registration);
    },
    dispose() {
      if (!active) return;
      active = false;
      for (const handle of handles) void cleanupSafely(handle);
      handles.clear();
    },
  };
}
