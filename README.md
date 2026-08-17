# Clawbot

一个最小、可自托管的微信 AI Agent 服务：直接实现 `openclaw-weixin 2.4.6` 使用的 iLink HTTP 协议，模型侧使用 OpenAI Responses API 或兼容端点。

## 会话与记忆语义

- 一个微信机器人账号可服务多个私聊用户；会话主键为 `(account_id, from_user_id)`。
- 每个用户只有一条持续会话。同一用户严格串行，不同用户最多并发 `MAX_CONCURRENT_USERS` 个。
- SQLite 永久保存成功完成的文本轮次。模型输入使用“滚动摘要 + 摘要边界后的消息 + 当前消息”。
- 达到上下文窗口的 `CONTEXT_COMPACT_RATIO` 时，旧摘要和旧消息会被合并为新摘要，最近 `CONTEXT_KEEP_MESSAGES` 条保留；原始消息不会删除。
- 记忆只有聊天记录和滚动摘要，没有用户画像、向量库或结构化长期事实。
- 图片只在当前模型请求中以 data URL 发送，数据库仅保存 `[用户发送了N张图片]`。
- 精确发送 `/reset` 会清除该用户的对话和摘要，不影响其他用户。

## 启动

要求 Node.js 22.5 或更高版本（使用内置 `node:sqlite`）。

```bash
cp .env.example .env
pnpm install
pnpm run build
pnpm start
```

开发模式会显式读取项目根目录的 `.env`：

```bash
pnpm run dev        # 直接运行，适合受限环境
pnpm run dev:watch  # 监听 src 目录并自动重启
```

必须配置：

- `OPENAI_BASE_URL`：以 `/v1` 结尾的 Responses 兼容 API 基址。
- `OPENAI_API_KEY`、`OPENAI_MODEL`。
- `ADMIN_TOKEN`：至少 8 个字符，生产环境建议使用 16 个以上的随机字符。
- `WEBHOOK_TOKEN`：主动发送接口使用的 Token；未配置时回退到 `ADMIN_TOKEN`。
- `APP_ENCRYPTION_KEY`：恰好 32 个随机字节的 base64；可用 `openssl rand -base64 32` 生成。更换后已有微信凭证无法解密。

默认 SQLite 文件为 `./data/clawbot.sqlite`。微信 `bot_token`、同步游标和每用户 `context_token` 使用 AES-256-GCM 加密；聊天正文和摘要按计划以明文保存，请保护数据目录并做好备份。

## 微信扫码

1. 打开 `http://localhost:3000/admin`。
2. 输入 `ADMIN_TOKEN`。页面只把它存入当前标签页的 `sessionStorage`。
3. 点击“开始/重新扫码”，用微信扫描并确认；如果出现配对码要求，在页面提交验证码。
4. `/readyz` 在凭证有效且首次 `getupdates` 成功后返回 200。

管理接口均要求 `Authorization: Bearer <ADMIN_TOKEN>`：

- `GET /healthz`
- `GET /readyz`
- `GET /admin`
- `GET /api/admin/status`
- `POST /api/admin/weixin/login-sessions`
- `GET /api/admin/weixin/login-sessions/:id`
- `POST /api/admin/weixin/login-sessions/:id/verify-code`，JSON 为 `{ "code": "123456" }`

服务只处理 `message_type=USER` 的私聊。文本、图片输入和文本回复受支持；群聊会忽略；语音、文件和视频会回复不支持提示。微信凭证返回 `-14` 或 401 时，轮询停止、readiness 失败，需要重新扫码。

## Webhook 主动发送

Webhook 使用 `WEBHOOK_TOKEN`，不会调用模型。发送成功后，文本会作为一条 assistant 消息写入该用户历史，供下一轮模型对话使用。

先查看已经与机器人私聊过的用户：

```bash
curl -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  http://127.0.0.1:3000/api/webhooks/peers
```

发送微信消息：

```bash
curl -X POST http://127.0.0.1:3000/api/webhooks/messages \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-20260817-001" \
  -d '{"peer_id":"USER_ID","text":"任务已完成"}'
```

接口返回 `sent` 或 `duplicate`。`Idempotency-Key` 可选，建议自动化任务始终提供。目标用户必须至少给机器人发送过一次私聊，以便服务取得该用户最新的 `context_token`；否则返回 409。微信可能使长期未使用的 token 失效，此时上游发送失败会返回 502，需用户再次向机器人发消息刷新。

## CLI

构建后可通过 npm 脚本或 bin 入口使用：

```bash
# 启动服务
pnpm start
# 等价于：node dist/cli.js serve

# 查看服务和微信状态
node dist/cli.js status

# 查看可发送用户
node dist/cli.js peers

# 主动发送
node dist/cli.js send --peer USER_ID --text "任务已完成" --idempotency-key job-001
```

远程调用可设置 `CLAWBOT_URL=https://clawbot.example.com`，也可以用 `--url` 和 `--token` 覆盖环境变量。项目作为 npm 包链接或安装后，命令名为 `clawbot`。

## Docker

```bash
cp .env.example .env
# 编辑 .env，尤其是密钥和模型配置
docker compose up -d --build
docker compose ps
docker compose logs -f clawbot
```

SQLite 数据通过 Docker named volume `clawbot-data` 持久化。镜像以非 root 用户运行，包含 `/healthz` 健康检查，并以 `clawbot serve` 作为入口。首次启动后访问 `http://localhost:3000/admin` 扫码。

## 上下文参数

| 环境变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `CONTEXT_WINDOW_TOKENS` | 32000 | 兼容模型的实际上下文窗口 |
| `CONTEXT_COMPACT_RATIO` | 0.7 | 触发滚动摘要的预计输入比例 |
| `CONTEXT_KEEP_MESSAGES` | 20 | 正常压缩后保留的最近消息数 |
| `CONTEXT_SUMMARY_MAX_TOKENS` | 1500 | 摘要请求的最大输出 token |
| `CONTEXT_IMAGE_TOKENS` | 2000 | 每张图片的安全估算预算 |

摘要失败不会推进边界。模型实际返回上下文超限时，服务会把保留消息数减半做一次紧急压缩并只重试一次。

## 验证

```bash
pnpm test
pnpm run typecheck
pnpm run build
pnpm audit --prod
```

测试全部使用内存 SQLite、HTTP/fetch stub 和 Fastify `inject`，不会连接真实微信或模型，也不使用浏览器自动化。

## 部署限制

- 首版只管理一个机器人账号；重新扫码会替换当前活跃凭证。
- 支持 Webhook/CLI 主动文本发送，但不内置定时调度器。
- 原始消息不会自动过期；只有用户 `/reset` 会删除该用户记录。生产环境应另行制定磁盘、备份和隐私策略。
- `CONTEXT_WINDOW_TOKENS` 必须与所选兼容模型一致，32K 只是保守默认值。
