# GPT TOKEN / Relay Station 项目长期记忆

最后核对：2026-10-03。这是跨会话交接记录，事实来源为用户指令、当前源码、Git 和实际运维结果。动态状态以重新检查为准；最近发布证据见 [OPERATIONS_LOG.md](OPERATIONS_LOG.md)。

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

视频 Key 的 `video_key_usage_daily` 是本站接单/预留账本，不是 Agnes 实时配额。Agnes 官方控制台以网页登录令牌读取 `platform-backend.agnes-ai.com/api/user/subscription`，视频用量在 `usage.video_generation.daily`；2026-10-03 以现有 API Key 对此接口的只读请求返回 401。官方 TokenPlan 文档规定同账号同类型 Key 共用额度池，不能用多个 Key 复制同一个账号的 500 秒。本站北京时间额度桶与上游实际重置窗口不能未经验证视为相同；失败任务是否被上游退秒尚未确认。

## 最近上游运行事件

- 2026-09-27 发布 `v1.0.95`：个人中心总览新增 Astra/Sol/Terra/Luna 的月卡 1:4、普通钱包 1:3、企业钱包 1:5 价格对比及北京时间当日调用/真实扣费；企业充值固定最低 ¥498、按 1:5 到账，倍率由服务端和订单快照决定；所有注册用户可保存独立站联系信息，管理员可只读查看线索。提交 `d51a708` 和标签已推送。生产备份 `/opt/relay-station-backups/pre-v1.0.95-enterprise-20260927T093754Z/` 已验证，迁移后 145 条历史订单均回填 `standard`，企业约束和线索表生效；两个 API 副本、Gateway、PostgreSQL、Redis 和维护 timer 正常。线上只创建一张 ¥498 的未付款企业订单验证 `¥498 -> ¥2490`，状态保持 pending、无支付时间和钱包到账，未发生真实支付。`/v1/models` 非计费核验 200 且四个目标模型仍在，四模型售价和真实路由未被本次发布修改。
- 2026-09-27 只读复核四个公开 GPT 模型：四条 `model_prices` 均启用，Astra/Sol/Terra 在最近 24 小时分别有 214/493/16 次成功请求；Luna 只有 2 次简单 `/chat/completions` 成功，同时 305 次复杂 `/responses` 因 `no_compatible_upstream` 被拒。Luna 仍只有“超稳定备用”映射到 `agnes-3.0-flash`，不是原生 Luna，只能用于无工具、无附件、无多轮状态的简单文本。对 10 个候选渠道的非计费 `/models` 探测均返回 200 JSON；其中“优惠”的 Astra/Terra 与“best”的 Sol 映射目标已不在当前目录，属于待清理的过期映射，其他原生主路由仍有近期 200。多数原生渠道尚未补齐可审计渠道级成本，不得把模型级 CSV 价格当成所有渠道成本已配置。此次未修改生产配置、路由、价格或账务，也未发起新的付费生成。
- 2026-09-25 发布 v1.0.92：修复 Luna 经 Agnes 备用处理 `/responses` 时上游生成 `stream=null` 的 400。现在平台先转换为 `/chat/completions`，仅转发合法布尔 `stream`，再将流式/非流式结果转换回标准 Responses。真实测试中 Terra 与 Luna 的非流式/流式请求均 200、返回 `OK`；Luna 初始失败账单为 0，成功请求分别独立结算。备份 `pre-v1.0.92-agnes-responses-20260925`，两个 API 副本及依赖健康。
- 2026-09-25 发布 v1.0.91：Terra 原生路由加入上游目录明确支持的 `稳定pro`、`高价稳定pro`，保留“优惠”及 Agnes 备用；Luna 没有原生上游，按公共低价档映射“超稳定备用”的 `agnes-3.0-flash`，且仅允许简单文本兼容降级。Terra/Luna 的 Agnes 渠道成本已按同一上游成本补齐，模型目录同时列出 Sol/Terra/Luna，两个 API 副本及依赖健康。发布前备份 `pre-v1.0.91-terra-luna-20260925`；未做付费生成测试。
- 2026-09-25 CC Switch 曾因已打开会话携带 `gpt-6-sol` 而收到“未配置该模型价格”503。生产 `/v1/models` 非计费核验：有 `gpt-5.6-sol`、无 `gpt-6-sol`；本机“默认 Key”和 Codex 持久配置均为 `gpt-5.6-sol`，切回后代理请求连续 200。不要为修复拼写/会话覆盖而凭空复制价格或渠道映射；先使用模型目录中实际存在的 `gpt-5.6-sol`。
- 2026-09-25 `agnes-3.0-flash` 已可售卖并付费实测通过：`model_prices` 行售价=OpenAI gpt-5-mini 价目 1/3（83334/666667/8334 微元/M），成本=gpt-5-mini 1:1（250000/2000000/25000）；渠道 `Agnes 3.0` 的 `model_map` 已显式 opt-in（路由按 model_map JSONB 匹配，`channel_model_mappings` 表仅用于模型清单/价目初始化——新增渠道两表需同时配置）。公网 1 次最小请求 200，`usage_logs` 确认走 `Agnes 3.0`、扣款 9 微元；**当前成本按 OpenAI 价目 1:1 记账导致小额负毛利，Agnes 真实上游成本待用户提供后修正**。详见运维日志。
- 2026-09-24 新建渠道 `Agnes 3.0`（专用新 Key，AES 加密入库，可独立轮换/停用）：base_url `https://apihub.agnes-ai.com/v1`，prio 1000，启用；唯一映射 `agnes-3.0-flash -> agnes-3.0-flash`（启用）；审计 `config_audit_logs` 已记录（不含密钥）。变更前备份 `pre-agnes30-channel`。上游直连验证通过（models 200、最小 chat 200）。**未配置 `model_prices`：用户请求该模型暂 503"未配置价格"，补价后即可调用**；经 relay 的付费实测未做。详见运维日志。
- 2026-09-26 Laya 线上影子观察**已启用**（代理按用户授权决定）：宿主 `.env` 追加 4 行 `LAYA_SHADOW*`（开关、socket 路径 `/run/laya-shadow/classifier.sock`、管理员 ID `9c95ea6c…43d0`、43 字符 token），api 两副本重建 healthy；仅观察默认管理员（"默认 Key" 属主，即本地 CC Switch 在用 Key）的纯文本单条请求 ≤2000 字，结果绝不进入路由/结算，文本不出 Mac。端到端实测 1 次（Luna 200、charge 3805 微元），Mac `classifier-events.log` 同秒出现分类事件，全链路闭环。变更前 `.env` 备份 `pre-laya-observe-20260925T232751Z`；`server.py` 新增逐事件日志（无 prompt 正文）。真实自动路由仍未实现。注意：`.env` 的 `ADMIN_PASSWORD` 与管理员 DB 密码哈希已不一致，`/api/admin/laya-shadow` 计数需真实管理员会话查看。详见运维日志。
- 2026-09-28 Laya v3 硬样本训练：以 v2 holdout 为基线加入 22 条人工核对边界样本，外部 44 条未核验集任务类型准确率 70.45%→77.27%，工具判断 81.82%→77.27%。v3 只作为本机候选保留；线上影子继续使用 v2，自动路由仍关闭。当前短板是工具需求标注不足与外部集来源未核验，不能把 v3 分数当生产准确率。
- 2026-09-28 Laya v4 工具需求样本训练：从 v3 候选加入 20 条人工核对工具需求边界样本，外部 44 条未核验集任务类型准确率 81.82%，工具判断 75.00%。v4 只作为本机候选保留；线上影子继续使用 v2，自动路由仍关闭。下一步需使用独立人工标注的平衡验证集分别校准两个判断头。
- 2026-10-02 Laya 灰度对照：按用户授权启动 v2 与 v4 的独立本机实例，使用同一临时鉴权和 8 条代表性请求做并行比较；v4 健康且任务类型判断未见异常，工具需求信号对“读取文件/图片/天气 API/发票”更积极，但这只是小样本观察，不能推翻独立集上 v4 工具判断 75.00% 低于 v2 的证据。生产 Unix-socket 影子服务继续保持 v2，未修改生产路由、计费、宿主 `.env` 或传输令牌；自动路由仍关闭。下一步是建立独立人工标注平衡集后再决定切换。
- 2026-10-03 Laya 平衡集复评：新建 40 条、五类任务各 8 条且每类工具需求真假各 4 条的初步人工标注集 `/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow/independent-balanced-cases-20261003.json`，同一批样本并行评测 v2 与 v4。v2 任务类型 52.50%、工具判断 60.00%；v4 任务类型 67.50%、工具判断 55.00%，热延迟中位数约 29 ms。v4 的任务类型有所提升但工具判断回退，且该集尚未由第二位人工复核，因此生产继续使用 v2，自动路由关闭；升级门槛仍需独立复核标签和工具判断不低于 v2。
- 2026-10-01 `gpt-6.1-sol` 已完成定价并公开：截图 Standard 原始单价 input `$2.5`、output `$15`、cache-read `$0.2`/百万 Token，按截图 `0.20x` 得有效成本 `0.5/3/0.04`；7 个原生渠道写入这些成本并按默认高上下文保护 1.20x。按最坏充值 1:5、最低毛利 30%、返利 10%、手续费 0% 向上取整，模型售价为 `5/30/0.4` 元/百万 Token。`model_prices` 已 active，公开 `/v1/models` 返回 200 且包含该模型。一次最小真实收费调用成功：请求 ID `126ab3cd-14b8-4a75-9059-05cb5270aa9d`，高速pro、HTTP 200、547 输入/5 输出/3840 缓存 Token，扣费 4421 微元、成本 443 微元、利润 3978 微元，单次上游尝试且只有一笔结算。未确认 272K+ 独立价格分档，未配置 cache-write 独立计价；变更前备份在本机 `/Volumes/brainos/CodexMedia/generated/gpt-token-gpt-6-1-sol-20261001/`。
- 2026-10-01 上游新增模型复核：高速pro返回 `gpt-6`，高价稳定pro返回 `gpt-5.5`/`gpt-5.6`，0.6/0.8/0.2/0.12 返回 `gpt-5.3-codex-spark`；`gpt-6-luna` 仍未出现。新 ID 没有完整独立成本/售价记录（`gpt-5.5` 仅有历史 manual 模型价格、无渠道成本），因此未添加映射或公开收费，待成本来源后处理。
- 2026-10-01 `gpt-5.6-luna` 已按用户要求下线：源码不再将其视为公开 Agnes 兜底模型，生产 migration 删除所有运行时映射、停用目录映射并将模型价格设为 inactive。历史价格、渠道成本、用量、转发尝试、预扣快照和审计保留；生产 v1.0.100 两副本及依赖 healthy，详见运维日志。
- 2026-10-01 `gpt-6.1-sol` 售价已按用户要求调整为 `gpt-5.6-sol` 网站售价的三分之一：输入/输出/cache-read 为 `15.533333/77.733333/1.566667` 元/百万 Token。仅更新模型级售价并写入审计，渠道成本、映射和历史账务不变；生产动态配置已生效，详见运维日志。
- 2026-10-01 `gpt-6.1-sol` 又按用户要求在当前价格基础上降低 35%，按变更前微元值乘 65% 并四舍五入后为输入/输出/cache-read `10.096666/50.526666/1.018334` 元/百万 Token。仅更新模型级售价及 per-million 别名并写入审计；成本、映射、历史账务和价格快照不变。生产 v1.0.100 两副本及健康接口仍正常，详见运维日志。
- 2026-10-02 Agnes 视频 Key 池已部署到生产 `v1.0.104`：独立视频渠道导航、加密 Key 配置、无计费 `/v1/models` 探测、北京时间每日额度、事务预留/释放/结算、按并发与延迟排序、队列和审计接口均已上线。当前 Key 数为 0，未执行真实视频生成。生产实际视频成本约 ¥0.025/秒，固定售价 ¥0.035/秒在当前 30% 毛利护栏下暂不可售；管理员页面和运行时报价均会阻止启用，待核实成本或调整售价后再加 Key。
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

