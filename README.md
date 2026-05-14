# Telegram AI Bot

Cloudflare Worker + Telegram Bot API + OpenRouter 实现的 Telegram AI Bot。

## Public-safe 配置方式

本仓库不应包含任何真实 token、API key、个人身份信息或私有域名。所有敏感配置都应放在 Cloudflare Worker 的环境变量或 secrets 中。

### 必需配置

| 名称 | 用途 | 建议配置方式 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot token | `wrangler secret put TELEGRAM_BOT_TOKEN` |
| `WEBHOOK_REGISTRATION_SECRET` | 注册 webhook 时使用的独立口令，不要复用 bot token | `wrangler secret put WEBHOOK_REGISTRATION_SECRET` |
| `OPENROUTER_API_KEY` | OpenRouter API key | `wrangler secret put OPENROUTER_API_KEY` |
| `TG_DB` | Cloudflare KV namespace binding | `wrangler.toml` binding |

### 可选配置

| 名称 | 用途 |
| --- | --- |
| `CHAT_WHITE_LIST` | 逗号分隔的 Telegram chat id 白名单；留空表示不启用白名单 |
| `APP_PUBLIC_URL` | OpenRouter `HTTP-Referer`，建议使用公开仓库或项目主页 URL |
| `APP_TITLE` | OpenRouter `X-Title` |

## 注册 webhook

部署 Worker 后访问：

```text
https://<your-worker-domain>/registerWebhook?secret=<WEBHOOK_REGISTRATION_SECRET>
```

不要把 `TELEGRAM_BOT_TOKEN` 放在 URL 里；URL 可能被浏览器历史、日志或代理记录。

## 发布为 public 前的检查清单

1. 确认没有提交 `.env`、`.dev.vars`、私钥、证书、日志等本地文件。
2. 确认源码和 README 中没有真实 token、API key、个人姓名、学校/公司、私有域名或真实 chat id。
3. 检查 Git 历史；如果历史中曾经提交过敏感内容，公开前需要重写历史或创建干净的新仓库。
4. 如果任何真实密钥曾经进入 Git 历史，即使之后删除，也应立即轮换对应密钥。
