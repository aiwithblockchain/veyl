import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AgentBridge, ConfigCreateInput } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import type {
  Category,
  ConfigConnectMode,
  ConfigRouteMode,
  ConfigSummary,
  NodeSummary,
} from "../agent/protocol";
import { nameTaken, uniqueConfigName } from "../config/model";

/** 与 Host 的 `SUPPORTED_METHODS` 顺序一致；不在白名单的方法后端也会拒绝。 */
const SUPPORTED_METHODS = [
  "aes-128-gcm",
  "aes-192-gcm",
  "aes-256-gcm",
  "aes-128-ctr",
  "aes-192-ctr",
  "aes-256-ctr",
  "chacha20-ietf-poly1305",
  "xchacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
  "none",
];

const DEFAULT_METHOD = "aes-256-gcm";

/** 这五个字段决定节点内容；任一变化都要重新建节点。 */
const NODE_FIELDS = ["name", "server", "port", "method", "password"] as const;

const REGION_LABELS: Record<string, string> = {
  cn: "中国大陆",
  hk: "中国香港",
  tw: "中国台湾",
  mo: "中国澳门",
  jp: "日本",
  us: "美国",
  sg: "新加坡",
  gb: "英国",
  de: "德国",
  fr: "法国",
  ca: "加拿大",
  au: "澳大利亚",
  kr: "韩国",
};

type NodeSource = "seed" | "paste" | "url" | "manual";

interface NodeDraftErrors {
  name?: string;
  server?: string;
  port?: string;
  password?: string;
}

interface NodeDraft {
  key: string;
  name: string;
  server: string;
  port: string;
  method: string;
  password: string;
  showPassword: boolean;
  /** 已经建成功的节点 id：重试时复用，避免重复建节点。 */
  nodeId?: string;
  errors: NodeDraftErrors;
}

interface FormErrors {
  name?: string;
  routing?: string;
  paste?: string;
  url?: string;
}

interface Props {
  bridge: AgentBridge;
  configs: ConfigSummary[];
  /** 系统时区 / 区域推断出的地区；null = 未知。 */
  region: string | null;
  onCreate: (
    input: ConfigCreateInput,
  ) => Promise<{ ok: boolean; message?: string; reason?: string }>;
  onCreated: () => void;
  onCancel: () => void;
}