## 价格与月套餐改造（实现与发布，2026-09-27）

- 新增渠道成本预览/事务发布代码：`src/services/pricing.ts`、`ChannelCostService.pricingPreview/publishPricing`，后台接口为 `/api/admin/pricing/preview` 和 `/api/admin/pricing/publish`。预览按启用渠道取最高成本；缺少有来源的渠道成本时发布整体拒绝。发布会记录价格来源、生效时间、成本快照和管理员审计，历史账单快照不变。
- 钱包价格护栏现在显式使用充值倍率、支付费和返利，最低毛利默认 5000 基点；生产当前设置/价格未因这轮本地改动而改变。旧 `/api/admin/bootstrap/openai-prices` 不再把未经实时核验的 OpenAI 快照直接写入价格表。
- `monthly-149` 的新订单快照包含 `reset_grant_limit=4`，新购买首发一次并在第 7/14/21 天各发一次；订阅记录 `reset_grant_count`，手动/worker 共用周期幂等键，第四次停止。旧订阅的 limit 保持 NULL 以保留既有规则。套餐使用成本可由 `/api/admin/profit/subscriptions` 按实际 usage 日志核算。
- 发布前本地验证：247 项测试、typecheck、build、diff-check 全部通过；生产已部署 `v1.0.93`。线上 `profit_min_margin_bps=3000`、返利 1000、支付费 0；6 个活跃模型价格未重算，按启用映射仍有 21 条渠道成本缺失。禁止在完成成本预览前发布价格或声称 ¥149/596 具备 50% 现金毛利。

