# GPT TOKEN / Relay Station 项目长期记忆

最后核对：2026-09-20。这是跨会话交接记录，事实来源为用户指令、当前源码、Git 和实际运维结果。动态状态以重新检查为准；最近发布证据见 [OPERATIONS_LOG.md](OPERATIONS_LOG.md)。

## 项目与范围

- 产品名 GPT TOKEN，保留现有 Logo；给用户提供统一 AI API、聊天、图片/视频创作、钱包、月套餐、用量和 API Key 管理，后台负责渠道、成本、利润、订单及内容审核。
- 主仓库 `/Volumes/brainos/miniprogram/token/relay-station`，GitHub `https://github.com/qianyu1987/api`。本次工作不是重建父目录服务。
- 父目录 `token/` 中的 `oneapi-pay-bridge/`、`server.js`、`ops/` 属于相关/历史系统，不是本项目的默认部署对象。上层微信、抖音小程序和假了么共用服务器资源，禁止覆盖其他站点与服务。
- 前端为原生 HTML/CSS/JavaScript，不擅自迁移框架。作品默认私密，管理员审核后才可公开；历史任务、账单、价格快照完整保留。

## 固定服务器信息

| 项目 | 已确认值 |
| --- | --- |
| 生产 IP | `101.35.223.148` |
| 业务域名 | `www.hhtc.top`、`api.hhtc.top` |
| SSH 用户 | `root` |
| SSH 密钥文件位置 | `/Volumes/brainos/MacStorage/Downloads/111.pem` |
| 主机名（最近实测） | `VM-0-7-centos` |
| 生产应用目录 | `/opt/relay-station` |
| 网关宿主机监听 | `127.0.0.1:18082` |
| GitHub 主分支 | `main` |

`124.223.74.26` 与本项目生产部署无关，不能使用。固定连接命令：

```sh
ssh -i /Volumes/brainos/MacStorage/Downloads/111.pem -o BatchMode=yes -o ConnectTimeout=10 root@101.35.223.148
```

2026-09-20 已用此命令成功登录、构建、部署并复查。历史“默认密钥被拒”不代表此密钥失效。先实际测试，失败时区分网络、文件不可用、主机验证和认证问题；不要未经测试反复要求用户恢复公钥。

此处仅记录密钥位置，禁止读取到输出或复制密钥内容。不要在记忆、代码、日志、Git 中记录 API Key、密码、Cookie、支付证书或含敏感参数的 URL。

## 架构与代码导航

Node.js 22+、TypeScript、Fastify，PostgreSQL 是账务唯一事实来源，Redis 用于缓存、限流及临时协调。Compose 运行两个 API 副本、Gateway、PostgreSQL、Redis，以及一次性 migration/maintenance worker。

| 文件/目录 | 职责 |
| --- | --- |
| `public/index.html`、`public/app.js`、`public/styles.css` | 用户站点和管理后台；首页脚本带版本查询参数 |
| `src/server.ts` | 页面/API 路由、管理接口、应用内定时任务 |
| `src/services/orders.ts`、`src/payment/` | 支付验签/查询、订单到账核对、幂等补账 |
| `src/services/billing.ts`、`profit.ts`、`affiliate.ts` | 预扣/结算/释放、套餐、利润及返利 |
| `src/services/media.ts`、`src/lib/media.ts` | 媒体报价、输入校验、任务领取、上游提交/轮询、退款 |
| `src/lib/media-api.ts`、`media-upload.ts` | 兼容媒体 API、素材上传 |
| `src/services/channels.ts`、`channel-costs.ts` | 渠道路由、故障处理、上游配额和成本 |
| `src/lib/agnes-adapter.ts`、`public-model.ts` | 模型及 Responses 适配 |
| `src/db/schema.sql`、`src/db/index.ts` | Schema、校验和迁移与事务 |
| `src/worker.ts`、`deploy/systemd/` | 定时一次性维护 worker |
| `docker-compose.yml`、`Dockerfile`、`deploy/` | 镜像、双副本与 Nginx 部署 |
| `tests/` | 账务、支付、渠道、媒体及 API 回归测试 |

