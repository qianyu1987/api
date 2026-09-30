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

## Terra/Luna 路由配置与 v1.0.91 发布：2026-09-25 CST

- 非计费上游模型目录核验：`稳定pro`、`高价稳定pro` 明确返回 `gpt-5.6-terra`；没有现有上游原生返回 `gpt-5.6-luna`。Terra 原生接入这两个稳定渠道并保留原“优惠”及 Agnes 备用；Luna 仅映射“超稳定备用”的 `agnes-3.0-flash`，不虚构原生 Luna 渠道。
- 代码把 Luna 纳入现有公共模型兼容边界：只有无工具、无图片/文件、无推理/会话状态的简单文本可走 Agnes；响应模型名回写为 `gpt-5.6-luna`，复杂任务仍返回无兼容渠道。成本来源检查同步覆盖 Luna。22 个测试文件/241 项测试、typecheck、build、diff-check 通过。
- 发布提交 `4268916`，标签 `v1.0.91` 已推送。发布前备份 `/opt/relay-station-backups/pre-v1.0.91-terra-luna-20260925`（547M，41 张表/41 COPY + 配置归档），保留 v1.0.90 镜像。两 API 副本均为 v1.0.91 healthy；Gateway/PostgreSQL/Redis healthy，worker timer active；`/healthz`、`/api/v1/health`、两个首页均 200。
- 生产事务补齐 Terra/Luna 的 `model_map`、映射表及审计，并将 Agnes 同一上游的已核实成本复制为 Terra/Luna 渠道级成本快照。公开 `/v1/models` 已同时列出 Sol/Terra/Luna，相关备用成本告警为 0。未发起付费文本请求；真实生成成功仍需后续获准的低成本调用确认。

## Terra/Luna 真实验证与 v1.0.92 Agnes Responses 修复：2026-09-25 CST

- 用户明确授权真实收费测试。Terra 首次非流式 `/v1/responses` 成功：HTTP 200、模型 `gpt-5.6-terra`、文本 `OK`，走原生“高价稳定pro”；结算 80005 微元、成本 16215 微元。Luna 首次请求走“超稳定备用”但上游对缺省流式字段产生 `stream=null` 并返回 400；该失败结算 charge/cost/profit 均为 0。
- 根因是 Agnes Responses 转换器虽存在但未接入实际转发链路。v1.0.92 将简单文本 `/responses` 转成 Agnes `/chat/completions`，仅保留布尔 `stream`，再将流式/非流式结果还原为标准 Responses；原简单文本限制、模型名回写、失败退款和账务快照保持不变。新增实际路由路径、请求字段、流式结束和 Luna 回写测试；22 文件/242 测试、typecheck、build、diff-check 通过。
- 发布提交 `61684a0`，标签 `v1.0.92` 已推送。发布前备份 `/opt/relay-station-backups/pre-v1.0.92-agnes-responses-20260925`（547M，41 表/41 COPY + 配置归档）；v1.0.90、v1.0.91 镜像均保留。两 API 副本 v1.0.92 healthy，Gateway/PostgreSQL/Redis healthy，worker timer active，四个线上入口均 200。
- 发布后真实复测：Luna 非流式及流式均 HTTP 200、标准 Responses、模型 `gpt-5.6-luna`、文本 `OK`，每次 charge 3830 / cost 131 / profit 3699 微元；Terra 流式 HTTP 200、1 个 `response.completed`、模型与文本正确，charge 80005 / cost 16215 / profit 63790 微元。每次测试只提交一次，无重复账单。

## Laya 标签变体实验 v5 与链路复检：2026-09-26 CST

- 链路复检：Mac 端监督进程、SSH master、分类器 `127.0.0.1:19091` 与看板 `127.0.0.1:19095` 均持续运行（09-25 14:48 后无重连事件）；`/healthz` 200 shadow，看板端到端分诊正常（合成文本 coding p≈0.79，203 ms）。
- 新增 v5 标签实验（v4 强调文字类标签 + 收紧 other 标签为"仅当输入无意义或完全不是文字、代码、图片、视频类请求"）：在 scratch 副本上运行，不影响运行中服务。外部 44 条未核验集 0.3636（16/44，needs_tools 0.5），内置 41 条冒烟集 0.7317 / 0.4634 不变，无回归亦无提升。报告 `/Volumes/brainos/CodexMedia/generated/laya-mlx-shadow/label-variant-v5-20260926.json`。
- 结论：六个标签措辞变体（0.3182–0.3636）已到上限，text→other 与 coding→other 仍是主要误差；瓶颈在模型粒度与外部集标签质量（代理自标注、来源未核验），不再是提示词措辞。运行默认保持 v0 原始标签，未改任何服务代码、未改宿主配置；线上旁路开关仍关闭（`LAYA_SHADOW*` 为 0），采样管理员 Key 仍待用户指定。


