# 发布与问题交接记录

时间使用明确日期；本条生产证据来自 2026-09-20 本会话实际工具输出。以后追加新记录并更新当前状态，不覆盖历史。

## Laya-MLX 本地旁路可行性验证：2026-09-23

- 用户要求先试运行，再考虑参与 `api.hhtc.top` 的真实模型路由。本机 Apple M4、macOS 26.6.1、Python 3.12.13 已安装 `laya-mlx` 0.2.0、MLX 0.32.2 和 `aac6fef/laya-multilingual-mlx`；运行时与权重位于外置盘，不进入仓库或生产镜像。
- 固定 12 条中文业务样例中，原始标签的任务类型准确率 50%、工具需求准确率 41.7%；改成具体中文业务标签后为 66.7% 和 50%。预热后中位推理约 19.5 ms，说明性能合格但准确率不合格。
- 新增 `tools/laya-shadow/` 本地原型：默认只监听 `127.0.0.1:19091`，分类接口支持 bearer 鉴权，不记录提示内容；实际验证健康检查 200、无凭据分类 401、有凭据分类 200。服务测试后已停止。
- 未修改生产路由、渠道映射、价格、账务或服务器配置，未部署、未推送。除非后续使用真实脱敏样本达到另行确定的准确率门槛，否则不得让该结果影响真实选路。

## RIPP 优惠渠道修复与 v1.0.88 发布（2026-09-23）

- 新建“优惠”渠道保存为 `https://ripp.best`，缺少 `/v1`，导致 Luna/Terra 请求收到网站 HTML；应用记录为 HTTP 200 的 `upstream_invalid_content_type`，连续失败后渠道熔断。最近七天记录中 Luna 为无可用渠道 502，Terra 退到 Agnes 后出现 Responses 400。
- 不计费能力探测确认 RIPP `/v1/models` 返回 JSON并包含 `gpt-5.6-terra`，但不包含 `gpt-5.6-luna`。生产事务内将地址修正为 `https://ripp.best/v1`、清除错误熔断、暂时移除 Luna 映射，并写入不含密钥的配置审计。应用自身选路再次请求模型目录，确认走“优惠”渠道、HTTP 200、Terra 存在、Luna 不存在。
- 修改前备份 `/opt/relay-station-backups/pre-ripp-route-fix-20260923T115015Z`，PostgreSQL dump 已通过 `pg_restore --list` 验证，配置归档仅留服务器受限目录。没有输出密钥，没有发起付费生成请求，没有修改售价或用户账务。
- 发布提交 `9161385`、标签 `v1.0.88`；本地 20 个测试文件 / 223 项通过，typecheck、build、`git diff --check` 通过。生产 migration 完成，两个 API 副本均为 `relay-station:v1.0.88` 且 healthy，Gateway/PostgreSQL/Redis healthy、worker timer active。
- `https://api.hhtc.top/healthz`、`/api/v1/health` 均 200；`api.hhtc.top` 与 `www.hhtc.top` 都加载 `app.js?v=1.0.88`，账户页包含历史总充值 DOM。保留 `v1.0.86` 镜像作为回滚。副本重建当分钟出现三条 Gateway 连接中断，属于发布切换窗口，需以切换后的持续日志复查为准。
- Luna 仍不可用不是本地路由故障：当前 RIPP Key 的模型目录没有该模型。上游开通前不要重新添加映射。

## 图片结果持久化修复 / v1.0.89（2026-09-23）

- 用户报告任务 `3c8ee4ac-83af-46f7-9049-49e09a6a057c` 的结果接口返回 502。任务已完成且 YYAPI 临时 PNG 外链仍可从服务器读取，但结果代理只允许 Agnes 域名，数据库也没有 `media_task_assets`，所以安全域名检查主动拒绝该 CDN。
- 已下载并校验该任务的 PNG 文件头、Content-Type 和大小，在事务中写入 `media_task_assets`，将结果切换为 `stored://media/...`。恢复后记录为 `image/png`、1,981,481 字节，PNG 签名有效；未重新生成、未重复计费。
- `v1.0.89` 修改图片 Worker：URL 结果立即下载并持久化，限制 15 MiB，只接受公开 HTTPS 且 Content-Type 与 PNG/JPEG/WebP 文件签名一致。首次下载失败时保留原结果地址并进入一分钟自动确认，只重试下载，不重复调用生成上游；超过窗口仍失败则沿用既有退款事务。
- 本地 20 个测试文件 / 225 项通过，typecheck、build、`git diff --check` 通过；提交 `6d841e9`、标签 `v1.0.89`。生产 migration 完成，两个 API 副本均为 `relay-station:v1.0.89` 且 healthy。