远程脚本中 `docker compose exec -T` 会读取 stdin。不要让 pg_dump 消耗承载后续脚本的 stdin；无输入操作用 `/dev/null`，验证备份从 dump 文件单独重定向。

## 价格与月套餐改造生产发布：2026-09-27 CST

- 用户授权发布代码和月套餐规则。生产备份 `/opt/relay-station-backups/pre-v1.0.93-pricing-subscription-20260927/` 已验证可读（数据库 dump 约 530 MiB、`.env` 权限 0600）；旧 `relay-station:v1.0.92` 镜像保留。
- 发布版本 `relay-station:v1.0.93`。迁移首次因历史 schema 的 `media_tasks_queue_idx` 重复创建而回滚，随后将队列索引改为幂等创建并重建镜像；第二次迁移成功。该修复不删除数据或索引。
- 两个 API 副本、Gateway、PostgreSQL、Redis 均 healthy，`relay-station-worker.timer` active；内部 `/healthz`、`/api/v1/health` 及公网 `api.hhtc.top` 健康接口 200，`www.hhtc.top` 首页 200。未带 API Key 的 `/v1/models` 返回预期 401。
- 线上 `monthly-149` 已为价格 149、首发额度 149、`reset_grant_limit=4`（总额度 596）；5 个已有订阅仍为 `reset_grant_limit IS NULL`，保留旧规则。线上 `profit_min_margin_bps` 仍为 3000、返利 1000、支付费 0；6 条活跃模型价格未发布重算。
- 本地验证为 23 个测试文件/247 项测试通过，typecheck、build、diff-check 通过。此次只部署代码、迁移和套餐新购规则，未发布新模型价格、未改真实渠道/路由、未做付费业务请求。
- 未解决：按启用映射仍有 21 条渠道成本缺失；待后台补齐可审计来源并确认预览后，才能单独发布价格和 50% 毛利护栏。不得把当前价格称为 OpenAI 官方实时价格。