## Laya 影子观察启用（管理员范围）与端到端实测：2026-09-26 CST

- 用户把"继续哪条线"交给代理决定；决定：启用线上影子观察，范围限定默认管理员用户（`users.id` `9c95ea6c-9721-450d-8a59-b08f4e4c43d0`，拥有"默认 Key" `sk-relay-nbMikmK`），不采集其他用户；观察结果绝不进入路由/结算。
- 宿主 `.env` 追加 4 行：`LAYA_SHADOW_ENABLED=true`、`LAYA_SHADOW_SOCKET_PATH=/run/laya-shadow/classifier.sock`、`LAYA_SHADOW_ADMIN_USER_ID`（上述 UUID）、`LAYA_SHADOW_TOKEN`（43 字符，取自 Mac `transport-token`，全程未打印）。变更前备份 `/opt/relay-station-backups/pre-laya-observe-20260925T232751Z/.env`（0600）。
- `docker compose up -d api` 重建两副本：均 healthy；`/healthz`、`/api/v1/health` 200；容器内各 4 个 `LAYA_SHADOW*` 变量核验。`config.ts` 启动校验通过（开关开启时 socket 路径/token 长度/管理员 ID 缺一即退出）证明参数合法。
- Mac 端 `tools/laya-shadow/server.py` 增加最小事件日志：每次成功分类向 `$RUNTIME/classifier-events.log` 追加一行 JSON（`ts`/`task_type`/`noul`/`duration_ms`，不记录 prompt 正文，0600，可用 `LAYA_EVENTS_LOG` 覆盖）。杀掉旧分类器后监督进程自动重建传输（`transport_ready attempt 2`：200/401/200 全链路验证）；laya-shadow 11 项单测通过。
- 端到端实测 1 次（用户授权代理决定，小额付费）：容器内用应用自身 AES-256-GCM 方案解密默认 Key（仅内存，未落盘/未打印），经容器 loopback 发 1 条 `gpt-5.6-luna` 简单文本请求：HTTP 200；`usage_logs` 确认走"超稳定备用"、charge 3805 / cost 124 / profit 3681 微元（`2026-09-25 23:44:16 UTC`）；同一秒 Mac `classifier-events.log` 出现影子分类事件（`task_type=other`、`noul=0.72`、54.7 ms）——容器 Unix socket → 宿主桥接 → SSH 反向转发 → Mac 分类器的生产链路完整闭环。
- 三态更新：本地原型=完成；线上影子观察=**已启用**（仅默认管理员的纯文本单条消息 ≤2000 字；该 Key 也是本地 CC Switch 默认 Key，用户自身使用文本会经私有链路送入 Mac 本地分类器，不出 Mac）；真实自动路由=未实现、未启用。
- 备注：宿主 `.env` 的 `ADMIN_PASSWORD` 与管理员用户的 DB 密码哈希不匹配（容器内 argon2 核验为 false，可能经 UI 改过密码）。不影响开关（只依赖 `LAYA_SHADOW*`），但 `/api/admin/laya-shadow` 计数端点需以真实管理员会话访问；计数为副本进程内值，重启归零。

## 价格与月套餐改造生产发布：2026-09-27 CST

- 用户授权发布代码和月套餐规则。生产备份 `/opt/relay-station-backups/pre-v1.0.93-pricing-subscription-20260927/` 已验证可读；旧 `relay-station:v1.0.92` 镜像保留。
- 本地 23 个测试文件/247 项测试、typecheck、build、diff-check 通过。迁移首次因历史 `media_tasks_queue_idx` 重复创建回滚，修复为幂等索引创建后第二次迁移成功。
- 两个 API 副本为 `relay-station:v1.0.93` 且 healthy，Gateway/PostgreSQL/Redis healthy，worker timer active；内部和公网健康接口 200，`www.hhtc.top` 首页 200；未带 API Key 的 `/v1/models` 返回 401。
- 线上 `monthly-149` 为 ¥149、额度 149、`reset_grant_limit=4`，总额度 596；5 个已有订阅保持 `reset_grant_limit IS NULL`。线上 `profit_min_margin_bps=3000`、返利 1000、支付费 0，6 条活跃模型价格未重算。
- 本次仅部署代码、迁移和套餐新购规则，未发布新模型价格、未修改真实渠道/路由、未做付费业务请求。按启用映射仍有 21 条成本缺失，待补齐有来源成本并确认预览后再发布价格。