## 待发布变更：v1.0.87（2026-09-21）

- 根因核对：生产 `v1.0.86` 的首页脚本没有账户总览历史统计 DOM/渲染；本地未发布代码才包含该字段。因此用户看不到历史总充值，不是账务汇总 SQL 缺失。
- 账户总览将明确显示“历史总充值额度”（钱包实际到账累计）和“历史实付总额（含套餐）”；后台用户列表拆分显示历史实付、累计到账额度和可用余额。统计只读，不改余额或历史流水，并对账户接口设置 `private, no-store`。
- 本版本同时包含视频排队、渠道切换/熔断、未知结果确认窗口和安全错误归类，以及 Responses 复杂输入兼容性限制；用户销售价格层迁移为空，保留上游高上下文成本倍率和历史账单快照。
- 本地验证已完成：20 个测试文件 / 222 项通过，`npm run typecheck`、`npm run build`、前端语法检查和 `git diff --check` 通过。生产备份已创建，尚未将本条视为部署证据。

## 最近验证状态：2026-09-20 / v1.0.86

- 用户要求把套餐也计入实付总额：增加 `total_paid_micros`，合计已支付的钱包充值与两种历史套餐订单类型。原钱包充值字段保留；前端“实付总额”使用新字段并说明统计口径。仅更改只读统计与显示，不改账务。
- 应用提交 `0bf9b7f`，标签 `v1.0.86` 已推送并部署到固定生产机。222 测试、typecheck、build、前端语法、diff --check 通过；只读 SQL 样例覆盖混合购买、仅套餐、无订单、未支付排除、实付字段优先；页面样例验证充值 100 + 套餐 149 显示实付总额 249。
- 备份 `/opt/relay-station-backups/pre-v1.0.86-20260920T123226Z`，dump 可读校验通过，配置留在服务器受限目录；保留 `v1.0.85` 与 `rollback-pre-v1.0.86` 镜像。
- 两 API 副本 v1.0.86 healthy，Gateway/PostgreSQL/Redis healthy、worker timer active。两域名首页与健康接口 200、未登录管理接口 401、静态脚本与本地一致。生产镜像内只读验证 49 个用户的新实付字段与独立已支付订单汇总全部相等。未操作登录浏览器。

## 巡检发现 Luna 无可用映射：2026-09-20 13:29 UTC

- 本轮最近一小时，`gpt-5.6-luna` 有 60 次 502（12:59:51–13:06:29 UTC），错误代码 upstream_unavailable，未产生对应转发尝试。当前所有渠道 `model_map` 均无该模型或通配映射；映射表中的两条历史 Luna 映射均停用。源码按 `model_map` 选路，无候选渠道时失败。不能将无近期流量解释为 Luna 已恢复。
- 同期其他模型渠道出现 provider_access 403、少量超时和 503；最近十五分钟 Sol/Astra 均有成功记录（复查 41/14 次），未观察到新 5xx。Luna 最近成功记录停留在 2026-09-05，需管理员决定是否提供此模型以及使用哪个已验证渠道。
- 固定生产机 SSH 正常，v1.0.86 双副本、依赖和 worker 健康；CPU 空闲 98%，可用内存约 6 GiB、磁盘可用约 53 GiB。两域名首页/健康/静态正常，未登录受保护接口 401；支付缺失到账记录、超时 unknown、过期提交租约均为 0。
- 一次 Gateway premature-close 在 12:34:31 UTC，位于已完成的 v1.0.86 容器更新时段；当前公网正常。未修改映射、价格、密钥或账务，未付费测试，未重新部署。Luna 映射调整超出巡检授权，报告待用户决定。

## 历史验证状态：2026-09-20 / v1.0.85