## v1.0.94 媒体修复与付费验证：2026-09-27

- 生产已运行 `relay-station:v1.0.94`，两个 API 副本 healthy。媒体 worker 的终态 SQL 不再把 `media_tasks.next_attempt_at` 写成 NULL；视频接单后保留合法下一次轮询时间，worker 异常继续记录真实错误。
- 付费图片验证通过：1K `gpt-image-2.5` 任务完成并持久化结果，扣费 500000 微元、成本 100000 微元；预扣/结算各一笔，无重复账单。
- 付费视频验证未出片：4 秒 `agnes-video-2.5-flash` 创建成功进入队列，但上游明确返回 `video queue is full`，无上游任务编号；重试后通过 API 取消，冻结额度全部释放。应用收尾和退款正常，视频上游恢复前不能称为已修复完成。
- 熔断窗口结束后的第二次 4 秒复测仍未接单，状态为 `no_compatible_channel`；5 次尝试后取消并全额释放冻结额度，未发生结算扣费。当前视频阻塞属于上游容量/渠道可用性，待上游恢复后再复测。
- 本地 23 个测试文件/247 项通过，typecheck、build、diff-check 通过。媒体修复备份为 `/opt/relay-station-backups/pre-v1.0.94-media-fix-20260927/`；价格发布仍受 21 条缺失渠道成本阻断，未修改价格或真实路由。

## 四模型 CSV 价格发布：2026-09-27

- 用户提供 `Sheet_20260927.csv`，生产已按其中“后台取整”更新模型级价格。输入/缓存读取/输出售价（元/百万 Token）：`gpt-6-astra` 116.6/11.7/583.0，`gpt-5.6-sol` 46.6/4.7/233.2，`gpt-5.6-terra` 23.3/2.3/140.0，`gpt-5.6-luna` 2.3/0.23/14.0；对应 CSV 成本也写入模型级成本字段。
- cache-write 没有独立的上游用量字段或站内账务列；其 CSV 数值只保留在 `price_source` 审计说明，不能声称平台按 cache-write 单独结算。渠道级实际成本和模型路由均未改动。
- 变更前备份 `/opt/relay-station-backups/pre-price-sheet-20260927/`；事务更新 4 行并写 4 条管理员审计。四模型 `/v1/models` 可见、HTTP 200，价格在充值 3 倍/返利 10%/支付费 0 下通过 50%现金毛利校验；两个 API 副本继续运行 `v1.0.94` 且 healthy。

## GPT-6 Sol、深夜折扣与 v1.0.97 发布：2026-09-27 CST

- 对 7 个现有 GPT 上游渠道做模型目录与最小调用核验后，新增可确认的公开模型只有 `gpt-6-sol`；未发现 `gpt-6-luna`、`gpt-6.0` 或其他可用 GPT-6 变体，禁止伪造别名或复制价格。`gpt-6-sol` 已在 7 个渠道同时写入运行 `model_map`、目录映射和渠道成本。
- 用户图片给出的最高档成本为输入 ¥8、输出 ¥30、缓存读取 ¥0.8 / 百万 Token。按生产最坏充值倍率 1:5、最低毛利 30%、返利 10%、支付费 0% 向上取整，站内售价为输入 ¥66.666667、输出 ¥250、缓存读取 ¥6.666667 / 百万 Token；价格、成本来源和管理员审计均已写入生产。
- 用户随后补充的 Standard 证据为官方标准输入 $2、输出 $10、cache-read 约 $0.2 / 百万 Token；超过 272K 后输入类（普通输入、cache-read、cache-write）按 2.0 倍、输出按 1.5 倍。由此换算的 Standard 272K+ 为输入 $4、输出 $15、cache-read $0.4、cache-write $5；Fast 272K+ 为输入 $8、输出 $30、cache-read $0.8、cache-write $10。当前生产已按 Fast 272K+ 的前三项最高成本设防，未因该补充证据改价或重启。用户提供的一次账单显示原始金额 $0.00140480、账户实际扣费 $0.00021072（约 0.15 倍），该单只能证明当次档位优惠，不能作为长期标准成本。
- 站内账务没有独立 cache-write Token 字段，现有 `high_context_multiplier_bps` 也只能表达统一高上下文倍率；因此不伪造第四类结算字段，cache-write 仅作为上游成本/来源审计信息保留。若未来要按输入类 2.0 倍、输出 1.5 倍分别自动核算，需要单独设计并验证字段、账单映射和迁移，当前不在生产变更范围内。
- 生产真实请求 `4f7121f0-d8ad-4a4a-b4d8-dd3b86490572` 返回 200、模型 `gpt-6-sol`，走“高速pro”；169 输入、5 输出、4224 缓存 Token，扣费 40678 微元、成本 4882 微元、利润 35796 微元。只有 1 次上游尝试、1 笔预扣和 1 笔结算，无重复流水。
- `v1.0.96` 新增北京时间每日 `[00:00,04:00)` 深夜 Token 折扣、用户中心突出卡片、倒计时和后台自助开关/百分比。折扣默认关闭且为 0%；仅作用于 Token 计费模型，不含图片/视频固定价。预扣时冻结售价与成本快照，结算不追溯重算。
- 利润护栏按最坏 1:5 充值、历史更高倍率、最低毛利、支付费、返利以及每个真实路由的标准/272K+最高渠道成本核算；缺成本或售价不安全时只撤回新增深夜折扣，不改变既有个人/全局折扣语义。生产目前仍有 19 条旧模型渠道缺有来源成本，另有 15 个旧模型输入/输出/缓存价格约束低于当前安全要求；后台安全上限因此为 0%，补齐成本后仍需重新核价才能启用非零全站深夜优惠。`gpt-5.5` 还有 active 价格但没有启用运行路由，属于待清理目录残留。
- `v1.0.97` 修复用户中心横向溢出和上游 `x-request-id` 覆盖本站账务请求 ID。提交 `d62b70d`、`aafb741` 及标签 `v1.0.96`、`v1.0.97` 均已推送 `origin/main`；本地 25 个测试文件/282 项通过，typecheck、build、前端语法和 diff-check 通过。
- 生产备份 `/opt/relay-station-backups/pre-v1.0.96-night-gpt6sol-20260927T110057Z` 已验证可读，旧 `v1.0.95` 镜像保留。当前两个 API 副本均为 `relay-station:v1.0.97` / package 1.0.97 且 healthy，Gateway、PostgreSQL、Redis 与维护 timer 正常；三个公网健康接口和首页均为 200，首页加载 `styles.css?v=1.0.97`、`app.js?v=1.0.97`。登录态桌面及 390px 手机检查均无页面横向溢出；手机端深夜折扣卡片完整显示。

