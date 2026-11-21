import { describe, expect, it } from "vitest";

import { handleDownload } from "../src/dl";

const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const UA_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120";
const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

function get(path: string, ua?: string, method = "GET") {
  const headers: Record<string, string> = {};
  if (ua) headers["user-agent"] = ua;
  return new Request(`https://veyl.dessage.xyz${path}`, { method, headers });
}

describe("GET /dl/:client", () => {
  it("iPhone 去 App Store，Android 直接下安装包，电脑落到 release 页", () => {
    const ios = handleDownload(get("/dl/hiddify", UA_IPHONE));
    const android = handleDownload(get("/dl/hiddify", UA_ANDROID));
    const desktop = handleDownload(get("/dl/hiddify", UA_DESKTOP));

    for (const response of [ios, android, desktop]) {
      expect(response?.status).toBe(302);
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
    expect(ios?.headers.get("location")).toBe(
      "https://apps.apple.com/us/app/hiddify-proxy-vpn/id6596777532",
    );
    expect(android?.headers.get("location")).toBe(
      "https://github.com/hiddify/hiddify-app/releases/latest/download/Hiddify-Android-universal.apk",
    );
    expect(desktop?.headers.get("location")).toBe(
      "https://github.com/hiddify/hiddify-app/releases/latest",
    );
  });

  it("iPad 与 iPod 同样按 iOS 处理；没有 UA 时退回 release 页", () => {
    expect(
      handleDownload(get("/dl/hiddify", "Mozilla/5.0 (iPad; CPU OS 18_0)"))?.headers.get(
        "location",
      ),
    ).toContain("apps.apple.com");
    expect(
      handleDownload(get("/dl/hiddify", "Mozilla/5.0 (iPod touch)"))?.headers.get(
        "location",
      ),
    ).toContain("apps.apple.com");
    expect(handleDownload(get("/dl/hiddify"))?.headers.get("location")).toContain(
      "/releases/latest",
    );
  });

  it("未知客户端 404，不猜一个默认客户端", () => {
    expect(handleDownload(get("/dl/unknown", UA_IPHONE))?.status).toBe(404);
  });

  it("不在 /dl 下的路径不接管，交给后面的路由", () => {
    expect(handleDownload(get("/rules/geosite-cn.srs"))).toBeNull();
    expect(handleDownload(get("/dl/hiddify/extra"))).toBeNull();
    expect(handleDownload(get("/dl/hiddify", UA_IPHONE, "POST"))).toBeNull();
  });

  it("HEAD 与 GET 一致", () => {
    expect(handleDownload(get("/dl/hiddify", UA_IPHONE, "HEAD"))?.status).toBe(302);
  });
});