- 用户要求后台用户列表展示总充值额度和可用余额；应用提交 `81b72c5`、标签 `v1.0.85` 已推送 GitHub，部署至 `101.35.223.148:/opt/relay-station`。
- 新增累计充值额度（`wallet_topup` 流水累计实际到账，保留历史倍率），附实付金额（已支付钱包充值订单）；可用余额主显为钱包余额减冻结余额。套餐、返利和手工调账不计为钱包充值；只读展示，不改账务。
- 222 项测试、typecheck、build、前端语法、git diff --check 通过；额外执行页面金额样例（实付 100、到账 300、钱包 90、冻结 10、可用 80）和空钱包检查。生产部署前后只读运行用户列表查询，49 个用户的累计金额字段全部有效。
- 备份 `/opt/relay-station-backups/pre-v1.0.85-20260920T121904Z`（数据库 dump 已校验、配置受限保存在服务器），保留 `v1.0.84` 及 `rollback-pre-v1.0.85` 镜像。
- 两 API 副本均为 `relay-station:v1.0.85` 且 healthy；Gateway/PostgreSQL/Redis healthy，worker timer active。两个域名首页、健康接口 200、未登录管理接口 401，线上 `app.js?v=1.0.85` 与本地逐字节一致。页面渲染函数金额检查通过；本轮未操作登录浏览器。

## 历史验证状态：2026-09-20 / v1.0.84

- 应用提交 `9cf6f12`，版本/标签 `v1.0.84`，已推送 GitHub `qianyu1987/api` 的 `main` 和标签。后续仅文档提交不代表镜像版本变化。
- 已部署 `101.35.223.148:/opt/relay-station`；API 两副本镜像均为 `relay-station:v1.0.84` 且 healthy。Gateway、PostgreSQL、Redis healthy，`relay-station-worker.timer` active。
- `https://api.hhtc.top/healthz`、`/api/v1/health`、首页及 `https://www.hhtc.top/` 均返回 200；两个首页引用 `app.js?v=1.0.84`，线上脚本内容与本地一致。
- 完整测试 20 文件 / 222 测试通过；类型检查、构建、`git diff --check` 通过。新镜像内使用模拟上游响应验证队列满立即失败分支通过，无上游调用/生产钱包写入。部署后抽查 API 最近错误为 0。
- 生产备份：`/opt/relay-station-backups/pre-v1.0.84-20260920T080133Z`；包含经 `pg_restore --list` 验证的 dump 与应用配置归档。配置备份含敏感内容，仅留服务器受限目录，不读取到输出。
- 回滚保留镜像 `relay-station:v1.0.81` 和 `relay-station:rollback-pre-v1.0.84`。未删除数据库或旧镜像。

## 上游聊天渠道短时异常：2026-09-20 17:31 CST

- 本小时早段观察到面向 `molifangapi.com` 的聊天请求出现 HTTP 403，并使应用向调用方返回 503；影响模型包括 `gpt-5.6-sol` 和 `gpt-6-astra`。另有少量 `x.ailzd.com` 超时记录。
- 随后复查最近十分钟，两个上游均未再出现对应 403/超时，应用日志以 200 为主；使用记录中 `gpt-6-astra` 有 6 次成功、1 次失败。未部署、未触发付费测试、未修改渠道密钥、模型映射、价格或用户账务。
- 当时生产仍为 v1.0.84：两 API 副本、Gateway、PostgreSQL、Redis healthy，worker timer 运行成功；DNS 和两个域名的首页、`/healthz`、`/api/v1/health` 均为 200。此结论只表示故障停止出现，不代表已验证渠道方的认证/权限配置已永久恢复。

## 上游不可用短时波动：2026-09-20 18:00–18:10 CST

- 只读审计显示最近 90 分钟曾有一小段 `gpt-5.6-luna`（10 条）和 `gpt-5.6-sol`（4 条）请求返回 502，错误摘要为“所有上游渠道不可用”；转发记录中可见 `best` 渠道的 503。最近 15 分钟 14 条请求中 8 条成功、0 条 5xx，随后抽查的 `/v1/responses` 已返回 200。
- API 两副本、Gateway、PostgreSQL、Redis 与 worker 仍 healthy；健康接口、首页和静态 `app.js?v=1.0.84` 均为 200。未修改渠道密钥、渠道映射、价格、媒体配置或用户账务，也未重复发起生成测试。
- 该波动视为上游瞬时不可用，需在再次持续出现时再由渠道方或用户处理；当前没有安全的本地自动修复动作。

## 视频无法生成：根因已确认，出片能力仍受上游限制

