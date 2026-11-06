# 连接与断开的过渡：阻塞、阶段与释放

> 日期：2026-11-06
> 状态：设计定稿，随本次实现落地
> 范围：`src/App.tsx`、新增 `src/components/ConnectionOverlay.tsx`、`src/styles/app.css`
> 不改后端契约，不新增命令；阶段全部来自已有状态与健康快照

---

## 1. 阻塞范围：全窗口，配真实阶段文案

**结论：连接/断开进行中，遮住整个应用窗口并拦截指针事件。**

理由：

- 用户要的是「阻塞操作」，而连接相关的操作散布在窗口各处：启动/断开按钮、切换配置、切换节点、删除配置、新建配置。
  只锁按钮，其余入口仍可点，会出现「正在连 A 配置，顺手切到 B」这种自相矛盾的组合。
- 连接通常 3–8 秒、TUN 断开可能更久。全窗口遮罩如果只有一个转圈，确实像卡死；
  所以**遮罩上必须有分阶段、可读的文案**（见 §2），并允许屏幕阅读器读出阶段变化。
- 遮罩不带任何按钮，也不做点击穿透；系统管理员授权弹窗由系统绘制，永远在遮罩之上，不受影响。

不做「只锁连接按钮」：它看起来更轻，但用户仍能在过渡期间改动会被这次连接读取的状态（当前配置、节点、删除），
结果是界面允许、后端拒绝，或者更糟——连接建立在一个已经变了的配置上。

### 1.1 遮罩的层级

- `position: fixed; inset: 0`，`z-index: 95`：高于设置弹层（70/80）与模型提问（90）。
- 过渡期间即使设置页开着（例如 AI 在后台发起重连），也一并被遮住；过渡结束后设置页原样回来。
- 不做半透明以外的视觉改动，不隐藏底层界面：用户应该看出「应用还在，只是现在不能动」。

---

## 2. 阶段与文案：只用真实信号

所有阶段来自两个已存在的数据源：

- `vpn.connection`（`idle | starting | connected | stopping`，由 `useVpnSession` 维护）；
- `runtime.state` 与 `runtime.health.{process, clash_api, data_plane, exit_ip}`（运行时事件与健康快照）。

**不画百分比。** 没有真实进度就不给进度条数字；动画只表示「仍在进行」。

### 2.1 连接（`connection = starting` 或 `preparingHelper = true`）

| 阶段 | 触发条件（真实信号） | 标题 | 说明 |
|---|---|---|---|
| 准备（授权） | `preparingHelper = true` 且 `health.process = false` | 正在准备后台组件 | 系统会请求一次授权。 |
| 准备 | 其余情况下 `health.process = false` | 正在准备连接 | 正在启动后台组件。 |
| 建立连接 | `health.process = true` 且 `health.data_plane = false` | 正在建立连接 | 正在连接节点。 |
| 确认出口 | `health.data_plane = true`（或已有 `exit_ip`） | 正在确认出口 | 正在确认流量已经走节点。 |

- 授权阶段只持续到运行时进程起来为止；进程起来后即使 `preparingHelper` 还没复位，也进入下一段。

- 「准备后台组件」这一阶段必须在系统授权弹窗出现**之前**就渲染。实现上遮罩由 `preparingHelper` 直接驱动，
  而 `useVpnSession` 在调用后端（会弹 osascript）之前先设置它并让出一帧（`useVpnSession.ts` 的 `nextPaint`）。
- 遮罩里的这句与节点卡/控制台现有文案同源，不另写一版。
- 阶段 3 可能只闪一下（后端在健康通过后立刻转 `running`）。这是真实节奏，不为展示而延长。

### 2.2 断开（`connection = stopping`）

| 阶段 | 触发条件（真实信号） | 标题 | 说明 |
|---|---|---|---|
| 断开连接 | `runtime.state ≠ stopping` | 正在断开连接 | 使用「全部流量」时通常会久一些。（仅 `connectMode = tun` 时显示） |
| 收尾 | `runtime.state = stopping` | 正在收尾 | 正在停止后台组件并做收尾。 |

- 不写「大约 5 秒」这类时间承诺；TUN 拆卸、代理还原、进程终止各自耗时不同。
- `runtime.state` 还没走到 `stopping` 时，后端正在拆 TUN 或撤代理；走到 `stopping` 后只剩运行时收尾。
  两段都真实存在，且第二段可能很短——短就短，不硬凑。

