# 待讨论事项

> 记录下来、但还没开始讨论的话题。讨论完把结论写进对应设计文档，并从本文件删掉。

## 1. 节点凭据的签发流程与原理

**要讨论的**：`CREDENTIAL_SIGNING_JWK` 这条链路完整走一遍——控制面什么时候签、payload 里有什么、客户端怎么验、验过之后写到哪、15 分钟有效期到了怎么办、为什么客户端要内置公钥而不是每次问服务端。

**为什么值得单独讲**：这是用户能连上自己服务器的唯一钥匙。现在它的设计散在 `docs/design/my-servers.md`、`docs/contracts/commands.md` 和源码里，没有一处从头讲到尾；出问题时不容易判断「是签发错了还是验签错了」。

**已定的事实（讨论时不用再定）**：
- 私钥只在 Cloudflare secret（`CREDENTIAL_SIGNING_JWK`），公钥内置在客户端 `src-tauri/src/control_plane/credentials.rs` 的 `CREDENTIAL_KEYS`
- dev = `cp-2026-11`，生产 = `cp-2026-12`，两把公钥都在客户端里，按响应中的 `key_id` 选择
- 凭据有效期 5 分钟，过期由客户端重新取
- 换私钥必须先发客户端、再切服务端，不能反过来