## GPT-6 Sol Standard/272K+ 分层价格与 v1.0.99 服务档保护（2026-09-28 CST）

- `v1.0.98`/`v1.0.99` 已推送并部署到固定生产主机 `101.35.223.148`；两个 API 副本当前均为 `relay-station:v1.0.99`、healthy。`/healthz`、`/api/v1/health`、`hhtc.top` 健康接口及 `www.hhtc.top` 首页均已复核 200，首页静态资源为 v1.0.99。
- `gpt-6-sol` 生产模型行：Standard 成本 `2/10/0.2` 美元等价的输入/输出/cache-read（微元列 `2000000/10000000/200000`）；272K+ 成本按输入类 `2.0x`、输出 `1.5x`，并记录 cache-write，价格行的 272K+ 阈值为 `272001` Token。当前 272K+ 站内售价约为输入 ¥33.333334、输出 ¥125、cache-read ¥3.333334、cache-write ¥41.666667 / 百万 Token。
- 7/7 个启用 `gpt-6-sol` 渠道都有运行映射、带来源成本和 2/1.5/2/2 分层倍率；审计记录、模型价格与成本快照已核对。生产护栏仍为最低毛利 30%、返利 10%、支付费 0%，没有把全站目标改成 50%。其他模型的成本缺口仍存在，不能把本次 Sol 价格发布扩大解释为全站成本/利润完成。
- `v1.0.99` 在结算前拒绝 `service_tier=fast/priority` 以及未计价服务档请求头，返回 422 且不触发上游或账务；Fast/priority 未开放。站内尚无可证明独立 cache-write 实际用量结算的生产付费样本，不作超出字段能力的结论。
- 本地 25 个测试文件/291 项测试、typecheck、build、前端语法和 diff-check 通过。备份：`/opt/relay-station-backups/pre-v1.0.98-gpt6sol-tiered-20260927T233442Z/`、`/opt/relay-station-backups/pre-v1.0.99-service-tier-20260928T000800Z/`；镜像标签配置同步备份 `/opt/relay-station-backups/pre-v1.0.99-env-sync-20260928T163009Z/`。本轮未新增真实付费请求；如需新价格收费验收，须另行确认金额/预算。

## 用户偏好与维护约定

- 已授权范围内直接执行、验证并完成，不反复要求部署授权或恢复 SSH。遇到具体阻碍说明证据和原因。
- 收费测试遵守预算，所需付费资源/额度先说明。2026-09-20 的 ¥0.10、4 秒测试授权仅限一次，已使用；不是未来重复生成授权。
- 用户已于 2026-09-23 取消每小时巡检 automation `api-hhtc-top`；不要自动重建。服务器内部 `relay-station-worker.timer` 属于应用维护任务，仍需保留。
- 禁止在普通维护中修改媒体价格、渠道映射或用户账务，禁止破坏性数据操作；验证码、人工凭据、无法安全判断的项目暂停并明确报告。
- 记忆更新时分清稳定约定、历史验证、未解决事项；旧版本号和旧故障不能当作永恒状态。

## 2026-10-01 GPT TOKEN 控制台体验迭代：v1.0.101