## v1.0.94 媒体任务收尾修复与付费业务测试：2026-09-27 CST

- 用户要求执行付费业务测试、推送 Git，并修复短剧创作的图片/视频生成失败。已核对固定生产主机 `101.35.223.148`，两个 API 副本均为 `relay-station:v1.0.94` 且 healthy；旧镜像和备份保留在 `/opt/relay-station-backups/pre-v1.0.94-media-fix-20260927/`。
- 根因：`media_tasks.next_attempt_at` 为 `NOT NULL`，终态任务收尾却写入 `NULL`，导致 worker 事务回滚、媒体队列无法正常收尾。`src/services/media.ts` 已移除终态写入 `next_attempt_at=NULL`，视频接单状态保留合法时间值；`src/server.ts` 保留真实 worker 异常日志。新增回归断言，避免再次生成该 SQL。
- 图片真实测试：经公网 `/v1/media/quote` 与 `/v1/images/generations` 使用 1K `gpt-image-2.5`，quote HTTP 200、创建 HTTP 202，任务 `cb100454-ade2-4b50-98c9-fd8296dd136c` 完成并写入持久化素材；扣费 `500000` 微元、实际成本 `100000` 微元。账务只有一笔 `usage_reserve` 和一笔 `usage_settle`，无重复扣费。
- 视频真实测试：经公网 `/v1/media/quote` 与 `/v1/videos` 使用最低 4 秒 `agnes-video-2.5-flash`，quote HTTP 200、创建 HTTP 202；上游连续返回明确 `video queue is full`，任务无上游任务号、9 次重试后由 API 取消，HTTP 200；一笔 `usage_reserve` 配一笔 `usage_release`，`500000` 微元全部退回。代码/数据库收尾正常，但视频上游当前仍不可接单，不能宣称视频已成功出片；恢复后应重新做一次单次授权测试。
- 熔断窗口结束后再次做最低 4 秒视频复测，创建 HTTP 202，但兼容渠道均暂不可用（`no_compatible_channel`），5 次尝试后同样经 API 取消并全额释放 `500000` 微元；没有上游任务号，也没有结算扣费。
- 本地验证：23 个测试文件、247 项测试通过；`typecheck`、`build`、`git diff --check` 通过。价格仍未发布重算，未修改真实渠道、模型路由或用户账务。

## 四个 GPT 模型按用户 CSV 更新价格：2026-09-27 CST

- 用户提供 `Sheet_20260927.csv` 并要求按“后台取整”设置 Astra、Sol、Terra、Luna。生产变更前备份 `/opt/relay-station-backups/pre-price-sheet-20260927/` 已验证：41 张表、41 份 COPY、dump complete 标记存在，目录 0700，数据库 dump 与配置文件 0600。
- 单事务更新 `gpt-6-astra`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 的模型级输入/输出/缓存读取成本与售价，并写 4 条 `config_audit_logs`。售价（输入/缓存读取/输出，元/百万 Token）分别为 Astra `116.6/11.7/583.0`、Sol `46.6/4.7/233.2`、Terra `23.3/2.3/140.0`、Luna `2.3/0.23/14.0`。
- 平台用量协议没有独立 cache-write Token 字段；CSV 的 cache-write 数值仅写入 `price_source` 作为审计参考，缓存读取仍使用 cache 价，其他输入使用普通输入价。未新增或伪造无法结算的第四类 Token 价格。
- 复核：四个模型均在生产 `/v1/models` 返回，HTTP 200；精确微元值与 CSV 一致；在充值 3 倍、返利 10%、支付费 0、50%目标现金毛利下三项价格均通过护栏。生产仍为 `v1.0.94`，两个 API 副本及依赖 healthy，公网健康接口 200；渠道成本、渠道映射、路由、历史账单和现有价格快照均未修改。

## 四模型渠道与实时可用性只读审计：2026-09-27 CST

