/** 复制到剪贴板；navigator.clipboard 不可用时退回 textarea。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的 textarea 方案。
  }
  let el: HTMLTextAreaElement | null = null;
  try {
    el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // 文本里可能含令牌：失败也必须在 finally 里清空并移除，不能留在文档里。
    if (el) {
      el.value = "";
      el.remove();
    }
  }
}
