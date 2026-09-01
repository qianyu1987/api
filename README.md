# Relay Station

极简 OpenAI 兼容中转站。它在独立目录内运行，不依赖或修改仓库中的 `oneapi-pay-bridge`，生产入口预期为 `https://api.hhtc.top`。

服务包含 OpenAI 兼容转发、渠道故障切换、钱包与 30 天套餐计费、微信/支付宝 Native 支付、用量明细、邀请返利和 CC Switch 导入。PostgreSQL 是账务唯一事实来源，Redis 只承担限流、缓存、临时锁和熔断状态。

## 运行要求

- Docker Engine 24+ 与 Docker Compose v2.20+
- 可写的持久化磁盘，用于 PostgreSQL 和 Redis volume
- 已指向 `101.35.223.148` 的 `api.hhtc.top` DNS 和宿主机 Nginx
- 真实支付启用时，微信支付/支付宝商户参数和证书文件

Compose 不发布 PostgreSQL、Redis 或 API 的宿主机端口。内置网关仅监听 `127.0.0.1:18082`，由宿主机 Nginx 为 `api.hhtc.top` 终止 TLS；数据库网络保持内部隔离。
应用镜像以 Node.js 内置的 `node` 非 root 用户运行，丢弃全部 Linux capabilities，并使用只读根文件系统；`/tmp` 仅使用短期 tmpfs。

## 首次启动

```bash
cd relay-station
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
```

编辑 `.env`，至少替换以下值：

- 取消 `.env` 中 `POSTGRES_PASSWORD=...` 注释并填入 URL 安全的强随机值，例如 `openssl rand -hex 24`
- `JWT_SECRET`、`COOKIE_SECRET`、`API_KEY_PEPPER`：各自独立，至少 32 字符
- `CHANNEL_ENCRYPTION_KEY`：严格为 32 字节的 Base64，例如 `openssl rand -base64 32`
- `ADMIN_PASSWORD`：至少 16 字符且不可复用
- `PUBLIC_BASE_URL=https://api.hhtc.top`
- `CORS_ORIGINS`（可选）填写需要跨域访问控制台的完整来源列表，逗号分隔；留空时仅允许同源访问

不要把 `.env` 或 `secrets/` 提交到版本库。真实支付未准备好时，保持支付账号字段为空；启用支付时，将对应私钥/证书放进 `secrets/`，并把 `.env` 中的路径设为 `/run/secrets/relay/<文件名>`。

先做静态配置检查，再构建并启动：

```bash
docker compose config --quiet
docker compose build
docker compose up -d --scale api=2 gateway
docker compose ps
```

`migration` 会在 API 启动前执行 `dist/migrate.js`。迁移以 PostgreSQL advisory lock 串行化，并按 schema checksum 幂等执行；两个 API 副本启动时不会重复应用账务变更。Compose 文件默认声明两个 API 副本，`--scale api=2` 用于明确部署意图，也便于之后临时调整副本数。

## 入口与 TLS

完整服务器发布步骤见 `deploy/README.md`。

内置 `gateway` 负责发现两个 `api` 副本；宿主机 Nginx 只需将 `api.hhtc.top` 转发到 `127.0.0.1:18082`：

```bash
cp /etc/nginx/conf.d/api.hhtc.top.conf /etc/nginx/conf.d/api.hhtc.top.conf.bak
install -m 0644 deploy/nginx/api.hhtc.top.conf /etc/nginx/conf.d/api.hhtc.top.conf
nginx -t
systemctl reload nginx
```

反向代理必须：

- 在公网终止 TLS，只开放 `80/443`
- 支持 SSE/流式响应并关闭响应缓冲
- 保留 `Authorization`、`Content-Type` 和支付回调验签所需请求头及原始请求体
- 使用足够长的上游读取超时，不在代理层自动重放生成请求
- 对两个健康 API 副本做服务发现和负载均衡

健康端点是 `GET /healthz`。它是进程存活检查；数据库与 Redis 的健康状态由 Compose 分别检查。公网确认命令：

```bash
curl -fsS https://api.hhtc.top/healthz
```

支付回调地址应固定为：

- 微信：`https://api.hhtc.top/api/payments/wechat/notify`
- 支付宝：`https://api.hhtc.top/api/payments/alipay/notify`

## 数据迁移与发布

每次发布都先备份 PostgreSQL，然后运行新镜像的一次性迁移，再滚动替换 API：

```bash
docker compose build
docker compose run --rm migration
docker compose up -d --no-deps --scale api=2 api gateway
docker compose ps
```

当前迁移是向前执行的 schema 同步，不提供自动降级。回滚应用镜像前先确认旧代码能读取新 schema；账务表、支付事件和流水不得通过手工删除来回滚。

## Worker

worker 是独立的一次性维护进程，会清理超过保留期的用量明细、孤立的转发尝试，并释放超时预扣。它不会常驻轮询；应由宿主机定时器或 CI 调度运行：

```bash
docker compose --profile maintenance run --rm worker
```

建议每 5 分钟运行一次。多个 worker 偶发重叠不会把 Redis 变成账务来源，但仍应由调度器避免无意义的并发执行，并监控非零退出码。

## 常用运维

```bash
# 查看 API 与依赖状态
docker compose ps

# 查看最近日志；日志中不应出现上游密钥、完整用户 API Key 或 CC Switch 深链
docker compose logs --tail=200 api migration worker

# 单独重跑幂等迁移
docker compose run --rm migration

# 停止应用但保留数据库 volume
docker compose down
```

不要使用 `docker compose down -v` 处理普通发布或故障，它会删除 PostgreSQL 与 Redis volume。生产备份以 PostgreSQL 一致性备份为准，Redis 可重建但不应替代数据库备份。

## 本地 Node.js 运行

需要 Node.js 22、PostgreSQL 和 Redis：

```bash
npm ci
npm run build
npm run migrate
npm start
```

另一个终端可按需执行 `npm run worker`。开发环境也必须提供 `DATABASE_URL` 和 `REDIS_URL`；初始渠道、模型价格和套餐均由管理员首次配置，不在源码或部署文件中硬编码。