- 生产主机、数据库和两个 `relay-station:v1.0.94` API 副本 healthy。四条价格均 active；实际路由以 `channels.model_map` 为准，四模型均至少有一个启用候选且当前无熔断。
- 最近 24 小时真实请求：Astra `/responses` 214 成功、9 次流中断；Sol 493 成功、6 次流中断；Terra 16 次成功；Luna 2 次简单 `/chat/completions` 成功，但 305 次 `/responses` 因 `no_compatible_upstream` 被拒。Luna 最近成功仍走“超稳定备用”到 `agnes-3.0-flash`，只支持简单文本兼容，不是原生 Luna 或完整 Codex/工具调用能力。
- 在 API 容器内解密渠道 Key 后仅在内存中探测 10 个候选上游 `/models`；全部返回 HTTP 200 JSON，未输出 Key 或完整响应。“高速pro”、`0.12/0.2/0.6/0.8`、稳定渠道及 Agnes 目录包含其当前有效映射目标；“优惠”目录不含当前仍配置的 Astra/Terra，“best”目录不含当前仍配置的 Sol，属于过期映射。主路由仍有同期真实 200，因此不是四模型全部中断。
- Astra/Sol/Terra 原生路径可用；Luna 仅部分可用，不能宣称四模型能力完全相同。多数原生启用映射仍缺少带来源的渠道级成本，模型级 CSV 售价启用不等于所有上游成本已补齐。本轮只读诊断，未改生产配置、路由、价格或账务，未发起新的付费请求。

## v1.0.95 个人价格对比与企业充值发布：2026-09-27 CST

- 用户授权实施并发布个人中心价格对比与企业充值方案。代码增加北京时间今日调用/真实扣费、四模型月卡 1:4 与普通钱包 1:3 对照、独立企业 1:5 价格表；企业充值最低 ¥498、固定 1:5，客户端不能覆盖倍率，订单保存 `topup_offer_code` 与倍率快照；企业充值继续复用原钱包、支付回调、补账和 10% 返利幂等链路。所有注册用户可保存独立站联系信息，管理员有独立只读线索列表。
- 发布提交 `d51a708`、标签 `v1.0.95` 已推送 `origin/main`。本地 24 个测试文件/257 项测试、typecheck、build、前端语法和 diff-check 通过；企业回调测试覆盖 ¥498 到账 ¥2490、重复回调不重复到账/返利。桌面 1440px 与手机 390px 截图位于 `/Volumes/brainos/CodexMedia/generated/relay-enterprise-v1-0-95/`，无页面横向溢出或文字重叠；Impeccable 因本机缺 HTML 解析模块仅完成降级规则扫描，浏览器截图补充了实际布局验证。
- 发布前暂停 `relay-station-worker.timer`，备份 `/opt/relay-station-backups/pre-v1.0.95-enterprise-20260927T093754Z/`：目录 0700，配置、源码归档、发布 archive 和 PostgreSQL custom dump 均 0600；`pg_restore -l` 与源码 tar 读取通过，旧 `relay-station:v1.0.94` 镜像保留。生产目录先由已提交的 Git archive 更新，未覆盖 `.env` 或 `secrets/`。
- migration 成功：`orders.topup_offer_code` 为 NOT NULL/default standard，两项 CHECK 均已验证，`enterprise_site_leads`、索引与更新时间 trigger 存在；迁移时 145 条历史订单全部有方案快照且无倍率/金额违规。维护 worker 手动运行成功，timer 恢复 active/enabled。
- 两个 API 副本均为 `relay-station:v1.0.95` / package 1.0.95 且 healthy，Gateway/PostgreSQL/Redis healthy；`https://api.hhtc.top/healthz`、`https://api.hhtc.top/api/v1/health`、`https://hhtc.top/api/v1/health` 均 200，`www.hhtc.top` 加载 `app.js?v=1.0.95`。登录态总览和企业充值页显示四模型价格、当日调用/扣费、`¥498 -> ¥2490`，用户线索 GET 和管理员线索列表均正常。
- 生产验收只创建一张 ¥498 未付款企业订单：数据库快照为 multiplier 50000、offer enterprise、status pending，`paid_at` 与 `wallet_credit_micros` 均为空；未扫码、未付款、未到账、未发放返利。非计费 `/v1/models` 返回 200、共 9 个模型且包含 Astra/Sol/Terra/Luna；四模型精确售价与发布前一致，本次未修改渠道映射、真实模型路由或历史账单。
- 后续边界：价格卡当前以 active 且三项非零的 `model_prices` 判断展示可用，未额外联查启用渠道；本次线上 `/v1/models` 已确认四模型存在，但未来若单独停用全部渠道，应同步改为复用模型目录可用性判断，避免价格与路由状态短时不一致。

## GPT-6 Sol 接入、深夜 Token 折扣与 v1.0.97 生产发布：2026-09-27 CST