媒体任务并非仅由 systemd worker 处理：API 进程每 3 秒调用 `media.tick()`，使用数据库租约领取；已支付订单补账扫描每 30 秒；微信补查每 60 秒。systemd `relay-station-worker.timer` 调度一次性维护进程，成功退出是正常行为。

## 账务与支付约束

- `v1.0.86` 后台用户列表的“实付总额”包含已支付的钱包充值与套餐购买订单（`wallet_topup`、`subscription`、`subscription_purchase`），优先使用订单实付金额，历史缺值回退订单金额。累计充值额度仍按钱包 `wallet_topup` 流水统计，可用余额为钱包余额减冻结额；显示字段均为只读统计。套餐付款计入实付总额，套餐额度单独展示。

- 金额为整数微元；钱包、套餐独立。支付状态和到账状态是两个事实，不能仅凭支付回跳页面补余额。
- 当前默认充值倍率 3 倍，但历史订单必须按订单倍率/套餐快照核对，禁止套用今天的促销比例。
- 仅对有已验证支付依据的 paid 订单补账。钱包依据 `wallet_ledger(order_id, kind='wallet_topup')`，套餐依据 `subscription_purchases.order_id`；在事务内补发并记审计，重入/并发不得重复到账。
- 用户查单自动核对；后台订单显示 `creditStatus`、`creditedAmountMicros`、`creditedAt`、`creditMessage`，异常可重新核对。界面仅 credited 才显示到账成功。
- 用户曾多次报告支付成功未到账、回跳和余额刷新慢。已有补查及刷新修复；不能据此断言所有具体订单均已解决，要逐单检查支付证据、流水和快照，避免手工改余额。
- 媒体价格、模型映射、规格、用户账务不属于普通巡检自由修改范围。先前特定补账方案授权不等于任意账务调整授权。

## 媒体、上游与重试规则

- 视频当前为 Agnes `agnes-video-2.5-flash`，720P，4–12 秒；提交 `/v1/videos`，查询 `/agnesapi?video_id=...&model_name=...`。上游原点 `https://apihub.agnes-ai.com`。
- 标准图片为 Agnes `agnes-image-2.5-flash`，当前代码支持 1K/2K/3K/4K；专业图片为 YYAPI `gpt-image-2` (`https://cdn.yyapi.cloud`)，增强图片为 RIPP `gpt-image-2.5` (`https://ripp.best`)。实际可用性还依赖后台配置与上游状态。
- 专业/增强图片当前校验仅开放 1K、文字生成。用户询问过 gpt-image-2.5 的 4K 能力，但尚无已验证的 4K 支持结论，不得声称已支持或擅自扩大规格。
- 任务冻结额度后提交；正常 processing 不受一分钟确认窗口限制。结果不确定才进入 unknown，保存 `uncertain_since`，一分钟内尝试确认；有上游编号继续查询，没有编号绝不重复提交。
- 确认窗口超时自动失败，通过 `finish()` 释放冻结额度或恢复赠送额度。已退款任务不因上游迟到成功补扣用户。管理员人工“核实处理”流程已移除。
- `v1.0.84` 仅对已观察到的 Agnes 503 明确队列满、且无任务编号/结果数据的拒单立即退回。普通 503 或已接单任务查询出错仍走不确定流程，不能无条件立即退款。
- 再次创作/重新生成仅回填安全输入并重新报价，由用户确认后使用新的幂等编号；旧任务账单保留，防止连点。
- 用户任务接口仅返回安全输入、结果代理地址、重试和退款状态；不暴露渠道 ID、上游任务编号、成本快照或凭据。

## 上游额度显示的已知边界