- 用户截图显示视频“自动确认中、冻结中”，之后自动退回额度。最近失败任务没有上游任务编号，数据库视频映射指向 Agnes，无错误映射证据。
- 上游 `/v1/models` 鉴权成功，列出视频模型；不代表生成可用。
- 用户明确批准一次 4 秒测试、上游预算 ¥0.10、不扣用户钱包。只提交一次，返回 HTTP 503：`video queue is full, please retry later`，无任务编号；没有成功出片。未重复测试，没有扣用户钱包；未核实供应商最终是否记费，不宣称上游费用为零。
- `v1.0.84` 修复明确队列满拒单后的错误提示与退款等待；不会解决供应商容量。普通 503、提交结果不明和已接单轮询失败仍保持安全确认语义。
- 下次验证优先无付费状态/文档/已存在任务查询；新的收费生成需新预算授权。不要复活已退回任务或补扣用户，也不要自动更换渠道/模型。

## 最近代码历史与部署区分

| 提交 | 日期 | 内容与证据边界 |
| --- | --- | --- |
| `1eb82c6` | 2026-09-19 | v1.0.72 媒体 API 与 Agnes 更新 |
| `f24e433` | 2026-09-20 | 订单到账核对、媒体失败/退款与相关 schema/测试 |
| `ef5e79c` | 2026-09-20 | 历史 unknown 任务恢复 |
| `5493f43` | 2026-09-20 | `/api/v1/health` 兼容健康接口 |
| `396f3e0` | 2026-09-20 | 微信遗漏支付主动补查与应用/worker 接入 |
| `087fb26` | 2026-09-20 | v1.0.82，RIPP/YYAPI Key 配额标签及支付刷新 |
| `9cf6f12` | 2026-09-20 | v1.0.84，明确视频队列满拒单退款、渠道检查、固定 SSH 说明 |

本次部署前线上是 v1.0.81，本地 HEAD 为 v1.0.82、工作区预备 v1.0.83；不能把这些当作已经部署。本次最终部署的是 v1.0.84，包含上述此前已提交更改。

## 后续待验证事项

- 视频供应商恢复后仍需要新的授权测试成功出片，才能关闭“不能生成视频”问题。
- RIPP/YYAPI 账户钱包金额与 Key 配额不同；当前已修正标签，没有验证账户钱包余额接口。
- 用户所报具体充值订单是否全部到账，不能仅凭本次代码部署/健康检查断言；本次未创建真实支付单、未人工改账。
- 增强图片 gpt-image-2.5 的 4K 尚未核实，当前应用仅开放 1K。
- 前序交接提及订单查询 `pe.created_at` 不存在的旧错误；本次源码搜索未发现该引用，未单独复现，勿直接重做修复或称其已完成业务验证。
- 镜像构建时 npm 报告生产依赖 1 high / 2 critical；本轮没有修改依赖。后续需核对公告与可达性后独立处理，勿自动执行破坏性 `npm audit fix --force`。

## Laya 本地评测可复现与接口边界修复：2026-09-24 CST

- 本轮仍限本地原型，未采集网站提示、未部署线上旁路、未改变模型/渠道/费用。生产版本未在本轮重新核验，不能将历史 v1.0.89 当作本轮上线证据。
- 41 条 agent 构造的中文 smoke 样例（含此前调参样例）复跑：任务类型 30/41（73.17%），工具需求标签 19/41（46.34%），预热中位 19.3 ms。文本类 13 条中有 10 条误判 other；不是独立留出集，也不是生产准确率。工具需求标签仍有产品能力语义歧义。
- `evaluate.py` 增加外部 JSON 样例加载、数据及问题哈希、无提示正文的 JSON 报告、单样例延迟处理；外部输入默认标为来源未核验，不自动视为独立评测。报告保存 `/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow/smoke-report-20260924.json`。
- 本地 HTTP 源码改为强制 bearer token、强制 loopback、串行 MLX 推理、5 秒 socket 超时，修复数组/null JSON 导致异常，并取消含任意请求路径的访问日志。尚未声称已替换此前运行中的服务；这些限制不等于生产入口加固完毕。
- 4 项本地 HTTP 测试通过，覆盖鉴权、非法输入、繁忙、失败后释放和不安全启动拒绝；项目 20 文件/225 测试、typecheck、build、diff --check 通过。工具仍为未提交本地文件，未推送。
- 待完成：独立样本及标注审查、默认关闭的线上旁路实现与隔离验证。前序提出的实际请求采集范围尚未得到明确回复，本轮未进行真实提示传输。真实自动路由继续关闭。

