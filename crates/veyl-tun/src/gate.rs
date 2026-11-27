//! `data_plane` 的去抖状态。
//!
//! 从主客户端 `runtime/health.rs` 移入：`tun/session.rs` 直接依赖它，而它本身
//! 纯计数、不碰 IO，也不依赖 `runtime::error`。

/// `data_plane` 连续失败多少次才置 `false`（契约 §2.3.1）。
///
/// 一次失败不改值：上游或探测 URL 抖一下不该让界面闪红。
pub const DATA_PLANE_FAILURES_BEFORE_DOWN: u32 = 2;

/// `data_plane` 的去抖状态：**连续两次**失败才降级，一次成功立即恢复。
///
/// 纯计数、不做 IO，也不管间隔——间隔与循环属于各自连接的持有者
/// （代理在 `RuntimeManager::supervise`，TUN 在 `TunSession` + 健康循环）。
/// 放在这里是因为代理与 TUN 两条路径必须用同一套口径，不能各写一份。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DataPlaneGate {
    up: bool,
    consecutive_failures: u32,
}

impl Default for DataPlaneGate {
    fn default() -> Self {
        // 还没探测过：乐观。契约规定「连接后头 10s 未知按乐观处理」。
        Self {
            up: true,
            consecutive_failures: 0,
        }
    }
}

impl DataPlaneGate {
    pub fn up(&self) -> bool {
        self.up
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }

    /// 新连接 / 换节点：回到乐观初值。
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// 记一次探测结果，返回 `up` 是否翻转。
    pub fn record(&mut self, ok: bool) -> bool {
        let before = self.up;
        if ok {
            self.up = true;
            self.consecutive_failures = 0;
        } else {
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            if self.consecutive_failures >= DATA_PLANE_FAILURES_BEFORE_DOWN {
                self.up = false;
            }
        }
        self.up != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约 §2.3.1：单次失败不改值——上游抖一下不该让界面闪红。
    #[test]
    fn one_failure_keeps_data_plane_up() {
        let mut gate = DataPlaneGate::default();
        assert!(!gate.record(false), "第一次失败不能翻转");
        assert!(gate.up());
        assert_eq!(gate.consecutive_failures(), 1);
    }

    #[test]
    fn two_consecutive_failures_take_data_plane_down() {
        let mut gate = DataPlaneGate::default();
        gate.record(false);
        assert!(gate.record(false), "连续第二次失败要翻转");
        assert!(!gate.up());
    }

    /// 一次成功立刻回 true，并把计数清零：之后要重新连续两次失败才会再降级。
    #[test]
    fn a_single_success_recovers_immediately() {
        let mut gate = DataPlaneGate::default();
        gate.record(false);
        gate.record(false);
        assert!(!gate.up());

        assert!(gate.record(true));
        assert!(gate.up());
        assert_eq!(gate.consecutive_failures(), 0);

        gate.record(false);
        assert!(gate.up(), "恢复后单次失败不该再翻回去");
    }

    /// 失败不连续（中间夹着成功）不算「连续失败」。
    #[test]
    fn failures_separated_by_a_success_do_not_accumulate() {
        let mut gate = DataPlaneGate::default();
        gate.record(false);
        gate.record(true);
        gate.record(false);
        assert!(gate.up());
        assert_eq!(gate.consecutive_failures(), 1);
    }

    #[test]
    fn reset_returns_to_the_optimistic_value() {
        let mut gate = DataPlaneGate::default();
        gate.record(false);
        gate.record(false);
        gate.reset();
        assert!(gate.up());
        assert_eq!(gate.consecutive_failures(), 0);
    }
}