### 2.3 慢操作：改文案，不解锁

超过 **10 秒**仍在进行（连接或断开）：

- 连接：追加一行「还在连接，请稍候。」
- 断开：追加一行「还在断开，请稍候。」

只改文案，**不自动释放遮罩**。没有任何信号说明操作已经结束，这时解锁等于谎报完成。
真正的超时由后端给出（`RUNTIME_START_TIMEOUT` 等），会走到 §3 的失败释放。

---

## 3. 释放条件

遮罩是否显示，只由应用状态决定，**不由按钮的 Promise 决定**。这样不存在「操作结束了但遮罩还在」的窗口。

| 情况 | 信号 | 结果 |
|---|---|---|
| 连接成功 | `connection = connected`（`runtime.state` 进入 `running/degraded`） | 立即释放，露出已连接卡片 |
| 连接失败 | `runtime.state = failed`，或 `connection` 回到 `idle` | 立即释放；失败三段式交给已有的失败卡，遮罩不重复报错 |
| 超时 | 后端返回超时错误 → 状态离开过渡态 | 同上，立即释放 |
| 用户/别处在断开 | `connection` 变为 `idle` | 立即释放 |
| 断开完成 | `connection = idle` | 立即释放 |
| 断开中途失败 | 状态回到 `idle` 或 `failed` | 立即释放 |
| 后端卡住、无任何事件 | 无 | 保持遮罩，10 秒后改文案「还在……，请稍候」；不自动解锁 |

兜底：`useVpnSession` 在 `start` / `stop` 的请求落定时，如果状态仍停在 `starting` / `stopping`（例如刷新快照失败），
直接把连接状态收敛到终态（成功 → `connected`，失败 → `idle`）。这样遮罩由状态驱动也不会挂住。

此外：设置页打开/关闭、AI 面板开合等 UI 状态变化都不参与遮罩生命周期。

---

## 4. 交互与无障碍

- **指针**：遮罩层拦截所有指针事件；底层不可点、不可滚动（`overscroll-behavior: contain`）。
- **键盘**：遮罩出现时把焦点移到状态卡片（`tabIndex = -1`），Tab 被限制在遮罩内（无交互元素，等于停留）。
  遮罩结束后焦点回到出现前的元素。
- **读屏**：`role="dialog"`、`aria-modal="true"`、`aria-busy="true"`、`aria-labelledby` 指向标题；
  标题元素带 `aria-live="polite"`，阶段变化会被播报。不做倒计时播报。
- **reduced motion**：`prefers-reduced-motion: reduce` 时关掉呼吸点与进度线动画，保留遮罩、标题与说明。
- **不提供取消**：连接/断开中途取消是另一套状态机（后端是否可中断、取消后的回滚），没有设计过就不放按钮。

---

## 5. 已实现部分的复用

- `vpn.preparingHelper` 与 Console 里的「正在准备后台组件 / 系统会请求一次授权」保持原样；
  遮罩只负责在它上面显示同一句，不删除、不改变原逻辑。
- 失败卡（`middleBlocks` 的 issue/failure 卡）不动；遮罩释放后自然露出。
- 节点卡的「测这个节点」、节点面板等不在本次范围。

---

## 6. 落点

| 文件 | 内容 |
|---|---|
| `src/components/ConnectionOverlay.tsx` | `connectionStage()` 纯函数、慢操作计时、遮罩组件 |
| `src/App.tsx` | 在根节点渲染遮罩，传入 `vpn.connection`、`vpn.preparingHelper`、`runtime`、当前配置方式 |
| `src/styles/app.css` | 遮罩、卡片、呼吸点、reduced-motion |
| `src/components/ConnectionOverlay.test.tsx` | 阶段映射、慢文案、四种释放、无障碍属性 |

测试覆盖（与 PM 要求对应）：

1. 成功释放：`starting → connected` 后遮罩消失；
2. 失败释放：`starting → failed/idle` 后遮罩消失；
3. 超时释放：错误导致状态回到 `idle` 后遮罩消失；
4. 外部状态变化释放：过渡中 `connection` 变为 `idle` 后遮罩消失；
5. 慢操作只改文案、遮罩仍在；
6. `prefers-reduced-motion` 由 CSS 处理，组件测试断言遮罩与文案仍在；
7. 准备阶段先于授权出现：`preparingHelper` 为真即渲染「正在准备后台组件 / 系统会请求一次授权。」。