RIPP/YYAPI 的 `/api/usage/token/` 返回当前 API Key 的配额，不是上游账户钱包余额；单位换算依赖 `/api/status` 的 `quota_per_unit`。代码已标记 `scope='api_key'`，负配额显示为超额使用而非账户欠款。用户上游后台有钱与 Key 配额不足可以同时成立。不能用这次标签修复声称账户钱包余额已对齐；必要时核对官方账户余额接口，不索要或暴露凭据。Agnes 余额接口目前未支持。

## 最近上游运行事件

- 2026-09-20 曾短时观察到 `molifangapi.com` 对 `gpt-5.6-sol`、`gpt-6-astra` 返回 403，应用因此对请求返回 503；该异常在后续十分钟复查时已停止。将来再次发生时先记录精确时间、模型和日志计数，复查近期 `usage_logs` 与本地日志；不要自行更换渠道、修改密钥、映射、价格或用户账务。
- 2026-09-20 18:00–18:10 CST 又观察到一段 `gpt-5.6-luna`/`gpt-5.6-sol` 的 502（摘要为所有上游渠道不可用），最近 15 分钟复查已恢复且出现 200。该类波动先作为上游瞬时故障记录，不自动切换渠道或改动账务。

## 验证与部署

1. 查当前 Git 状态、差异及线上两副本实际版本，保留无关修改。修改先做对应测试，并执行 `npm test`、`npm run typecheck`、`npm run build`、`git diff --check`。
2. 发布同步 `package.json`、`package-lock.json`、Compose 默认镜像版本；网站变化时更新首页静态资源版本。提交/标签/推送与生产部署是不同步骤，分别核验。
3. 生产部署前服务器内备份 PostgreSQL 和相关配置，限制权限并验证备份可读；不把备份或秘密复制到对话/Git。保留旧镜像，禁止 `docker compose down -v`。
4. 最近服务器没有 Git CLI；上次用本地已提交版本的 `git archive HEAD` 通过 SSH 同步，保留 `.env`、`secrets/`。不要假设服务器能 `git pull`。
5. 构建目标镜像，运行一次性 migration，再更新持久 `RELAY_IMAGE_TAG` 并 `docker compose up -d --no-deps --scale api=2 --wait api gateway`。确认 worker 后续使用同一目标版本。
6. 检查两个 API 版本和 healthy、Gateway/PostgreSQL/Redis、worker timer、最近脱敏错误；检查 `/healthz`、`/api/v1/health`、两域名首页、静态脚本版本及内容。
7. 真正出片、支付等业务成功要有相应验证证据；健康接口与模拟测试不等于业务端到端成功。

本机 `node/npm` 可能不在 PATH；已验证 Node/npm 目录：`/Volumes/brainos/MacStorage/Caches/node-v22.23.2/node-v22.23.2-darwin-arm64/bin`。`/usr/bin/git` 曾被 Xcode license 阻断，可用 `/Library/Developer/CommandLineTools/usr/bin/git`；不要替用户接受许可证。路径不可用时再定位 bundled runtime。

远程脚本中 `docker compose exec -T` 会读取 stdin。不要让 pg_dump 消耗承载后续脚本的 stdin；无输入操作用 `/dev/null`，验证备份从 dump 文件单独重定向。

## 用户偏好与维护约定

- 已授权范围内直接执行、验证并完成，不反复要求部署授权或恢复 SSH。遇到具体阻碍说明证据和原因。
- 收费测试遵守预算，所需付费资源/额度先说明。2026-09-20 的 ¥0.10、4 秒测试授权仅限一次，已使用；不是未来重复生成授权。
- 每小时巡检已有 automation `api-hhtc-top`：检查 SSH、CPU/内存/磁盘、Compose 与 worker、首页和接口、近期错误。连续正常保持安静，仅故障、修复、状态变化或需要用户处理时通知；不要重复创建自动化。
- 禁止在普通维护中修改媒体价格、渠道映射或用户账务，禁止破坏性数据操作；验证码、人工凭据、无法安全判断的项目暂停并明确报告。
- 记忆更新时分清稳定约定、历史验证、未解决事项；旧版本号和旧故障不能当作永恒状态。