- 本地工作树已完成钱包二维码右侧布局、“我的钱包”命名、首页“无限免费生图”展示文案、免费智能配额/快捷入口、短剧创作流程提示与任务进度、后台固定经营概览及四类标签分组等前端改进；套餐/企业充值支付结果在各自区域展示，倍率文案跟随服务端配置，支付轮询按结果容器隔离并保留到账核对异常状态，历史账单和接口未改动。
- 本轮不改变后端额度、支付、账务、媒体报价或数据库。提交 `d618011` 已推送 `origin/main`，镜像 `relay-station:v1.0.101` 已发布生产。生产备份位于 `/opt/relay-station-backups/pre-v1.0.101-console-20261001T002401Z/`，包含 PostgreSQL dump、`.env`、Compose 配置、旧镜像信息和源码归档；临时发布目录及上传归档已清理。
- 两个 API 副本为 `relay-station:v1.0.101` 且 healthy，Gateway、PostgreSQL、Redis healthy，`relay-station-worker.timer` active/enabled。`https://api.hhtc.top/healthz`、`https://api.hhtc.top/api/v1/health`、`https://hhtc.top/api/v1/health` 和 `https://www.hhtc.top/` 均已复核；线上资源为 `styles-extra.css?v=1.0.62`、`app.js?v=1.0.101`。未创建支付订单、未发起付费媒体或模型调用。

## 2026-10-01 短剧创作任务列表修复：v1.0.102

- 用户反馈短剧创作页在存在历史任务时显示 `rows.join is not a function`。根因是任务行数组在传给共享 `table()` 渲染器前被提前 `.join('')` 转成字符串；本次只移除该提前拼接，并加入源码回归断言，媒体报价、提交、轮询和账务接口未修改。
- 提交 `b8d4912` 已推送 `origin/main`，基于当前主分支 `v1.0.102` 构建并发布；同时保留已在主分支的 413 上游故障切换修复。发布前备份位于 `/opt/relay-station-backups/pre-v1.0.102-short-drama-20261001T013042Z/`，生产 `.env`、Compose 配置和旧镜像均保留。
- 两个 API 副本为 `relay-station:v1.0.102` 且 healthy，Gateway、PostgreSQL、Redis healthy，`relay-station-worker.timer` active/enabled。公网 `https://api.hhtc.top/healthz`、`https://api.hhtc.top/api/v1/health`、`https://hhtc.top/api/v1/health` 和 `https://www.hhtc.top/` 均返回 200；首页加载 `app.js?v=1.0.102`，线上脚本已复核任务行保持数组。25 个测试文件 / 293 项测试、typecheck、build、语法检查和 diff-check 通过。未创建支付订单、未发起付费媒体或模型调用。

## 2026-10-01 上游 413 故障切换：v1.0.102

- `a97458d` 将 HTTP 413 纳入渠道重试；413 不增加渠道故障计数或触发熔断，其他可用渠道仍可尝试。若所有渠道都拒绝该请求，relay 保留并返回最后的 413。请求体不会被自动缩小。
- 2026-10-01 只读确认 `www.hhtc.top` 当前与 `api.hhtc.top` 一样将 API 请求转发至 Relay Station：生产 HTTPS 虚拟主机将 `/` 代理到 `127.0.0.1:18082`，公网 `/healthz`、`/api/v1/health` 返回 Relay Station 健康响应，`/v1/models` 无 Key 返回预期 401。因此 v1.0.102 的 413 渠道重试覆盖 `www.hhtc.top/v1/responses`；未发 POST 或做付费验证。Fastify 请求体上限为 20 MiB、宿主 Nginx 和内部 Gateway 为 32 MiB，入口层拒绝不会进入渠道切换；若所有上游均拒绝请求体，仍需缩小请求或提高相应上游限制。
- 25 个测试文件 / 293 项测试、TypeScript 检查、构建和 `git diff --check` 通过。发布归档取当前 `origin/main`（`c1ff614`，包含 `a97458d` 与 `b8d4912`）并保存于 `/Volumes/brainos/CodexMedia/generated/relay-413-failover-20261001/relay-station-v1.0.102-current-main.tar.gz`。
- 生产备份 `/opt/relay-station-backups/pre-v1.0.102-413-failover-20261001T013222Z/` 的 PostgreSQL custom dump 为 340513324 字节，`pg_restore --list` 校验通过；另存生产 `.env`、Compose 配置、旧镜像信息及发布归档。发布后两个 API 副本均为 v1.0.102 且 healthy，Gateway、PostgreSQL、Redis healthy，worker timer active/enabled。三个公网健康接口均为 200，首页引用的 `app.js?v=1.0.102` 与本地文件 SHA-256 一致，容器编译产物已确认含 413 重试逻辑。
- 未发起真实大请求或付费模型调用。若请求仍大于所有已配置上游网关的限制，最终仍会返回 413；需压缩上下文/移除大日志或图片，或请相应提供商提高请求体限制。
- 2026-10-01 后续只读生产核验：`www.hhtc.top/`、`/login`、`/register`、`/app.js?v=1.0.102` 和 `/api/v1/health` 均返回 200；脚本 SHA-256 `e969374fb49785122ae8b53b0e5671f942125f1863587feb7f1c9186ea24d162` 与 `origin/main:public/app.js` 一致。当前工作区 `public/app.js` 含未发布聊天额度拦截，哈希不同，不可当成生产文件。无会话钱包下单与无认证媒体报价均返回 401，未创建订单或触发媒体供应商。匿名浏览器页面/响应检查与无 Key 的 20 MiB 入口边界测试不等于认证业务端到端、真实支付、媒体出片或上游 413 故障切换。
- 提供管理员测试账号后完成生产浏览器认证检查：登录、`/api/me/overview`、只读 `/api/admin/overview` 均返回 200，管理员导航与经营概览正常；退出后公开界面恢复，个人总览请求返回 401。未访问或调用后台写入操作，也未执行真实支付或媒体生成；未在记录中保存凭据或业务数据。