## Laya 默认关闭的旁路代码接入：2026-09-24 CST

- 新增 `src/services/laya-shadow.ts`，在正常预扣成功后发起不等待结果的分类观察。仅指定管理员 API Key 的单条纯文本请求，限 2000 字；排除历史、工具、附件、未知字段。普通用户不采集，开关默认关闭，结果不传给渠道或计费服务。
- 每副本最多 1 个在途请求，750 ms 总超时，结果限 16 KiB，无队列、无重试，不保存提示正文。目标仅允许 loopback `/v1/classify`、显式配置 32 字符以上 token 和管理员 ID。新增管理员统计接口，只返回本副本进程内计数，不表示准确率，重启清零。
- 新增 9 项测试，包含旁路挂起时正常请求仍返回 200、模型和原始请求不变、原渠道结算一次，以及默认关闭、非管理员排除、超时、过大/异常返回、未登录统计 401。21 文件/234 测试、typecheck、build、diff --check 通过。
- 本轮仅本地代码，未提交/推送/部署，也未设置生产开关或采集真实提示。Mac 到生产两个 API 容器的私有传输尚未实现；容器 loopback 不是 Mac 地址。下一步先验证传输及生命周期，实际采集范围沿用前序待明确项。独立标注评测仍待完成，真实自动选路没有实现也未启用。

## Laya 服务器至 Mac 临时私有传输实测：2026-09-24 CST

- 使用固定密钥成功连接 `101.35.223.148`，主机名 `VM-0-7-centos`，两 API 副本实测仍为 `relay-station:v1.0.89` 且 healthy。未重新发布、未重启服务、未修改数据库、渠道或账务。
- 新增可复跑的 `tools/laya-shadow/probe_transport.py`，在 Mac 启动新版强制鉴权分类服务，随机凭据仅驻留内存，通过 SSH 反向转发临时绑定服务器 `127.0.0.1:19092`。发送构造文本前核验实际监听地址，不修改 SSH 配置，不开放公网入口。
- 实际远程分类：错误凭据 401，正确凭据 200 / mode=shadow，构造编程文本分类 coding，单次本地推理 57.8 ms（不是完整网络延迟或准确率指标）。随后关闭 SSH 隧道，服务器监听已消失，本地探测服务也已关闭。
- 4 项本地 HTTP 测试及 diff --check 通过；本轮未更改 TS 应用代码，沿用上一轮 234 项回归结果。未采集网站提示，未调用收费上游。
- 证据边界：仅验证服务器宿主机到 Mac 的临时传输，尚未接到两个 API 容器；不能称线上旁路已部署。下一步实现容器可访问且隔离的传输及重连/断线验证，独立标注评测继续待办。真实路由保持未实现/未启用。

## Laya 双副本网络隔离验证：2026-09-24 CST

- 增强临时探测脚本，在宿主机鉴权隧道打开期间，从 api-1/api-2 分别请求容器 loopback 和实际 backend gateway 的 19092 健康接口；四次均 ECONNREFUSED。宿主机同期分类仍为无有效凭据 401、有凭据 200/shadow，证明当前隧道仅宿主机可达，不能直接用于 API 容器。
- 本轮构造文本推理 50.9 ms，不作为准确率或端到端延迟；无真实提示采集。隧道关闭后监听消失，未改生产网络、SSH 配置或 API 进程。初始临时 shell 命令因 rm 清理方式被自动检查整体拒绝，随后使用已有鉴权脚本完成安全探测。
- 后续方案：独立受限目录下的 SSH Unix socket 转发，API 只读挂载目录并使用 Unix socket HTTP dispatcher。尚未实现/部署，需检查权限、重连、挂载和两个副本，不能将本轮负向隔离测试称为容器接入成功。
- 本地 HTTP 4 项测试与 diff --check 通过；未修改 TS 应用代码。独立标注评测仍缺，线上旁路及真实自动路由均未启用。

## Laya v1.0.90 旁路试运行接入发布：2026-09-24 CST

