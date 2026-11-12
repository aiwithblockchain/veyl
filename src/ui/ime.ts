interface ComposingEventLike {
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * 输入法组合态判断：中文选词时按 Enter 是上屏，不是提交。
 * 接受 React 合成事件与原生事件：合成事件取 `nativeEvent`，原生事件自己就带这两个字段。
 * `keyCode === 229` 兜住不置 `isComposing` 的浏览器；`composingRef` 兜住事件不带组合标记的情况。
 */
export function isComposingEvent(
  event: ComposingEventLike & { nativeEvent?: ComposingEventLike },
  composingRefActive = false,
): boolean {
  if (composingRefActive) return true;
  const source = event.nativeEvent ?? event;
  return Boolean(source.isComposing) || source.keyCode === 229;
}