function draftId(): string {
  return `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function makeDraft(index: number): NodeDraft {
  return {
    key: draftId(),
    name: `节点 ${index + 1}`,
    server: "",
    port: "8388",
    method: DEFAULT_METHOD,
    password: "",
    showPassword: false,
    errors: {},
  };
}

function regionCopy(region: string | null): {
  text: string;
  defaultRouting: ConfigRouteMode;
} {
  // 说明行常驻，所以不写「下面默认选了」——用户改选后那句话就变成假话。
  if (!region) {
    return {
      text: "没能识别你的地区，建议全部走 VPN，所有网站都会走 VPN。",
      defaultRouting: "proxy_all",
    };
  }
  if (region === "cn") {
    return {
      text: "你的电脑在中国大陆，建议让国内网站直连，中国网站不会变慢。",
      defaultRouting: "direct",
    };
  }
  const label = REGION_LABELS[region];
  return {
    text: label
      ? `你的电脑在${label}，建议让本地网站直连，本地网站不会变慢。`
      : "你的电脑不在中国大陆，建议让本地网站直连，本地网站不会变慢。",
    defaultRouting: "direct",
  };
}

function validateDraft(draft: NodeDraft): NodeDraftErrors {
  const errors: NodeDraftErrors = {};
  const name = draft.name.trim();
  if (!name) {
    errors.name = "填一个节点名称。";
  } else if (Array.from(name).length > 64) {
    errors.name = "节点名称最多 64 个字符。";
  }

  const server = draft.server.trim();
  if (!server) {
    errors.server = "填服务器地址。";
  } else if (server.includes("://")) {
    errors.server = "只填地址，不要带 ss://。";
  } else if (/\s/.test(server)) {
    errors.server = "地址里不要有空格。";
  } else if (/:\d+$/.test(server)) {
    errors.server = "端口填在下面，地址里不要带端口。";
  }

  const portText = draft.port.trim();
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = "端口要填 1–65535 之间的整数。";
  }

  if (!draft.password) {
    errors.password = "填服务器密码。";
  } else if (Array.from(draft.password).length > 256) {
    errors.password = "密码最多 256 个字符。";
  }
  return errors;
}

function errorText(error: unknown, fallback: string): string {
  const message = toBridgeError(error).message;
  return message && message !== "操作失败" ? message : fallback;
}

export function ManualConfigForm({
  bridge,
  configs,
  region,
  onCreate,
  onCreated,
  onCancel,
}: Props) {
  const copy = regionCopy(region);
  const [name, setName] = useState(() => uniqueConfigName("我的配置", configs));
  const [connectMode, setConnectMode] = useState<ConfigConnectMode>("tun");
  const [routingMode, setRoutingMode] = useState<ConfigRouteMode>(copy.defaultRouting);
  const [routingTouched, setRoutingTouched] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  const [source, setSource] = useState<NodeSource>("seed");
  const [pasteText, setPasteText] = useState("");
  const [url, setUrl] = useState("");
  const [drafts, setDrafts] = useState<NodeDraft[]>([makeDraft(0)]);
  /** 已导入的节点 id：签名不变时重试直接复用，不重复导入。 */
  const [imported, setImported] = useState<{ signature: string; ids: string[] } | null>(
    null,
  );

  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  // 地区晚到时不覆盖用户已经改过的选择。
  useEffect(() => {
    if (routingTouched) return;
    setRoutingMode(regionCopy(region).defaultRouting);
  }, [region, routingTouched]);

  useEffect(() => {
    if (routingMode !== "proxy_selected" || categories !== null) return;
    let alive = true;
    setCategoriesLoading(true);
    setCategoriesError(null);
    bridge
      .categoryList(undefined, 200)
      .then((result) => {
        if (alive) setCategories(result.categories);
      })
      .catch(() => {
        if (alive) setCategoriesError("服务列表没加载出来，检查网络后再试。");
      })
      .finally(() => {
        if (alive) setCategoriesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [routingMode, categories, bridge]);

  const focusFirstError = () => {
    window.requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
    });
  };

  const updateDraft = (key: string, patch: Partial<NodeDraft>) => {
    setDrafts((current) =>
      current.map((draft) => {
        if (draft.key !== key) return draft;
        // 已建节点只有在字段没变时才能复用；改了任一字段就重新建，不能拿旧 id 建配置。
        const nodeChanged = NODE_FIELDS.some(
          (field) => field in patch && patch[field] !== draft[field],
        );
        return {
          ...draft,
          ...patch,
          nodeId: nodeChanged ? undefined : draft.nodeId,
          errors: { ...draft.errors, ...clearError(patch) },
        };
      }),
    );
  };

  const clearError = (patch: Partial<NodeDraft>): NodeDraftErrors => {
    const cleared: NodeDraftErrors = {};
    for (const field of ["name", "server", "port", "password"] as const) {
      if (field in patch) cleared[field] = undefined;
    }
    return cleared;
  };

  const ensureNodes = async (): Promise<string[] | null> => {
    if (source === "seed") return [];

    if (source === "paste") {
      const signature = pasteText.trim();
      if (imported?.signature === signature) return imported.ids;
      try {
        const result = await bridge.nodeImportText(signature);
        const ids = result.nodes.map((node: NodeSummary) => node.node_id);
        if (ids.length === 0) {
          setErrors((current) => ({
            ...current,
            paste: "粘贴的内容里没有可用的节点（支持多行 ss:// 链接）。",
          }));
          return null;
        }
        setImported({ signature, ids });
        return ids;
      } catch (error) {
        setErrors((current) => ({
          ...current,
          paste:
            toBridgeError(error).details?.reason === "not_node_text"
              ? "粘贴的内容里没有可用的节点（支持多行 ss:// 链接）。"
              : errorText(error, "这段内容没能导入，检查后再试。"),
        }));
        return null;
      }
    }

    if (source === "url") {
      const signature = url.trim();
      if (imported?.signature === signature) return imported.ids;
      try {
        const result = await bridge.nodeImportUrl(signature);
        const ids = result.nodes.map((node: NodeSummary) => node.node_id);
        if (ids.length === 0) {
          setErrors((current) => ({ ...current, url: "没拉到节点，检查地址或网络。" }));
          return null;
        }
        setImported({ signature, ids });
        return ids;
      } catch (error) {
        setErrors((current) => ({
          ...current,
          url: errorText(error, "没拉到节点，检查地址或网络。"),
        }));
        return null;
      }
    }

    const next = drafts.map((draft) => ({ ...draft }));
    try {
      for (const draft of next) {
        if (draft.nodeId) continue;
        const node = await bridge.nodeCreate({
          name: draft.name.trim(),
          server: draft.server.trim(),
          port: Number(draft.port.trim()),
          method: draft.method,
          password: draft.password,
        });
        draft.nodeId = node.node_id;
        // 每建成功一个就写回：后面失败时重试能复用已经建好的节点。
        setDrafts(next.map((item) => ({ ...item })));
      }
      return next.map((draft) => draft.nodeId).filter((id): id is string => Boolean(id));
    } catch (error) {
      setFormError(errorText(error, "节点没建成，检查后重试。"));
      return null;
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const nextErrors: FormErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName) {
      nextErrors.name = "填一个名字。";
    } else if (Array.from(trimmedName).length > 40) {
      nextErrors.name = "名字最多 40 个字符。";
    } else if (nameTaken(trimmedName, configs)) {
      nextErrors.name = "已经有一套叫这个名字的配置了。";
    }

    if (routingMode === "proxy_selected" && targets.length === 0) {
      nextErrors.routing = "至少选一个服务。";
    }

    if (source === "paste" && !pasteText.trim()) {
      nextErrors.paste = "粘贴 ss:// 链接。";
    }
    if (source === "url") {
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        nextErrors.url = "填订阅地址。";
      } else if (!/^https:\/\//i.test(trimmedUrl)) {
        nextErrors.url = "订阅地址要以 https:// 开头。";
      }
    }

    let draftsValid = true;
    const nextDrafts = drafts.map((draft) => {
      if (source !== "manual") return draft;
      const draftErrors = validateDraft(draft);
      if (Object.keys(draftErrors).length > 0) draftsValid = false;
      return { ...draft, errors: draftErrors };
    });
    if (source === "manual") setDrafts(nextDrafts);

    if (Object.keys(nextErrors).length > 0 || !draftsValid) {
      setErrors(nextErrors);
      setFormError(null);
      focusFirstError();
      return;
    }

    setErrors({});
    setFormError(null);
    setSubmitting(true);
    submittingRef.current = true;
    try {
      const nodeIds = await ensureNodes();
      if (nodeIds === null) return;

      const input: ConfigCreateInput = {
        name: trimmedName,
        connectMode,
        routingMode,
        ...(routingMode === "proxy_selected" ? { targets } : {}),
        ...(source === "seed" ? { source: "seed" as const } : { nodeIds }),
      };
      let result: { ok: boolean; message?: string; reason?: string };
      try {
        result = await onCreate(input);
      } catch (error) {
        setFormError(errorText(error, "创建配置失败，再试一次。"));
        return;
      }
      if (!result.ok) {
        if (result.reason === "duplicate_name") {
          setErrors({ name: "已经有一套叫这个名字的配置了。" });
        } else {
          setFormError(result.message ?? "创建配置失败，再试一次。");
        }
        return;
      }
      onCreated();
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const toggleTarget = (id: string) => {
    setTargets((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const filteredCategories = (categories ?? []).filter((category) => {
    const needle = categoryQuery.trim().toLowerCase();
    if (!needle) return true;
    return (
      category.id.toLowerCase().includes(needle) ||
      category.name_zh.includes(needle) ||
      category.name_en.toLowerCase().includes(needle)
    );
  });

  const selectedCategories = (categories ?? []).filter((category) =>
    targets.includes(category.id),
  );

  return (
    <form ref={formRef} className="new-config__manual" onSubmit={submit} noValidate>
      <label className="new-config__field">
        <span className="new-config__label">名字</span>
        <input
          ref={nameRef}
          className="new-config__input"
          value={name}
          maxLength={40}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? "new-config-name-error" : undefined}
          onChange={(event) => {
            setName(event.target.value);
            if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
          }}
        />
        {errors.name ? (
          <span className="new-config__error" id="new-config-name-error" role="alert">
            {errors.name}
          </span>
        ) : null}
      </label>

      <fieldset className="new-config__group">
        <legend className="new-config__label">怎么连</legend>
        <div className="new-config__options" role="radiogroup" aria-label="怎么连">
          <label className={`new-config__mode ${connectMode === "tun" ? "is-selected" : ""}`}>
            <input
              type="radio"
              name="connect-mode"
              value="tun"
              checked={connectMode === "tun"}
              onChange={() => setConnectMode("tun")}
            />
            <span className="new-config__mode-body">
              <span className="new-config__mode-title">所有软件都走 VPN</span>
              <span className="new-config__mode-text">装好就能用，不用逐个软件设置。</span>
            </span>
          </label>
          <label
            className={`new-config__mode ${connectMode === "system_proxy" ? "is-selected" : ""}`}
          >
            <input
              type="radio"
              name="connect-mode"
              value="system_proxy"
              checked={connectMode === "system_proxy"}
              onChange={() => setConnectMode("system_proxy")}
            />
            <span className="new-config__mode-body">
              <span className="new-config__mode-title">只让能填代理的软件走</span>
              <span className="new-config__mode-text">
                别的软件不受影响，需要你自己填地址。
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className="new-config__group">
        <legend className="new-config__label">哪些走 VPN</legend>
        <p className="new-config__region" id="new-config-region-note">
          {copy.text}
        </p>
        <div
          className="new-config__options"
          role="radiogroup"
          aria-label="哪些走 VPN"
          aria-describedby="new-config-region-note"
        >
          <label className={`new-config__mode ${routingMode === "direct" ? "is-selected" : ""}`}>
            <input
              type="radio"
              name="routing-mode"
              value="direct"
              checked={routingMode === "direct"}
              onChange={() => {
                setRoutingTouched(true);
                setRoutingMode("direct");
              }}
            />
            <span className="new-config__mode-body">
              <span className="new-config__mode-title">本地网站直连，其他都走 VPN</span>
              {region === null && routingMode === "direct" ? (
                <span className="new-config__mode-text new-config__mode-text--warn">
                  认不出你所在的地区，选这个的话所有网站都会走 VPN。
                </span>
              ) : null}
            </span>
          </label>
          <label
            className={`new-config__mode ${routingMode === "proxy_all" ? "is-selected" : ""}`}
          >
            <input
              type="radio"
              name="routing-mode"
              value="proxy_all"
              checked={routingMode === "proxy_all"}
              onChange={() => {
                setRoutingTouched(true);
                setRoutingMode("proxy_all");
              }}
            />
            <span className="new-config__mode-body">
              <span className="new-config__mode-title">全部走 VPN</span>
            </span>
          </label>
          <label
            className={`new-config__mode ${
              routingMode === "proxy_selected" ? "is-selected" : ""
            }`}
          >
            <input
              type="radio"
              name="routing-mode"
              value="proxy_selected"
              checked={routingMode === "proxy_selected"}
              onChange={() => {
                setRoutingTouched(true);
                setRoutingMode("proxy_selected");
              }}
            />
            <span className="new-config__mode-body">
              <span className="new-config__mode-title">
                只有我指定的服务走 VPN，其他直连
              </span>
            </span>
          </label>
        </div>

        {routingMode === "proxy_selected" ? (
          <div className="new-config__services">
            {selectedCategories.length > 0 ? (
              <div className="new-config__tags">
                {selectedCategories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className="new-config__tag"
                    onClick={() => toggleTarget(category.id)}
                    aria-label={`移除 ${category.name_zh}`}
                  >
                    {category.name_zh} ×
                  </button>
                ))}
              </div>
            ) : null}
            <label className="new-config__field">
              <span className="new-config__label">搜索服务</span>
              <input
                className="new-config__input"
                value={categoryQuery}
                placeholder="输入服务名称…"
                onChange={(event) => setCategoryQuery(event.target.value)}
              />
            </label>
            {categoriesLoading ? (
              <p className="new-config__hint">正在读取服务列表…</p>
            ) : categoriesError ? (
              <p className="new-config__error" role="alert">
                {categoriesError}
              </p>
            ) : (
              <div className="new-config__service-list">
                {filteredCategories.map((category) => {
                  const checked = targets.includes(category.id);
                  return (
                    <button
                      key={category.id}
                      type="button"
                      className={`new-config__service ${checked ? "is-selected" : ""}`}
                      aria-pressed={checked}
                      onClick={() => toggleTarget(category.id)}
                    >
                      {checked ? "✓ " : ""}
                      {category.name_zh}
                    </button>
                  );
                })}
                {filteredCategories.length === 0 ? (
                  <p className="new-config__hint">没有匹配的服务。</p>
                ) : null}
              </div>
            )}
            {errors.routing ? (
              <p className="new-config__error" role="alert">
                {errors.routing}
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="new-config__group">
        <legend className="new-config__label">节点</legend>
        <div className="new-config__options" role="radiogroup" aria-label="节点来源">
          <label className={`new-config__mode ${source === "seed" ? "is-selected" : ""}`}>
            <input
              type="radio"
              name="node-source"
              value="seed"
              checked={source === "seed"}
              onChange={() => setSource("seed")}
            />
            <span className="new-config__mode-body">
              <span className="new-config__mode-title">
                用 Veyl 提供的测试节点（仅供试用）
              </span>
            </span>
          </label>
          <label className={`new-config__mode ${source === "paste" ? "is-selected" : ""}`}>
            <input
              type="radio"
              name="node-source"
              value="paste"
              checked={source === "paste"}
              onChange={() => setSource("paste")}
            />
            <span className="new-config__mode-body">
              <span className="new-config__mode-title">粘贴分享链接</span>
              <span className="new-config__mode-text">一行一条 ss:// 链接。</span>
            </span>
          </label>
          {source === "paste" ? (
            <div className="new-config__source-body">
              <textarea
                className="new-config__textarea"
                rows={3}
                value={pasteText}
                aria-label="粘贴分享链接"
                aria-invalid={errors.paste ? true : undefined}
                aria-describedby={errors.paste ? "new-config-paste-error" : undefined}
                placeholder={"ss://…\nss://…"}
                onChange={(event) => {
                  setPasteText(event.target.value);
                  setImported(null);
                  if (errors.paste) setErrors((current) => ({ ...current, paste: undefined }));
                }}
              />
              {errors.paste ? (
                <p className="new-config__error" id="new-config-paste-error" role="alert">
                  {errors.paste}
                </p>
              ) : null}
            </div>
          ) : null}

          <label className={`new-config__mode ${source === "url" ? "is-selected" : ""}`}>
            <input
              type="radio"
              name="node-source"
              value="url"
              checked={source === "url"}
              onChange={() => setSource("url")}
            />
            <span className="new-config__mode-body">
              <span className="new-config__mode-title">订阅地址</span>
            </span>
          </label>
          {source === "url" ? (
            <div className="new-config__source-body">
              <input
                className="new-config__input"
                value={url}
                aria-label="订阅地址"
                aria-invalid={errors.url ? true : undefined}
                aria-describedby={errors.url ? "new-config-url-error" : undefined}
                placeholder="https://…"
                onChange={(event) => {
                  setUrl(event.target.value);
                  setImported(null);
                  if (errors.url) setErrors((current) => ({ ...current, url: undefined }));
                }}
              />
              {errors.url ? (
                <p className="new-config__error" id="new-config-url-error" role="alert">
                  {errors.url}
                </p>
              ) : null}
            </div>
          ) : null}

          <label className={`new-config__mode ${source === "manual" ? "is-selected" : ""}`}>
            <input
              type="radio"
              name="node-source"
              value="manual"
              checked={source === "manual"}
              onChange={() => setSource("manual")}
            />
            <span className="new-config__mode-body">
              <span className="new-config__mode-title">自己填</span>
            </span>
          </label>
        </div>

        {source === "manual" ? (
          <div className="new-config__source-body">
            {drafts.map((draft, index) => (
              <div key={draft.key} className="new-config__node-card">
                <div className="new-config__node-index">节点 {index + 1}</div>
                <label className="new-config__field">
                  <span className="new-config__label">名称</span>
                  <input
                    className="new-config__input"
                    value={draft.name}
                    maxLength={64}
                    aria-invalid={draft.errors.name ? true : undefined}
                    aria-describedby={
                      draft.errors.name ? `node-${draft.key}-name-error` : undefined
                    }
                    onChange={(event) =>
                      updateDraft(draft.key, { name: event.target.value })
                    }
                  />
                  {draft.errors.name ? (
                    <span
                      className="new-config__error"
                      id={`node-${draft.key}-name-error`}
                      role="alert"
                    >
                      {draft.errors.name}
                    </span>
                  ) : null}
                </label>
                <div className="new-config__node-row">
                  <label className="new-config__field new-config__field--grow">
                    <span className="new-config__label">地址</span>
                    <input
                      className="new-config__input new-config__input--mono"
                      value={draft.server}
                      aria-invalid={draft.errors.server ? true : undefined}
                      aria-describedby={
                        draft.errors.server ? `node-${draft.key}-server-error` : undefined
                      }
                      onChange={(event) =>
                        updateDraft(draft.key, { server: event.target.value })
                      }
                    />
                    {draft.errors.server ? (
                      <span
                        className="new-config__error"
                        id={`node-${draft.key}-server-error`}
                        role="alert"
                      >
                        {draft.errors.server}
                      </span>
                    ) : null}
                  </label>
                  <label className="new-config__field new-config__field--port">
                    <span className="new-config__label">端口</span>
                    <input
                      className="new-config__input new-config__input--mono"
                      inputMode="numeric"
                      value={draft.port}
                      aria-invalid={draft.errors.port ? true : undefined}
                      aria-describedby={
                        draft.errors.port ? `node-${draft.key}-port-error` : undefined
                      }
                      onChange={(event) =>
                        updateDraft(draft.key, { port: event.target.value })
                      }
                    />
                    {draft.errors.port ? (
                      <span
                        className="new-config__error"
                        id={`node-${draft.key}-port-error`}
                        role="alert"
                      >
                        {draft.errors.port}
                      </span>
                    ) : null}
                  </label>
                </div>
                <label className="new-config__field">
                  <span className="new-config__label">加密方式</span>
                  <select
                    className="new-config__input"
                    value={draft.method}
                    onChange={(event) =>
                      updateDraft(draft.key, { method: event.target.value })
                    }
                  >
                    {SUPPORTED_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {method}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="new-config__field">
                  <span className="new-config__label">密码</span>
                  <div className="new-config__password">
                    <input
                      className="new-config__input new-config__input--mono"
                      type={draft.showPassword ? "text" : "password"}
                      value={draft.password}
                      autoComplete="off"
                      aria-invalid={draft.errors.password ? true : undefined}
                      aria-describedby={
                        draft.errors.password
                          ? `node-${draft.key}-password-error`
                          : undefined
                      }
                      onChange={(event) =>
                        updateDraft(draft.key, { password: event.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() =>
                        updateDraft(draft.key, { showPassword: !draft.showPassword })
                      }
                    >
                      {draft.showPassword ? "隐藏" : "显示"}
                    </button>
                  </div>
                  {draft.errors.password ? (
                    <span
                      className="new-config__error"
                      id={`node-${draft.key}-password-error`}
                      role="alert"
                    >
                      {draft.errors.password}
                    </span>
                  ) : null}
                </label>
              </div>
            ))}
            <button
              type="button"
              className="new-config__add-node"
              onClick={() => setDrafts((current) => [...current, makeDraft(current.length)])}
            >
              ＋ 再加一个节点
            </button>
          </div>
        ) : null}
      </fieldset>

      <p className="new-config__note">目前只支持 Shadowsocks 服务器。</p>

      {formError ? (
        <p className="new-config__error new-config__error--form" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="new-config__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? "正在创建…" : "创建"}
        </button>
      </div>
    </form>
  );
}