- 用户授权：检查上游可用 GPT-6 模型，将真实存在但站内未配置的模型接入、按用户图片成本和本站利润规则定价并测试；用户中心新增显眼的 00:00-04:00 深夜折扣卡片，折扣由管理员自行设置且必须保护利润。
- 上游核验：7 个现有 GPT 渠道（高速pro、高价稳定pro、稳定pro、0.6、0.8、0.2、0.12）均确认 `gpt-6-sol` 可用；没有发现可用的 `gpt-6-luna`、`gpt-6.0` 或其他 GPT-6 变体，因此没有创建虚假模型或别名。生产事务新增 7 条运行映射、7 条目录映射、7 条带来源渠道成本、1 条模型售价和审计记录。
- 成本/售价：图片最高档成本为输入 8000000、输出 30000000、缓存 800000 微元/百万 Token。生产参数为最坏充值倍率 50000、最低毛利 3000、支付费 0、返利 1000 基点；向上取整后的售价为输入 66666667、输出 250000000、缓存 6666667 微元/百万 Token。
- 用户补充的 Standard 价格证据为输入 $2、输出 $10、cache-read 约 $0.2 / 百万 Token；272K+ 规则为输入/缓存类（普通输入、cache-read、cache-write）×2.0、输出×1.5。换算结果：Standard 272K+ 输入 $4、输出 $15、cache-read $0.4、cache-write $5；Fast 272K+ 输入 $8、输出 $30、cache-read $0.8、cache-write $10。当前生产 `gpt-6-sol` 渠道成本已使用 Fast 272K+ 的输入/输出/cache-read 三项，故本次只补充审计记录，没有修改价格、路由或部署。用户提供的一次账单为原始 $0.00140480、实际扣费 $0.00021072（约 0.15 倍）；这是单次账户/服务优惠证据，不替代长期标准成本。
- 平台没有独立 cache-write 用量/账务字段，当前统一 `high_context_multiplier_bps` 不能精确表达输入类×2 与输出×1.5 的差异；没有伪造第四类结算字段。若要自动支持分项倍率，需另行设计迁移、账单映射和回归测试。
- 真实付费验证：请求 `4f7121f0-d8ad-4a4a-b4d8-dd3b86490572` 经公网成功，HTTP 200、响应模型 `gpt-6-sol`、最终渠道“高速pro”，usage 为 169 输入、5 输出、4224 缓存 Token；charge/cost/profit 为 40678/4882/35796 微元。`relay_attempts` 为 1，账务为 1 条 `usage_reserve` + 1 条 `usage_settle`，无重复提交或流水。v1.0.97 发布后未再次发起收费请求。
- 深夜折扣实现：北京时间每日 `[00:00,04:00)`，默认关闭且折扣 0%；管理员在“站点设置”填写百分比和启用开关。用户总览卡片显示配置折扣、当前账号最终折扣、固定时段、状态和倒计时。仅 Token 计费模型参与，媒体/固定接口价格不参与。
- 利润与账务保护：最坏充值倍率至少按 1:5 并考虑历史更高倍率、支付费、返利、最低毛利、真实 `channels.model_map`、模型专属优先于 `*` 通配的渠道成本，以及标准/272K+最高成本。预扣快照冻结售价、折扣和成本；结算不按后来配置重算。利润、手续费与返利合计达到 100% 时拒绝保存；个人折扣和返利的校验、写入、审计在同一事务和统一锁顺序内。
- 当前限制：生产 31 个启用模型/路由组合中有 19 条缺少有来源成本（`agnes-3.0-flash` 1、`gpt-6-astra` 6、`gpt-5.6-sol` 9、`gpt-5.6-terra` 3），`gpt-6-sol` 7/7 与 Luna 1/1 成本完整。护栏还发现 15 个旧模型输入/输出/缓存价格约束低于当前最坏 1:5、最低毛利 30%、返利 10% 的要求；因此补齐成本后仍需重新核价，不能直接开启折扣。全站深夜折扣安全上限当前为 0%，后台会阻止非零设置；`gpt-5.5` 另有 active 价格但没有启用运行路由，属于待清理目录残留。
- 本地验证：25 个测试文件、282 项测试通过；TypeScript 类型检查、构建、前端语法检查和 `git diff --check` 通过。Impeccable 因环境缺 HTML parser 使用降级扫描，无规则发现；实际桌面和 390px 手机生产页面补做截图与 overflow 检查，页面无横向溢出，移动端卡片无文字重叠。
- Git：`d62b70d`（`v1.0.96`，深夜折扣和利润护栏）、`aafb741`（`v1.0.97`，视口溢出和请求 ID）及两个标签均已推送 `origin/main`。
- 发布与回滚：发布前备份 `/opt/relay-station-backups/pre-v1.0.96-night-gpt6sol-20260927T110057Z` 约 381 MB，目录 0700；PostgreSQL custom dump、配置/密钥归档和源码归档均验证可读，旧 `relay-station:v1.0.95` 镜像保留。v1.0.96 先完成业务验证，随后以相同备份边界发布 v1.0.97；migration 成功，未覆盖 `.env` 或 `secrets/`。
- 生产验收：两个 API 副本均为 `relay-station:v1.0.97` / package 1.0.97 且 healthy；Gateway、PostgreSQL、Redis healthy，`relay-station-worker.timer` enabled/active。`https://api.hhtc.top/healthz`、`https://api.hhtc.top/api/v1/health`、`https://hhtc.top/api/v1/health` 和 `https://www.hhtc.top/` 均为 200；首页加载 `styles.css?v=1.0.97` 和 `app.js?v=1.0.97`。登录态总览可见 Sol 6 价格和深夜卡片，后台可见深夜折扣输入/开关及安全上限。

