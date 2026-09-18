# 同一个 API Key 调用对话、图片和视频

Base URL：`https://api.hhtc.top/v1`。所有请求使用网站 API Key 的
`Authorization: Bearer YOUR_KEY`，不使用上游 Key。

| 用途 | model | 接口 | 当前规格 |
| --- | --- | --- | --- |
| 专业图片 | gpt-image-2 | POST /v1/images/generations | 1K |
| 增强图片 | gpt-image-2.5 | POST /v1/images/generations | 1K |
| 标准图片 | agnes-image-2.5-flash | POST /v1/images/generations | 1K/2K/3K/4K |
| 视频 | agnes-video-2.5-flash | POST /v1/videos | 720P，4–12 秒 |

`GET /v1/models` 同时列出可用的文字及媒体模型。媒体复用短剧创作
的渠道、价格、福利、钱包预扣与结算，不使用 Token 套餐。

## 创建与查询

图片和视频均为**异步任务协议**，不是 OpenAI SDK 的同步图片返回格式。
通用聊天客户端需要媒体工具或专用接口适配；仅选择聊天模型不会自动调用媒体。

```http
POST /v1/images/generations
Authorization: Bearer YOUR_KEY
Content-Type: application/json
Idempotency-Key: unique_image_request_0001

{"model":"gpt-image-2.5","prompt":"奶油白背景上的玫瑰花海报","size":"1K","ratio":"1:1"}
```

```http
POST /v1/videos
Authorization: Bearer YOUR_KEY
Content-Type: application/json
Idempotency-Key: unique_video_request_0001

{"model":"agnes-video-2.5-flash","prompt":"微风中轻轻摇曳的玫瑰花","size":"720P","seconds":5,"ratio":"16:9"}
```

首次创建返回 `202`、任务 `id`、`statusUrl`、`chargeMicros`（人民币微元），
以及 `Location` 和 `Retry-After: 5`。使用相同 Key 每 5 秒查询
`GET /v1/media/tasks/{id}`。状态为 `completed` 时，通过同一个 Key
请求返回的 `resultUrl` 下载作品；也可用 `/v1/media/tasks/{id}/result`。
地址需要鉴权，不是可直接公开分享的链接。

每个新任务使用一个 16–100 位的 `Idempotency-Key`（字母、数字、`_`、`-`）。
网络中断后使用原编号及原参数重试，会返回原任务，不再次扣费。
已完成任务重试返回 `200`。不要在超时后更换编号。

任务 `failed` 表示生成失败并释放预扣；`unknown` 表示上游接单结果待确认，
预扣仍保留，需要管理员核实，不能当作失败重复提交。

可选：先向 `POST /v1/media/quote` 提交相同生成参数获取价格与 `quoteToken`，
再把 `quoteToken` 带入创建请求；价格变化会返回 `409`。
不传时按创建瞬间的服务端价格生成并预扣。

通用创建入口也可使用 `POST /v1/media/tasks`。`GET /v1/media/tasks` 列出
自己的最近任务。视频继续支持原有 `mode`、`first_frame`、`last_frame`、
`images`、`audios` 参数；上传素材仍使用 `/api/me/media/uploads`。

不支持批量 `n>1`、高画质参数、直接指定任意上游或未知模型；不支持的参数
会明确拒绝，不静默按其他计费规格执行。文字模型仍走原有 Chat/Responses 接口。
