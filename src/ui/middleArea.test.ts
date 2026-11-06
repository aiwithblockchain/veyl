import { describe, expect, it, vi } from "vitest";
import type {
  ConfigDetail,
  HealthSnapshot,
  Layout,
  RuntimeView,
} from "../agent/protocol";
import { CONTRACT_VERSION } from "../agent/protocol";
import { emptyRuntimeView } from "../agent/bridge";
import {
  degradedReason,
  emptyHintText,
  failureHeadline,
  failureReason,
  failureSteps,
  isDisconnectFailure,
  isProxyUser,
  middleBlocks,
  middleLevel,
  resolveLayoutBlocks,
} from "./middleArea";

const HEALTHY: HealthSnapshot = {
  contract_version: CONTRACT_VERSION,
  process: true,
  clash_api: true,
  data_plane: true,
  exit_ip: "203.0.113.9",
  consecutive_failures: 0,
  checked_at: "2026-11-05T10:00:00Z",
};

function makeConfig(over: Partial<ConfigDetail> = {}): ConfigDetail {
  return {
    config_id: "cfg-1",
    name: "测试配置",
    connect_mode: "system_proxy",
    routing_mode: "direct",
    node_count: 2,
    listen_port: 2080,
    is_active: true,
    current_node_id: "n1",
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes: [
      {
        node_id: "n1",
        name: "节点一",
        server: "a.example.com",
        port: 8388,
        method: "aes-256-gcm",
        protocol: "shadowsocks",
        source: "seed",
        created_at: 0,
      },
      {
        node_id: "n2",
        name: "节点二",
        server: "b.example.com",
        port: 8389,
        method: "aes-256-gcm",
        protocol: "shadowsocks",
        source: "seed",
        created_at: 0,
      },
    ],
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
    layout_revision: null,
    ...over,
  } as ConfigDetail;
}

function makeRuntime(over: Partial<RuntimeView> = {}): RuntimeView {
  return { ...emptyRuntimeView(), health: { ...HEALTHY }, ...over };
}

function withCode(code: string, over: Partial<RuntimeView> = {}): RuntimeView {
  return makeRuntime({
    state: "failed",
    last_error: {
      contract_version: CONTRACT_VERSION,
      code: code as never,
      message: "upstream exploded at line 3",
      retryable: false,
      details: null,
      request_id: "r1",
    },
    ...over,
  });
}

describe("middleLevel", () => {
  it("把七种 runtime.state 归并成三态加过渡态", () => {
    expect(middleLevel("idle")).toBe("idle");
    expect(middleLevel("running")).toBe("running");
    expect(middleLevel("degraded")).toBe("degraded");
    expect(middleLevel("failed")).toBe("failed");
    expect(middleLevel("starting")).toBe("transition");
    expect(middleLevel("restarting")).toBe("transition");
    expect(middleLevel("stopping")).toBe("transition");
  });

  it("未知状态按过渡态处理，不乱说话", () => {
    expect(middleLevel("reconnecting" as never)).toBe("transition");
  });
});

describe("isProxyUser", () => {
  it("只有本机代理 + 指定服务走节点才算代理用户", () => {
    expect(isProxyUser(makeConfig({ routing_mode: "proxy_selected" }))).toBe(true);
    expect(isProxyUser(makeConfig({ routing_mode: "proxy_all" }))).toBe(false);
    expect(
      isProxyUser(makeConfig({ connect_mode: "tun", routing_mode: "proxy_selected" })),
    ).toBe(false);
  });
});

describe("emptyHintText", () => {
  it("未连接按接管方式与直连范围分三句", () => {
    expect(emptyHintText(makeConfig({ connect_mode: "tun" }), false)).toBe(
      "点上面的「启动 VPN」，所有软件都会自动走节点。",
    );
    expect(emptyHintText(makeConfig({ routing_mode: "proxy_all" }), false)).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。所有流量都会从节点出去。",
    );
    expect(emptyHintText(makeConfig({ routing_mode: "direct" }), false)).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。",
    );
  });

  it("已连接按接管方式分两句", () => {
    expect(emptyHintText(makeConfig({ connect_mode: "tun" }), true)).toBe(
      "所有软件现在都能用了。",
    );
    expect(emptyHintText(makeConfig(), true)).toBe("浏览器现在能用了。");
  });

  it("没有节点时覆盖未连接与已连接", () => {
    const empty = makeConfig({ nodes: [], node_count: 0 });
    expect(emptyHintText(empty, false)).toBe("这套配置还没有节点。");
    expect(emptyHintText(empty, true)).toBe("这套配置还没有节点。");
  });
});