- 发布提交 `db1ae30`（标签 `v1.0.90`，main 后续工具修复提交 `e38d65f`、`1de9212`、`316bb1c` 等均已推送；tools/ 不进容器镜像，不影响已部署行为）。本地 22 文件/235 测试、typecheck、build、`git diff --check` 通过。
- 代码边界：`src/services/laya-shadow.ts` 默认关闭，仅观察显式指定管理员的单条纯文本（≤2000 字），每副本至多 1 个在途、750 ms 截止、16 KiB 上限，结果绝不进入路由或结算；`src/config.ts` 仅接受 `LAYA_SHADOW_SOCKET_PATH=/run/laya-shadow/classifier.sock`（或 loopback URL）+ ≥32 字符 token + 显式管理员 ID；compose 仅给两个 api 副本 ro 挂载宿主 `/opt/laya-shadow`。
- 部署前备份 `/opt/relay-station-backups/pre-laya-v1.0.90/`：545M 文本 dump（41 张 CREATE TABLE + 41 COPY + 完整尾部）与 `.env` 归档（0600）；保留 `relay-station:v1.0.89` 回滚镜像。
- 部署：migration 完成；两副本 `relay-station:v1.0.90` healthy；Gateway/Postgres/Redis healthy；`relay-station-worker.timer` active；`/healthz`、`/api/v1/health`、两域名首页 200；静态脚本保持 `app.js?v=1.0.88`（本次无前端变更）；`/api/admin/laya-shadow` 未登录 401。宿主 `.env` 中 `LAYA_SHADOW*` 变量为 0，**开关保持关闭、未采集任何真实提示**；采样范围（指定管理员 Key）仍待用户确认。

## Laya 宿主 Unix-socket 传输与独立评测：2026-09-24 CST

- 传输链路（全部实测）：Mac 分类器 `127.0.0.1:19091`（loopback）→ SSH `-R 127.0.0.1:19093`（宿主 loopback）→ 宿主 stdlib 桥接 `tools/laya-shadow/laya_shadow_bridge.py`（root 运行、每周期重启，socket `/opt/laya-shadow/classifier.sock` 0600→`chgrp 1000`+group-writable）→ 两个 api 副本 ro 挂载 `/run/laya-shadow` → undici Unix-socket dispatcher。宿主 OpenSSH 7.4p1 实测无法直接 -R 绑定 Unix socket（`remote port forwarding failed for listen path`），故引入宿主桥接；未新增公网或 Docker 网桥 TCP 入口，未改 SSH 配置。
- Mac 端 `transport_supervisor.py`（当前以 setsid 脱离运行；日志 `/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow/transport.log`）负责分类器、宿主桥接、SSH master、重连与权限修复，每 5 秒探测分类器端口，任一环节死亡后自动重建并整链路再验证。宿主侧验证：`/healthz` 200、无凭据 401、凭据 200/shadow；随后 **api-1 与 api-2 容器内**经 Unix socket 实测同样 200/401/200 shadow（合成编程文本，分类 coding；容器内 139.7/34.7 ms 为含网络往返的参考值，非端到端延迟指标，更不是准确率）。杀掉 SSH master 后监督进程自动恢复（日志 `transport_ready` attempt 2）。全程未传输真实用户提示，未发起任何付费请求，未改动渠道、价格、账务。
- 本地 Python 10 项测试（SSH 参数/宿主命令构造、验证脚本不打印 token 不变量、Unix-socket HTTP 往返、桥接命令自检）通过。
- 独立评测：新构造 44 条样例（与前调参 41 条互不相交，代理自标注，非人类独立标注）：任务类型 36.36%（16/44）、工具需求 50.00%（22/44），中位推理 16.9 ms；20 条 text 中 15 条误判 other，15 条需工具的正样本误判为不需要。报告 `/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow/independent-report-20260924.json`（数据集 sha256 见报告）。该结果进一步证实调参集上的 73.17% 属过拟合；**仍不得作为生产路由依据**。
- 三态区分：本地原型=完成且运行中（Mac 分类器+监督进程）；线上旁路=接入完成并双向验证、开关关闭、零真实提示；真实自动路由=未实现、未启用。启用观察需用户指定管理员 Key 并向宿主 `.env` 写入 `LAYA_SHADOW_ENABLED=true`、token、管理员用户 ID 与 socket 路径后重启 api。

## Agnes 3.0 新渠道（专用 Key）：2026-09-24 CST

