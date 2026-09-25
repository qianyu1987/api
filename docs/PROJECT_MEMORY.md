# GPT TOKEN / Relay Station 项目长期记忆

最后核对：2026-09-23。这是跨会话交接记录，事实来源为用户指令、当前源码、Git 和实际运维结果。动态状态以重新检查为准；最近发布证据见 [OPERATIONS_LOG.md](OPERATIONS_LOG.md)。

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

- 2026-09-25 CC Switch 曾因已打开会话携带 `gpt-6-sol` 而收到“未配置该模型价格”503。生产 `/v1/models` 非计费核验：有 `gpt-5.6-sol`、无 `gpt-6-sol`；本机“默认 Key”和 Codex 持久配置均为 `gpt-5.6-sol`，切回后代理请求连续 200。不要为修复拼写/会话覆盖而凭空复制价格或渠道映射；先使用模型目录中实际存在的 `gpt-5.6-sol`。
- 2026-09-25 `agnes-3.0-flash` 已可售卖并付费实测通过：`model_prices` 行售价=OpenAI gpt-5-mini 价目 1/3（83334/666667/8334 微元/M），成本=gpt-5-mini 1:1（250000/2000000/25000）；渠道 `Agnes 3.0` 的 `model_map` 已显式 opt-in（路由按 model_map JSONB 匹配，`channel_model_mappings` 表仅用于模型清单/价目初始化——新增渠道两表需同时配置）。公网 1 次最小请求 200，`usage_logs` 确认走 `Agnes 3.0`、扣款 9 微元；**当前成本按 OpenAI 价目 1:1 记账导致小额负毛利，Agnes 真实上游成本待用户提供后修正**。详见运维日志。
- 2026-09-24 新建渠道 `Agnes 3.0`（专用新 Key，AES 加密入库，可独立轮换/停用）：base_url `https://apihub.agnes-ai.com/v1`，prio 1000，启用；唯一映射 `agnes-3.0-flash -> agnes-3.0-flash`（启用）；审计 `config_audit_logs` 已记录（不含密钥）。变更前备份 `pre-agnes30-channel`。上游直连验证通过（models 200、最小 chat 200）。**未配置 `model_prices`：用户请求该模型暂 503"未配置价格"，补价后即可调用**；经 relay 的付费实测未做。详见运维日志。
- 2026-09-24 发布 `v1.0.90`（Laya 旁路接入）：两副本 healthy、migration 完成、worker timer active、无前端变更（`app.js?v=1.0.88`）。宿主桥接 + SSH loopback 转发 + api 只读 Unix socket 挂载链路实测打通，api-1/api-2 容器内 200/401/200 shadow（合成文本），SSH master 断开自动恢复。**`LAYA_SHADOW*` 环境变量为 0，开关保持关闭、未采集真实提示**；启用需用户指定管理员 Key 并写宿主 `.env` 后重启 api。独立 44 条代理自标注评测：任务类型 36.36%、工具需求 50%（`independent-report-20260924.json`），证实调参集 73.17% 属过拟合，不构成生产准确率证据。真实自动路由未实现、未启用。Mac 端传输监督进程（`tools/laya-shadow/transport_supervisor.py`，日志在 CodexMedia）在 Mac 重启/长时间睡眠后需重新启动；链路故障只影响 shadow 计数，不影响用户请求。详见运维日志与 `tools/laya-shadow/README.md`。
- 2026-09-24 后续实测：宿主机 Laya 隧道正常时，api-1/api-2 到各自 loopback 及 backend gateway 的 19092 均 ECONNREFUSED。下一步采用受限 Unix socket 转发/挂载方案，尚未实现；不应直接改为 Docker 网关 TCP 地址或声称容器已接通。

- 2026-09-24 已实测宿主机至 Mac 的临时 SSH 反向传输：服务器仅监听 `127.0.0.1:19092`，构造文本分类鉴权 401/200 正常，测试结束监听已移除。两个生产 API 仍为 v1.0.89 healthy。本证据不包括 API 容器接入、真实采样或部署；可复跑脚本 `tools/laya-shadow/probe_transport.py`，不产生付费请求。

- 2026-09-24 Laya 旁路本地代码已接入请求处理流程，默认关闭，仅允许显式指定管理员的单条纯文本，分类失败不进入转发/结算错误路径。9 项旁路测试及全量 234 项通过；尚未部署、未采集真实请求，私有传输和独立标注评测待完成。统计为副本进程内计数，不是准确率；真实路由未实现。详见 `tools/laya-shadow/README.md` 与运维日志。