## GPT-6 Sol Standard/272K+ 分层价格与服务档保护：v1.0.98/v1.0.99（2026-09-28 CST）

- 用户确认采用其提供的 Standard 与 272K+ 成本证据。生产前备份 `/opt/relay-station-backups/pre-v1.0.98-gpt6sol-tiered-20260927T233442Z/`、`/opt/relay-station-backups/pre-v1.0.99-service-tier-20260928T000800Z/` 已保留；数据库、配置归档和旧镜像均未覆盖。
- `v1.0.98` migration 增加/校验分层成本、cache-write 字段与计费快照；`gpt-6-sol` 的模型价格保留 Standard 基准 `input=2000000/output=10000000/cache-read=200000` 微元/百万 Token，并有 `thresholdTokens=272001` 的 272K+ 档：成本 `4000000/15000000/400000`，cache-write 成本 `5000000`；对应售价 `33333334/125000000/3333334`，cache-write 售价 `41666667` 微元/百万 Token（约 ¥33.333334/¥125/¥3.333334/¥41.666667）。
- 7 个启用 GPT 渠道均有 `gpt-6-sol` 运行映射、带来源成本和分层成本；7/7 的倍率复核为输入 `2.0x`、输出 `1.5x`、cache-read/cache-write `2.0x`。本次写入 7 条渠道成本审计和 1 条模型价格审计，最近两小时审计记录共 8 条。
- 生产账务参数仍为最低毛利 `30%`、返利 `10%`、支付费 `0%`；本次没有把全站护栏改为 50%，也没有把一次优惠账单当作长期标准成本。其他模型仍存在缺少有来源渠道成本的路由，不能宣称全站价格或全站利润已重算。
- `v1.0.99` 增加 `gpt-6-sol` 未计价服务档保护：请求体 `service_tier=fast/priority` 及 `service-tier`、`x-service-tier` 等未计价请求头均在路由/结算前拒绝（HTTP 422），不访问上游、不产生账务。Fast/priority 尚未开放，需先补齐独立成本与售价并完成验证。
- 本地验证：25 个测试文件、291 项测试通过；TypeScript 检查、构建、前端语法检查和 `git diff --check` 通过。提交 `1e88b6d`（`v1.0.98`）和 `da6264c`（`v1.0.99`）已推送 `origin/main`，工作树干净。
- 生产部署已核验：两个 API 副本均为 `relay-station:v1.0.99` 且 healthy；Gateway、PostgreSQL、Redis healthy，`relay-station-worker.timer` enabled/active。`https://api.hhtc.top/healthz`、`https://api.hhtc.top/api/v1/health`、`https://hhtc.top/api/v1/health` 均 200，`www.hhtc.top` 加载 `styles.css?v=1.0.99`、`app.js?v=1.0.99`。服务器 `.env` 的镜像标签曾滞后为 v1.0.97，已先备份并同步为 `RELAY_IMAGE_TAG=v1.0.99`，备份目录为 `/opt/relay-station-backups/pre-v1.0.99-env-sync-20260928T163009Z/`，未重启服务。
- 本轮没有发起新的真实付费 `gpt-6-sol` 请求；此前 v1.0.97 的单次 200/结算证据仍属于旧分层发布前测试，不能冒充本次新价格的付费验收。新价格目前有数据库/审计/非计费接口验证，若要再次做收费验收需单独确认测试金额或预算。

## 更新模板