- 用户提供新 Agnes Key（`sk-...9sr`，仅命令内使用，未写入报告/Git）与模型 `agnes-3.0-flash`。直连验证：`/v1/models` 200（12 个模型，含 agnes-3.0-flash），最小 chat 1 次 200（prompt 81 / completion 2 tokens，成本可忽略）。
- 按用户选择"新 Key 单独可审计、可轮换"：事务内新建渠道 `Agnes 3.0`（id `dbd82ed7-5d41-47f8-b257-6c1fceeaf4c7`，`https://apihub.agnes-ai.com/v1`，prio 1000，启用；Key 经应用自身 `encryptSecret` 加密入库并往返校验），映射 `agnes-3.0-flash -> agnes-3.0-flash`（启用），并写 `config_audit_logs`（不含密钥）。
- 变更前备份 `/opt/relay-station-backups/pre-agnes30-channel/db.sql`（545M，41 表 + 完整尾部）。
- 验证：渠道/映射/审计三行独立复查通过；应用路由视图已含该渠道（按请求实时读取，无需重启）；两副本 v1.0.90 保持 healthy。
- 边界：未新增 `model_prices`，用户直接请求 `agnes-3.0-flash` 仍会 503"管理员尚未配置该模型价格"——售卖价格与成本待用户确定后补价即可调用；未做经 relay 的付费实测（前序授权已用尽）。

## Agnes 3.0 渠道补价与付费实测：2026-09-25 CST

- 用户指令"测，按 OpenAI 价目表三分之一补价"。以 `gpt-5-mini`（$0.25/$2/$0.025 每百万 tokens，OpenAI 价目表内置映射）为基准：新 `model_prices` 行 `agnes-3.0-flash` 售价 = 1/3 基准（input 83334 / output 666667 / cache 8334 微元/M，向上取整），成本 = 基准 1:1 结算（250000 / 2000000 / 25000 微元/M），fx 1:1，active；审计写 `config_audit_logs`。首次事务因 JSON 引号失败已回滚，重试成功。
- 首次付费请求 502"当前模型没有已启用上游渠道"：路由按渠道 `model_map` JSONB 逐模型显式 opt-in（`supportsRequestedModel`），`channel_model_mappings` 表只用于模型清单/价目初始化。修复：`Agnes 3.0` 渠道 `model_map={"agnes-3.0-flash":"agnes-3.0-flash"}`，审计已记。
- 付费实测 1 次（用户授权）：经公网 `https://api.hhtc.top/v1/chat/completions`，管理员 API Key 由应用自身解密恢复（明文仅存于内存/命令变量，未落日志/报告/Git）。结果 HTTP 200，model 回显 agnes-3.0-flash，81 prompt + 2 completion tokens。
- `usage_logs` 证据：`final_channel=Agnes 3.0`、`http=200`、`charge=9 / cost=25 / profit=-16` 微元（钱包扣 9）。小规模请求下售价=1/3 价目 < 成本=1:1 价目，出现小额负毛利；Agnes 真实上游成本未知，待用户给成本数据后修正 `model_prices` 成本列或 `channel_model_costs`。
- 两副本 v1.0.90 保持 healthy；未重启服务（渠道/价格按请求实时读取）。

## CC Switch `gpt-6-sol` 价格拒绝诊断：2026-09-25 CST

- 用户遇到本机 CC Switch `/responses` 503，错误为 `gpt-6-sol` 未配置模型价格。生产模型目录经“默认 Key”非计费查询返回 200：包含 `gpt-5.6-sol`，不包含 `gpt-6-sol`；`/healthz` 同期为 200。
- 本机 CC Switch 的“默认 Key”持久配置及 `~/.codex/config.toml` 均已是 `gpt-5.6-sol`。故障来源是已打开会话临时选择/携带 `gpt-6-sol`，覆盖了持久默认模型；切回 `gpt-5.6-sol` 后，本机代理日志已连续出现 200。
- 未新增 `gpt-6-sol` 售价、别名或渠道映射，未发起付费生成，未改生产数据库、代码或容器。没有上游目录和价格依据时，不得复制 `gpt-5.6-sol` 的价格冒充新模型；再次出现时先检查会话模型覆盖并切回目录中实际存在的模型。

## 更新模板

新增记录应包含：日期/时区、用户目标与授权范围、实际原因、修改和提交、测试结果、是否推送、是否部署、两副本版本、备份/回滚位置、线上验证范围和未解决事项。只记非敏感证据。