describe("failureReason 九级判定", () => {
  it("1 权限被拒", () => {
    expect(failureReason(withCode("PERMISSION_DENIED"))).toBe(
      "系统没有允许 Veyl 接管网络。",
    );
  });

  it("2 端口被占用", () => {
    expect(failureReason(withCode("RUNTIME_PORT_UNAVAILABLE"))).toBe(
      "本机用来做代理的端口被别的软件占用了。",
    );
  });

  it("3 节点没响应", () => {
    for (const code of [
      "RUNTIME_START_TIMEOUT",
      "RUNTIME_HEALTH_FAILED",
      "RUNTIME_CRASH_LOOP",
      "RUNTIME_EXITED",
      "TIMEOUT",
    ]) {
      expect(failureReason(withCode(code))).toBe("节点一直没有响应。");
    }
  });

  it("4 配置被拒绝", () => {
    for (const code of [
      "RUNTIME_CONFIG_INVALID",
      "INVALID_ARGUMENT",
      "PRECONDITION_FAILED",
      "UNSUPPORTED",
    ]) {
      expect(failureReason(withCode(code))).toBe("这套配置没法用，启动被拒绝了。");
    }
  });

  it("5 节点服务不可用", () => {
    for (const code of ["UPSTREAM_ERROR", "RATE_LIMITED"]) {
      expect(failureReason(withCode(code))).toBe("节点服务暂时不可用。");
    }
  });

  it("6 组件没起来", () => {
    expect(
      failureReason(makeRuntime({ health: { ...HEALTHY, process: false } })),
    ).toBe("Veyl 的网络组件没有启动起来。");
  });

  it("7 控制接口没响应", () => {
    expect(
      failureReason(
        makeRuntime({ health: { ...HEALTHY, clash_api: false } }),
      ),
    ).toBe("网络组件在，但控制接口没有响应。");
  });

  it("8 流量没出去", () => {
    expect(
      failureReason(
        makeRuntime({ health: { ...HEALTHY, data_plane: false } }),
      ),
    ).toBe("已经连上节点，但流量没有真正出去。");
  });

  it("8b exit_ip 为 null 不再单独算流量没出去", () => {
    // 进终态时后端会清空 exit_ip，拿它判断会把「从来没连上」误判成「连上了没流量」。
    expect(
      failureReason(makeRuntime({ health: { ...HEALTHY, exit_ip: null } })),
    ).toBe("具体原因还没确认。");
  });

  it("9 兜底", () => {
    expect(failureReason(makeRuntime())).toBe("具体原因还没确认。");
  });

  it("last_error.code 优先于健康字段", () => {
    expect(
      failureReason(withCode("PERMISSION_DENIED", { health: { ...HEALTHY, process: false } })),
    ).toBe("系统没有允许 Veyl 接管网络。");
  });

  it("不展示 message 原文", () => {
    expect(failureReason(withCode("PERMISSION_DENIED"))).not.toContain("exploded");
  });
});

describe("failureSteps", () => {
  it("两个及以上节点：重连 → 换节点 → 助手定位", () => {
    const steps = failureSteps(makeConfig(), true);
    expect(steps.map((step) => step.label)).toEqual(["重新连接", "换一个节点", "让助手定位"]);
    expect(steps[0].detail).toBe("先点上面的「重新连接」。");
  });

  it("单节点且 AI 可用：跳过换节点", () => {
    const steps = failureSteps(makeConfig({ nodes: [makeConfig().nodes[0]] }), true);
    expect(steps.map((step) => step.label)).toEqual(["重新连接", "让助手定位"]);
  });

  it("单节点且没有 AI：指到新建配置", () => {
    const steps = failureSteps(makeConfig({ nodes: [] }), false);
    expect(steps.map((step) => step.label)).toEqual(["重新连接", "新建一套配置"]);
  });
});

describe("degradedReason", () => {
  it("流量没出去优先", () => {
    expect(
      degradedReason(
        makeRuntime({
          state: "degraded",
          health: { ...HEALTHY, data_plane: false, consecutive_failures: 3 },
        }),
      ),
    ).toBe("流量没有真正出去。");
  });

  it("有连续失败", () => {
    expect(
      degradedReason(
        makeRuntime({ state: "degraded", health: { ...HEALTHY, consecutive_failures: 2 } }),
      ),
    ).toBe("最近的网络检查没有通过。");
  });

  it("兜底", () => {
    expect(degradedReason(makeRuntime({ state: "degraded" }))).toBe(
      "网络检查没有通过。",
    );
  });
});