- 2026-09-23 在本机 Apple M4 上验证 `laya-mlx` 0.2.0 与 multilingual MLX 检查点。2026-09-24 复跑扩大后的 41 条构造样例：任务类型 73.17%、工具需求 46.34%，文本类 13 条有 10 条误判 other。该集合含此前调参样例，不是独立评测或生产准确率。Laya 仍仅是本地研究原型，不得参与生产模型/渠道选择；线上旁路尚未实现。`tools/laya-shadow/` 源码现强制 loopback/bearer/单并发，支持加载外部评测 JSON 和保存无提示正文的报告；旧进程不代表新版代码已运行。运行时和权重不进仓库，具体证据见运维日志。

- 2026-09-23 修复新建 RIPP “优惠”渠道：后台地址误填为 `https://ripp.best`，请求命中网站 HTML 并被安全归类为 `upstream_invalid_content_type`，连续失败触发熔断。生产已改为 `https://ripp.best/v1`、清除该配置错误造成的熔断，并通过应用自身选路以不计费的 `/models` 请求确认 `gpt-5.6-terra` 返回 JSON。该 Key 的上游模型目录不包含 `gpt-5.6-luna`，因此已暂时移除 Luna 映射，不能宣称 Luna 可用；需上游为此 Key 开通并在模型目录中返回后再启用。
- 生产已于 2026-09-23 发布 `v1.0.88`，两个 API 副本和依赖健康，两域名加载 `app.js?v=1.0.88`。该版本包含 Responses 复杂输入兼容性保护、视频排队和账户历史充值显示；`v1.0.86` 镜像保留用于回滚。
- 2026-09-23 随后发布 `v1.0.89`：YYAPI/RIPP 返回图片 URL 时，Worker 会立即下载，限制 15 MiB，校验 HTTPS、公网地址、Content-Type 与 PNG/JPEG/WebP 文件签名，再写入 `media_task_assets`。下载暂时失败时进入一分钟确认窗口并仅重试保存结果，不重复生成；成功后用户结果接口读取持久化字节，不依赖临时 CDN。任务 `3c8ee4ac-83af-46f7-9049-49e09a6a057c` 已恢复为约 1.9 MB 的本地 PNG。

- 2026-09-20 13:29 UTC 查明 Luna 当前没有启用的 `model_map` 路由或通配映射，历史映射表两条记录也已停用；60 次 Luna 502 没有转发尝试。此前“最近十五分钟无 5xx”仅是流量窗口观测，不是 Luna 恢复证据。巡检不得擅自启用/更换映射，需用户确定支持范围和渠道。

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

### v1.0.87 变更边界

- 账户总览历史金额必须由 `/api/me/overview` 的只读聚合和首页 `app.js` 同步发布；“历史总充值额度”按钱包到账流水统计，“历史实付总额（含套餐）”按已支付钱包充值与套餐订单统计。账户接口使用 `private, no-store`，避免支付后旧缓存遮住新余额。
- 视频任务在上游队列满、429 或明确未接单时保持冻结并进入平台队列，30 分钟后才全额退款；已接单任务锁定渠道并在 45 分钟确认窗口内只查询原任务。生产验证不得重复提交付费视频。
- 用户模型售价不再按 272K 分层；活跃 `model_prices.pricing_tiers` 迁移为空。`channel_model_costs.high_context_multiplier_bps` 仍用于上游成本核算，历史 `pricing_snapshot` 不改。

本机 `node/npm` 可能不在 PATH；已验证 Node/npm 目录：`/Volumes/brainos/MacStorage/Caches/node-v22.23.2/node-v22.23.2-darwin-arm64/bin`。`/usr/bin/git` 曾被 Xcode license 阻断，可用 `/Library/Developer/CommandLineTools/usr/bin/git`；不要替用户接受许可证。路径不可用时再定位 bundled runtime。

远程脚本中 `docker compose exec -T` 会读取 stdin。不要让 pg_dump 消耗承载后续脚本的 stdin；无输入操作用 `/dev/null`，验证备份从 dump 文件单独重定向。

## 用户偏好与维护约定

- 已授权范围内直接执行、验证并完成，不反复要求部署授权或恢复 SSH。遇到具体阻碍说明证据和原因。
- 收费测试遵守预算，所需付费资源/额度先说明。2026-09-20 的 ¥0.10、4 秒测试授权仅限一次，已使用；不是未来重复生成授权。
- 用户已于 2026-09-23 取消每小时巡检 automation `api-hhtc-top`；不要自动重建。服务器内部 `relay-station-worker.timer` 属于应用维护任务，仍需保留。
- 禁止在普通维护中修改媒体价格、渠道映射或用户账务，禁止破坏性数据操作；验证码、人工凭据、无法安全判断的项目暂停并明确报告。
- 记忆更新时分清稳定约定、历史验证、未解决事项；旧版本号和旧故障不能当作永恒状态。
