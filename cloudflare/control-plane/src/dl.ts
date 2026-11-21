/**
 * 客户端下载分流（公开只读）：手机扫同一个码，按设备去各自的安装入口。
 *
 * 单一客户端在两个平台上的入口本来就不同——iPhone 只有 App Store，Android 只有安装包。
 * 一个二维码要同时服务两边，就不能把其中一边的地址写死进码里。
 *
 * 只做 302，不托管任何安装包：目标全部是官方地址，供应链和责任边界不变。
 */

interface DownloadTargets {
  ios: string;
  android: string;
  /** 电脑上打开或不认识的 UA：落到一个两边都能挑的页面。 */
  other: string;
}

const TARGETS: Record<string, DownloadTargets> = {
  hiddify: {
    ios: "https://apps.apple.com/us/app/hiddify-proxy-vpn/id6596777532",
    android:
      "https://github.com/hiddify/hiddify-app/releases/latest/download/Hiddify-Android-universal.apk",
    other: "https://github.com/hiddify/hiddify-app/releases/latest",
  },
};

export function handleDownload(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const match = /^\/dl\/([a-z0-9-]+)$/.exec(new URL(request.url).pathname);
  if (!match) return null;

  const targets = TARGETS[match[1]];
  if (!targets) {
    return new Response("未知的客户端", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const agent = request.headers.get("user-agent") ?? "";
  const location = /iPhone|iPad|iPod/i.test(agent)
    ? targets.ios
    : /Android/i.test(agent)
      ? targets.android
      : targets.other;

  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