## 2026-10-01 聊天额度拦截：v1.0.103

- 提交 `bb748fe` 已推送 `origin/main`。前端在额度耗尽时同时拦截发送按钮、桌面 Enter 和脚本 `requestSubmit()`；服务端原有配额拒绝仍保留。HTTP 413 渠道故障切换回归也随本版本保留。
- 发布前备份为 `/opt/relay-station-backups/pre-v1.0.103-chat-quota-20261001T044353Z/`，PostgreSQL custom dump 为 340,533,393 bytes 且 `pg_restore --list` 通过；生产 `.env` 权限保持 0600，旧 `relay-station:v1.0.102` 镜像信息已保存。发布归档位于 `/Volumes/brainos/CodexMedia/generated/relay-station-v1.0.103/relay-station-v1.0.103.tar.gz`。
- `docker compose run --rm migration` 成功；生产两个 API 副本均为 `relay-station:v1.0.103` / healthy，Gateway、PostgreSQL、Redis healthy，`relay-station-worker.timer` active/enabled。`https://www.hhtc.top/healthz`、`https://www.hhtc.top/api/v1/health`、`https://api.hhtc.top/healthz` 返回 200；首页加载 `app.js?v=1.0.103`，线上脚本 SHA-256 为 `152c9e0e2b41c1c97c9c6b6a09c6a784e0687904862c1d1ebcea0abcb315e85d`，与源码一致。
- 管理员浏览器复核通过：登录、个人总览和只读管理概览均为 200，管理后台经营概览可见；退出后 `/api/me/overview` 返回 401。测试未执行后台写操作、支付、媒体生成或真实上游请求；未记录账号凭据或业务数据。
- 2026-10-03 生产 Agnes Key 状态：`www.hhtc.top` 管理后台新增并探测通过一个视频 Key，当前生产数据库复核为启用、允许视频生成、每日 500 秒、Asia/Shanghai、并发 1；未记录完整密钥。已创建 1 元微信充值订单但未观察到付款/到账，未提交视频任务。固定价 ¥0.035/秒 仍受成本护栏阻止，当前成本约 ¥0.025/秒且按最坏充值倍率计算的安全底价更高。
- 2026-10-03 本地修复遗留：视频报价、目录和后台概览现在优先使用视频 Key 的核实每秒成本，缺失时按订阅成本 ÷ 有效天数 ÷ 每日 500 秒向上取整，并保留媒体价格成本回退；相关视频 Key/媒体测试 54 项通过，typecheck/build 通过，尚未部署生产。
- 2026-10-03 `v1.0.105` 已部署到生产：视频 Key 成本摊销和毛利护栏修复已进入两个 API 副本，备份目录为 `/opt/relay-station-backups/pre-v1.0.105-cost-fix-20261003T072750/`，PostgreSQL dump 可恢复性已核验。Key 状态保持启用且探测通过；支付订单仍待用户扫码，未提交视频生成。
- 2026-10-03 真实支付核验成功：管理员以微信支付 ¥1.00，订单为 `paid`，按 1:3 钱包到账 ¥3.00，生产余额和支付流水一致。视频最短报价真实验证仍被最低毛利保护拒绝，未创建媒体任务或消耗上游视频秒数；完成视频验收前需核实成本或调整价格/护栏。
- 2026-10-03 Agnes 视频成本曾按 ¥0.02/秒的临时核实值录入，随后用户补充 Agnes Coding Plan 为 ¥30/月、每天 500 秒；下方订阅摊销口径取代该临时值。历史变更审计和数据库备份仍在服务器，未记录密钥。
- 2026-10-03 `media_prices` 曾同步为 ¥0.02/秒的临时成本值；该值随后依用户补充的月订阅口径更正，当前成本以每 Key `30 元 ÷ 30 天 ÷ 500 秒 = ¥0.002/秒` 计算。固定售价 ¥0.035/秒在 1:5 最坏充值倍率、10%返利、30%最低毛利下可售；10 秒价格 ¥0.35。历史账单和价格快照不回溯。
- 2026-10-03 线上成本口径复核：按用户补充的 Agnes Coding Plan 套餐，生产 Key 当前保存 `subscription_cost_micros=30000000`、`subscription_duration_days=30`、每日 `500` 秒，即 `15000` 秒/月，媒体成本按订阅摊销为 `2000` 微元/秒（¥0.002/秒）。`media_prices` 的 `normal_cost_micros` 与 `actual_cost_micros` 当前均为 `2000`，任务价格快照以该口径为准；此前 ¥0.02/秒的临时核实值不作为当前线上值。继续保留固定售价 ¥0.035/秒和现行利润护栏。
- 2026-10-03 真实视频验证最终状态：生产任务取得上游任务号后仍未能在 45 分钟确认窗口内查到结果，系统自动标记失败并释放用户冻结款；没有重复提交。Agnes 日额度保留已接受的 4 秒，另有 12 秒明确队列满预留被释放；任务当前失败，无结果文件。详见运维日志。
- 2026-10-03 v1.0.109 已发布：在额度桶事务锁后重新读取活动任务数，避免多 API 副本的并发槽位判断使用旧快照；新增 30 元/月、15000 秒/月的定价回归。当前生产 Key 每天 500 秒、订阅成本 30000000 微元/30 天、探测通过；媒体单秒成本 2000 微元、固定售价 35000 微元。按 1:5 充值、10%返利、30%毛利护栏计算底价为 16667 微元/秒（¥0.016667），报价通过，10 秒 ¥0.35。两个 API 副本 v1.0.109 healthy，公开健康接口 200；发布前备份及真实视频失败退款结果见运维日志。
- 2026-10-03 v1.0.110 已发布：视频 Key 表格将“重置今日额度”收进“更多”菜单，保持原因填写与审计要求；静态 JS/CSS 版本与生产一致。生产两个 API 副本 healthy，首页和健康接口 200，未登录 Key 管理接口 401。成本、售价、Key 与额度数据沿用 v1.0.109。

