# 幕语 · MUYU Subtitle Studio

本地字幕翻译工作台。你提供兼容 OpenAI Chat Completions 的接口地址和 API Key；字幕、进度和术语保存在当前浏览器。

A local subtitle translation workspace. Bring your own OpenAI-compatible endpoint and API key. Subtitles, progress, and glossary stay in this browser.

## 功能 / Features

- SRT / VTT，中英界面，浅色 / 深色
- 按语义分块，携带前后文与背景设定
- 可选术语库：关闭后不发送、不提取术语；已保存词条仍留在本地
- 暂停、续译、对照编辑、备份导入导出
- 浏览器直连模型，必要时回退到本机转发

## 运行 / Run

需要 Go 1.23+ 与 Node 22+。

```bash
make build
./bin/muyu
```

打开 http://127.0.0.1:7777 。首次构建会安装前端依赖。

```bash
# Docker
docker compose up -d --build
```

常用环境变量：`LISTEN_HOST`、`LISTEN_PORT`、`UI_LANG`（`en` / `zh-CN`）、`API_HOSTS`（服务器转发白名单，不限制浏览器直连）。

## 开发 / Develop

```bash
make build
go run ./cmd/muyu
# 另开终端
cd web && npm run dev
```

```bash
make test
cd web && npx playwright install --with-deps chromium
make test-e2e
```

任务记录、API Key（可选记住）和界面偏好都保存在 localStorage。换浏览器或清空站点数据前请先导出备份。