新增记录应包含：日期/时区、用户目标与授权范围、实际原因、修改和提交、测试结果、是否推送、是否部署、两副本版本、备份/回滚位置、线上验证范围和未解决事项。只记非敏感证据。

## GPT TOKEN 价格与月套餐改造：发布前设计与核验（2026-09-27 CST）

- 用户目标：按真实渠道成本、充值 3 倍、支付费、返利和最低现金毛利计算钱包价格；月套餐 ¥149 每次发放 ¥149、30 天内共 4 次。官方实时价格页仍无法核验，因此没有把 OpenAI 快照作为当前官方报价。
- 本地实现：新增 `src/services/pricing.ts` 及 `/api/admin/pricing/preview`、`/api/admin/pricing/publish`。预览覆盖每个启用模型的全部启用渠道，缺少有来源的渠道成本时阻断发布；完整时取输入/输出/缓存最高成本，按 `ceil(成本×充值倍率/(10000-毛利-手续费-返利))` 计算钱包售价，并在同一事务写入 `model_prices`、`profit_min_margin_bps` 与 `config_audit_logs`。旧订单/账单快照不回溯。
- 价格护栏：`ProfitService`、模型/固定接口/媒体价格校验均考虑充值倍率、支付手续费和返利；新默认最低毛利为 5000 基点。旧的“OpenAI 快照初始化”入口不再直接写价格，必须转到渠道成本预览并显式确认。
- 月套餐：`plans`、订单快照、`subscriptions`、`subscription_purchases`、重置事件增加发放次数快照/计数。`monthly-149` 新购买为首发 149 + 3 次周期发放（总 596），第四次后停止；手动和 worker 使用同一周期幂等键。旧订阅的 `reset_grant_limit` 保持 NULL，继续原有规则，不追溯改造。新增套餐利润汇总接口 `/api/admin/profit/subscriptions`，按实际 `usage_logs` 成本核算，不套钱包 3 倍。
- 发布前验证：本地 23 个测试文件/246 项通过，`npm run typecheck`、`npm run build`、`git diff --check` 通过。随后生产发布结果见上方“价格与月套餐改造生产发布”条目。
- 线上只读复核（2026-09-27）：生产仍为 `relay-station:v1.0.92`，两副本和健康接口均正常；`profit_min_margin_bps=3000`、支付费 0、返利 1000，活跃渠道 14、渠道成本行 5、活跃模型价格 6。按启用映射核对有 21 条缺少有来源渠道成本，故没有运行 migration、价格发布或重启服务。
- 价格后续事项：先在后台成本预览中补齐这 21 条缺失项并确认来源，再由管理员确认预览后发布；¥149/596 的套餐不能仅凭钱包模型价格证明 50% 现金毛利。代码与套餐规则已按上方条目发布，旧镜像和备份保留用于回滚。
## Laya v3 硬样本训练对比：2026-09-28 CST

- 在本机运行时以 `laya-multilingual-mlx-lora-v2-holdout` 为基线，新增 22 条人工核对的边界样本（文本/代码/图片/视频/无意义输入），生成候选模型 `laya-multilingual-mlx-lora-v3-hardcases`。样本与模型均保存在外置运行目录，不进入生产镜像。
- 外部 44 条未核验评测：任务类型准确率从 70.45% 提升到 77.27%，工具需求准确率从 81.82% 降至 77.27%；内置 41 条 smoke 集为任务类型 100%、工具需求 100%，仍不是独立准确率证据。
- 结论：v3 改善了文本/代码边界，但工具判断出现回归；当前线上影子分类器继续使用 v2，v3 仅保留为候选，不启用自动路由、不改变生产路由或计费。下一轮应先补充独立人工标注的工具需求样本，再重新训练和比较。
## Laya v4 工具需求样本训练对比：2026-09-28 CST

- 从 v3 候选继续加入 20 条人工核对的工具需求边界样本，生成候选模型 `laya-multilingual-mlx-lora-v4-tools`。训练和权重仅保存在外置运行目录。
- 外部 44 条未核验评测：任务类型准确率从 v3 的 77.27% 提升到 81.82%，工具需求准确率从 77.27% 降至 75.00%；内置 41 条 smoke 集任务类型和工具判断均为 100%，仍不是独立准确率证据。
- 结论：v4 继续改善文本/代码分类，但工具判断仍回归；线上影子分类器继续使用 v2，v4 仅保留候选，不启用自动路由、不改变生产路由或计费。下一步应建立独立人工标注的平衡验证集，并分别校准任务类型头和工具需求头。

## gpt-6.1-sol 渠道目录核验与映射准备：2026-10-01 CST