## 2026-10-03 视频额度重置修复：v1.0.111

- 修复已用额度无法在任务结束后通过受保护审计操作清零的问题：事务锁定 Key、额度桶和相关媒体任务；有活动任务或残留预留时仍拒绝，无活动任务时允许重置已用/预留/释放秒数，并把前后值及原因写入审计日志。
- 提交 `23f28df` 已推送 `origin/main`；本地 28 个测试文件 / 314 项通过，TypeScript、构建和 `git diff --check` 通过。发布归档为 `/Volumes/brainos/CodexMedia/generated/relay-station-v1.0.111-reset/relay-station-v1.0.111.tar.gz`。
- 生产备份 `/opt/relay-station-backups/pre-v1.0.111-quota-reset-20261003T121400Z` 已完成，PostgreSQL dump 可由 `pg_restore --list` 读取。两个 API 副本已部署 `relay-station:v1.0.111` 且 healthy，Gateway/PostgreSQL/Redis 正常，公网健康接口 200。
- 已按管理员授权在线刷新视频额度：审计前 `4/500` 秒、无预留；审计后 `0/500` 秒、剩余 `500` 秒。没有重新提交视频任务或修改价格、成本、Key。后续继续观察视频上游出片稳定性；本次额度刷新本身已完成并可审计。

## 2026-10-03 额度来源更正与本站账本核对：v1.0.112

- 用户指出上述 `0/500` 与上游不符。已确认 v1.0.111 只清零本站账本，不能重置或读取 Agnes 配额；此前“刷新完成”不得解释为已同步上游。按保留的任务接单秒数，后台核对已恢复本站 `4/500`、预留 0、本地剩余 496，审计为 `video_provider_key_usage_reconcile` 的 `0 -> 4`；这 4 秒仍不是已核实的 Agnes 扣秒量。
- 新增管理员 `POST /api/admin/video/keys/:id/reconcile-usage`，只补回漏记的接单秒数，保留预留、释放量及日上限，不减记、不截断、不修改账务。Key/概览/核对响应标注 `quotaSource=local_ledger` 和 `upstreamQuota.status=unknown`；后台显示“本站已接单”“本站可分配”“上游额度：未同步”，将重置按钮替换为“核对本站用量”。旧重置接口拒绝已有接单、活动任务或预留（409）。
- 视频 submitting/unknown 即使无上游任务号也不允许取消；预留必须成功绑定有效任务，否则事务回滚，防止已提交任务取消后漏记上游秒数。已有模糊超时后释放预留、普通配置编辑与接单的锁顺序仍需单独评估；不能称为所有上游账务行为均已验证。
- 提交 `5e64267` 已推送并部署 `relay-station:v1.0.112`。28 个文件 / 333 项测试、类型检查、构建、前端语法和 diff 检查通过；两个 API 副本及 Gateway/PostgreSQL/Redis healthy，三个公网健康接口 200，首页脚本为 v1.0.112。桌面 961px 和手机 390px 无页面整体横向溢出，后台按钮实测恢复用量。
- 生产备份 `/opt/relay-station-backups/pre-v1.0.112-quota-source-20261003T140058Z/`，PostgreSQL custom dump 267387074 字节且 `pg_restore --list` 可读；旧 v1.0.111 镜像、配置、源码归档保留。未提交新的视频任务、支付或模型调用；Key、价格与成本不变。仍未接通 API Key 可用的上游额度查询，需核对管理员提供的上游已用/剩余秒数和实际重置窗口。
