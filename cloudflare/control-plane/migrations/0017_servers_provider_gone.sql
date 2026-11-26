-- 用户在 DigitalOcean 后台直接删掉 droplet 后，我们的表里没有任何痕迹：
-- `state` 仍是 active，`destroyed_at` 为空，于是按天扣费一直扣、按天释放的额度一直涨
-- （`releasedBytes` 用 `destroyed_at ?? now`），下个周期还白送一份月额度。
--
-- 判定只在「到期结算 + 心跳静默 2 小时」的交集上做，并且要 DIGITALOCEAN 返回 404 才落这个标记：
-- 这只是存在性对账，不是在线检测，也不替代销毁。标记不为空 = 不给这台继续扣费、额度在失联时刻封顶；
-- agent 再上报就清空（见 `POST /v1/agent/traffic`），用户主动销毁仍走原来的退款与清理路径。
ALTER TABLE servers ADD COLUMN provider_gone_at INTEGER DEFAULT NULL;