describe("isDisconnectFailure", () => {
  it("只有 running / degraded 掉到 failed 算连接断了", () => {
    expect(isDisconnectFailure("running", "failed")).toBe(true);
    expect(isDisconnectFailure("degraded", "failed")).toBe(true);
    expect(isDisconnectFailure("starting", "failed")).toBe(false);
    expect(isDisconnectFailure("idle", "failed")).toBe(false);
  });

  it("不是失败的迁移一律复位", () => {
    expect(isDisconnectFailure("running", "idle")).toBe(false);
    expect(isDisconnectFailure("failed", "idle")).toBe(false);
    expect(isDisconnectFailure("running", "stopping")).toBe(false);
  });
});

describe("failureHeadline", () => {
  it("连接断了 vs 从来没有连上", () => {
    expect(failureHeadline(true)).toBe("连接断了。");
    expect(failureHeadline(false)).toBe("没有连上节点。");
  });
});

describe("middleBlocks 块矩阵", () => {
  it("过渡态不渲染任何块", () => {
    expect(middleBlocks(makeRuntime({ state: "starting" }), makeConfig(), true)).toEqual([]);
    expect(middleBlocks(makeRuntime({ state: "restarting" }), makeConfig(), true)).toEqual([]);
    expect(middleBlocks(makeRuntime({ state: "stopping" }), makeConfig(), true)).toEqual([]);
  });

  it("失败卡排第一，失败时不给代理卡", () => {
    const blocks = middleBlocks(
      withCode("RUNTIME_PORT_UNAVAILABLE"),
      makeConfig({ routing_mode: "proxy_selected" }),
      true,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "issue_card",
      tone: "failed",
    });
  });

  it("从已连接态掉下来时标题由 failureHeadline 决定", () => {
    const blocks = middleBlocks(withCode("RUNTIME_EXITED"), makeConfig(), true);
    expect(blocks[0]).toMatchObject({ kind: "issue_card" });
    expect(failureHeadline(true)).toBe("连接断了。");
  });

  it("没连上过就失败：步骤完整，next 为空", () => {
    const blocks = middleBlocks(withCode("RUNTIME_EXITED"), makeConfig(), true);
    expect(blocks[0]).toMatchObject({
      kind: "issue_card",
      next: null,
    });
    expect((blocks[0] as { steps: unknown[] }).steps).toHaveLength(3);
    expect(failureHeadline(false)).toBe("没有连上节点。");
  });

  it("降级：非代理用户只有一张卡", () => {
    const blocks = middleBlocks(makeRuntime({ state: "degraded" }), makeConfig(), true);
    expect(blocks.map((b) => b.kind)).toEqual(["issue_card"]);
  });

  it("降级：代理用户先卡后代理", () => {
    const blocks = middleBlocks(
      makeRuntime({ state: "degraded", mixed_port: 7890 }),
      makeConfig({ routing_mode: "proxy_selected" }),
      true,
    );
    expect(blocks.map((b) => b.kind)).toEqual(["issue_card", "proxy_card"]);
  });

  it("未连接的代理用户只给预计地址，没有 actual", () => {
    const blocks = middleBlocks(
      makeRuntime(),
      makeConfig({ routing_mode: "proxy_selected", listen_port: 7890 }),
      true,
    );
    expect(blocks[0]).toMatchObject({
      kind: "proxy_card",
      connected: false,
      address: "127.0.0.1:7890",
    });
  });

  it("已连接的代理用户用 runtime.mixed_port，配置端口不参与", () => {
    const blocks = middleBlocks(
      makeRuntime({ state: "running", mixed_port: 7891 }),
      makeConfig({ routing_mode: "proxy_selected", listen_port: 7890 }),
      true,
    );
    expect(blocks[0]).toMatchObject({
      kind: "proxy_card",
      connected: true,
      address: "127.0.0.1:7891",
    });
  });

  it("已连接但 mixed_port 还没到：给确认中，不回退配置端口", () => {
    const blocks = middleBlocks(
      makeRuntime({ state: "running", mixed_port: null }),
      makeConfig({ routing_mode: "proxy_selected", listen_port: 7890 }),
      true,
    );
    expect(blocks[0]).toMatchObject({ kind: "proxy_card", address: null });
  });

  it("老后端缺 listen_port：不给地址，不能拼出 undefined", () => {
    const blocks = middleBlocks(
      makeRuntime(),
      makeConfig({
        routing_mode: "proxy_selected",
        listen_port: undefined as unknown as number,
      }),
      true,
    );
    expect(blocks[0]).toMatchObject({ kind: "proxy_card", address: null });
  });
});