- 按用户要求在固定生产主机 `101.35.223.148` 的 API 容器内使用现有解密逻辑，对所有启用渠道做非计费 `/models` 核验，仅输出渠道名、HTTP 状态和模型 ID，不输出 Key 或完整响应。
- 7 个原生渠道明确返回精确 `gpt-6.1-sol`（HTTP 200）：高速pro、高价稳定pro、0.6、0.8、0.2、0.12、稳定pro。RIPP 的优惠/best 未返回该模型；Agnes 渠道当前返回 403，不能作为新模型证据。
- 生产数据库事务新增 7 条 `channels.model_map` 运行映射和 7 条 `channel_model_mappings` 目录映射，全部为 `gpt-6.1-sol -> gpt-6.1-sol`，并写入 7 条不含密钥的配置审计记录。该阶段既有模型映射、价格和账务未修改；后续定价与收费验收见下方同日记录。
- 初步核验阶段尚无 `model_prices`，因此当时没有复制 `gpt-6-sol` 价格或开放收费；随后收到费用截图后已按独立成本完成定价并启用公开目录。RIPP 未返回该模型，Agnes 目录核验为 403。
- 变更前 PostgreSQL custom dump 已保存到本机 `/Volumes/brainos/CodexMedia/generated/gpt-token-gpt-6-1-sol-20261001/`，文件类型校验为 PostgreSQL custom dump。

## gpt-6.1-sol 定价、公开目录与收费验收：2026-10-01 CST

- 用户补充费用截图：Standard 原始单价为 input `$2.5`、output `$15`、cache-read `$0.2`/百万 Token；截图倍率 `0.20x`，因此按有效成本 input `0.5`、output `3`、cache-read `0.04`/百万 Token 计入渠道成本。平台没有把一次“用户扣费”数值当作售价。
- 7 个已验证原生渠道均写入上述 Standard 成本，默认高上下文保护倍率为 `1.20x`；模型级保守成本为 input `0.6`、output `3.6`、cache-read `0.048` 元/百万 Token。按生产最坏充值倍率 `1:5`、最低毛利 `30%`、返利 `10%`、支付费 `0%` 向上取整，用户售价为 input `5`、output `30`、cache-read `0.4` 元/百万 Token。未确认 272K+ 独立价格分档，未启用 cache-write 独立计价。
- `gpt-6.1-sol` `model_prices` 已 active；使用默认 Key 访问生产网关 `/v1/models` 返回 HTTP 200、共 11 个模型且包含 `gpt-6.1-sol`。未重启服务，目录由现有动态数据库查询即时生效。
- 一次最小真实收费验收（`ping`、最多 8 个输出 Token）成功：请求 `126ab3cd-14b8-4a75-9059-05cb5270aa9d`，HTTP 200，模型/上游均为 `gpt-6.1-sol`，最终渠道高速pro；usage 为 547 输入、5 输出、3840 缓存 Token，扣费 `4421` 微元、成本 `443` 微元、利润 `3978` 微元。仅 1 次上游尝试，账务为 1 笔预扣和 1 笔结算，无重复扣费。
- 价格事务前的受影响配置备份为本机 `/Volumes/brainos/CodexMedia/generated/gpt-token-gpt-6-1-sol-20261001/relay-station-pre-gpt-6-1-sol-pricing-20260930T220310Z.dump`（PostgreSQL custom dump，权限 0600）；未修改代码或镜像，未改变其他模型和账务参数。

## GPT 上游新增模型复核：2026-10-01 CST

- 对所有启用渠道再次在 API 容器内使用现有解密逻辑请求 `/models`，仅输出模型 ID。新发现的精确上游 ID：`gpt-6`（高速pro）、`gpt-5.5` 与 `gpt-5.6`（高价稳定pro）、`gpt-5.3-codex-spark`（0.6/0.8/0.2/0.12）。`gpt-6-luna` 仍未在任何已核验上游目录出现。
- 这些新 ID 当前没有完整的本站独立成本/售价证据：`gpt-6`、`gpt-5.6`、`gpt-5.3-codex-spark` 没有 `model_prices`；`gpt-5.5` 虽有历史 `manual` 模型价格，但没有对应渠道级成本。故本轮未写运行映射、未开放公开目录、未发起收费请求，避免把模型 ID 或旧价格当作可审计成本。
- 待用户提供各模型的上游 Standard 成本/倍率或明确授权采用可审计价格来源后，再分别写入渠道映射、渠道成本、模型售价并做非计费目录和小额收费验收。