function layoutOf(blocks: Layout["blocks"]): Layout {
  return { version: 1, blocks };
}

const NO_SEED_UPDATE = { hasSeedUpdate: false };

describe("resolveLayoutBlocks", () => {
  it("认识的块按布局顺序生成，内容从本地事实读", () => {
    const config = makeConfig({ routing_mode: "proxy_selected", listen_port: 7890 });
    const blocks = resolveLayoutBlocks(
      layoutOf([{ type: "proxy_card" }, { type: "empty_hint" }]),
      makeRuntime(),
      config,
      NO_SEED_UPDATE,
    );
    expect(blocks.map((block) => block.kind)).toEqual(["proxy_card", "empty_hint"]);
    expect(blocks[0]).toMatchObject({ address: "127.0.0.1:7890" });
    expect(blocks[1]).toMatchObject({ tone: "idle" });
  });

  it("不认识的块跳过，不影响其它块", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocks = resolveLayoutBlocks(
      layoutOf([
        { type: "banner" } as unknown as Layout["blocks"][number],
        { type: "empty_hint" },
      ]),
      makeRuntime(),
      makeConfig(),
      NO_SEED_UPDATE,
    );
    expect(blocks.map((block) => block.kind)).toEqual(["empty_hint"]);
    expect(warn).toHaveBeenCalledWith("[layout] 不认识的块类型：banner");
    warn.mockRestore();
  });

  it("issue_card 是叠加层：布局里的这一块跳过并记日志", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocks = resolveLayoutBlocks(
      layoutOf([{ type: "issue_card" }]),
      makeRuntime(),
      makeConfig(),
      NO_SEED_UPDATE,
    );
    expect(blocks).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("proxy_card 只给本机代理用户：TUN 配置跳过", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocks = resolveLayoutBlocks(
      layoutOf([{ type: "proxy_card" }]),
      makeRuntime({ state: "running", mixed_port: 7890 }),
      makeConfig({ connect_mode: "tun" }),
      NO_SEED_UPDATE,
    );
    expect(blocks).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("source_choice 只在没有节点时生成", () => {
    const withNodes = resolveLayoutBlocks(
      layoutOf([{ type: "source_choice" }]),
      makeRuntime(),
      makeConfig(),
      NO_SEED_UPDATE,
    );
    expect(withNodes).toEqual([]);

    const empty = resolveLayoutBlocks(
      layoutOf([{ type: "source_choice" }]),
      makeRuntime(),
      makeConfig({ nodes: [], node_count: 0 }),
      NO_SEED_UPDATE,
    );
    expect(empty).toEqual([{ kind: "source_choice" }]);
  });

  it("reachability 只用 targets：去空白、去重、忽略非字符串", () => {
    const blocks = resolveLayoutBlocks(
      layoutOf([
        {
          type: "reachability",
          props: { targets: [" ChatGPT ", "", 3, "ChatGPT", "Claude Code"] },
        },
      ]),
      makeRuntime({ state: "running", mixed_port: 7890 }),
      makeConfig(),
      NO_SEED_UPDATE,
    );
    expect(blocks).toEqual([
      { kind: "reachability", targets: ["ChatGPT", "Claude Code"], connected: true },
    ]);
  });

  it("reachability 没有可用 targets 时不生成", () => {
    const blocks = resolveLayoutBlocks(
      layoutOf([{ type: "reachability", props: { targets: [] } }]),
      makeRuntime(),
      makeConfig(),
      NO_SEED_UPDATE,
    );
    expect(blocks).toEqual([]);
  });

  it("update_hint 只在新版本确实存在时生成", () => {
    const none = resolveLayoutBlocks(
      layoutOf([{ type: "update_hint" }]),
      makeRuntime(),
      makeConfig(),
      NO_SEED_UPDATE,
    );
    expect(none).toEqual([]);

    const some = resolveLayoutBlocks(
      layoutOf([{ type: "update_hint" }]),
      makeRuntime(),
      makeConfig(),
      { hasSeedUpdate: true },
    );
    expect(some).toEqual([{ kind: "update_hint" }]);
  });
});
