# VoxMem - 会记忆的语音输入工作台

## 系统运行指南（如何运行程序）

VoxMem 是一个面向高频中文语音输入场景的 Web 应用。它通过浏览器采集麦克风音频，由 Go 后端代理到阿里云 DashScope Paraformer 实时语音识别，再结合本地纠错记忆和 LLM 文本整理，把口语输入变成更可用的文本。

核心演示点：

- 实时语音识别：浏览器录音后实时显示识别文本。
- 本地纠错记忆：用户把识别错误改正确后，系统会记录替换规则，下次自动应用。
- 口语文本整理：支持原声、轻整理、Markdown 输出模式。
- 可选声纹过滤：通过文件转写和说话人分离减少周围人声混入。
- Mock 演示模式：没有云端 API Key 时也可以演示完整页面和本地记忆流程。

## 环境准备

1. 安装 Node.js 20+：[下载地址](https://nodejs.org/)
2. 安装 npm 10+（Node.js 通常自带）
3. 安装 Go 1.25.x：[下载地址](https://go.dev/dl/)
4. 使用 Chrome 或 Edge 浏览器
5. 获取必要 API Key：
   - DashScope API Key：用于 Paraformer 实时 ASR
   - OpenAI 兼容 LLM API Key：用于轻整理和 Markdown 模式
   - 七牛 Kodo 配置：仅在使用声纹过滤文件转写流程时需要

## 配置文件

在项目根目录复制环境变量模板：

```powershell
cd D:\VoxMem
Copy-Item .env.example .env
```

使用真实 ASR 时，至少填写：

```text
DASHSCOPE_API_KEY=your-dashscope-api-key
```

使用轻整理或 Markdown 模式时，填写：

```text
VOXMEM_LLM_API_KEY=your-llm-api-key
VOXMEM_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VOXMEM_LLM_MODEL=qwen-plus
```

只演示原声模式和本地记忆时，可以不配置 LLM。

## 后端启动

```powershell
cd D:\VoxMem\server
go run .\cmd\server
```

默认后端地址：

```text
http://127.0.0.1:8080
```

健康检查地址：

```text
http://127.0.0.1:8080/healthz
```

## 前端启动

```powershell
cd D:\VoxMem\web
npm install
npm run dev
```

访问应用：

```text
http://127.0.0.1:5173
```

如果前端端口被占用，可以指定新端口：

```powershell
cd D:\VoxMem\web
npm run dev -- --host 127.0.0.1 --port 5174
```

如果后端地址不是默认地址，启动前端前设置：

```powershell
$env:VITE_API_BASE_URL = "http://127.0.0.1:8080"
npm run dev
```

## Mock 模式启动（无 API Key 兜底演示）

评审现场如果没有可用的 DashScope API Key，可以使用 Mock ASR 模式演示页面、录音交互、文本编辑、本地记忆和指标流程。

PowerShell 窗口 1：

```powershell
cd D:\VoxMem\server
$env:VOXMEM_ASR_MODE = "mock"
$env:VOXMEM_ASR_MOCK_TEXT = "今天找张力确认声纹过滤方案"
$env:VOXMEM_ALLOWED_ORIGINS = "http://127.0.0.1:5173"
go run .\cmd\server
```

PowerShell 窗口 2：

```powershell
cd D:\VoxMem\web
npm install
npm run dev
```



## 声纹过滤配置（可选）

声纹过滤不是实时声纹识别，而是通过完整 WAV 文件转写和说话人分离实现。该流程需要七牛 Kodo 暂存音频文件，再把可访问 URL 提交给 DashScope 文件转写接口。

```powershell
$env:VOXMEM_KODO_ACCESS_KEY = "your-qiniu-access-key"
$env:VOXMEM_KODO_SECRET_KEY = "your-qiniu-secret-key"
$env:VOXMEM_KODO_BUCKET = "your-bucket"
$env:VOXMEM_KODO_REGION = "z0"
$env:VOXMEM_KODO_DOMAIN = "https://your-download-domain.example.com"
$env:VOXMEM_KODO_USE_HTTPS = "true"
```

私有 bucket 需要额外配置：

```powershell
$env:VOXMEM_KODO_PRIVATE_BUCKET = "true"
$env:VOXMEM_KODO_URL_TTL_SECONDS = "3600"
```

## 验证命令

后端测试：

```powershell
cd D:\VoxMem\server
go test ./...
```

前端构建：

```powershell
cd D:\VoxMem\web
npm install
npm run build
```

前端 E2E：

```powershell
cd D:\VoxMem\web
npm run test:e2e
```

ASR 探针：

```powershell
cd D:\VoxMem\server
go run .\cmd\asr-probe -check-only
```

使用本地 WAV 验证识别：

```powershell
cd D:\VoxMem\server
go run .\cmd\asr-probe -audio D:\path\to\sample.wav -format wav
```

## 常见问题

### 页面显示 API 未连接

确认后端是否已启动，并检查 `VITE_API_BASE_URL` 是否指向正确后端地址。

### WebSocket 连接失败

确认 `VOXMEM_ALLOWED_ORIGINS` 是否包含当前前端地址，例如：

```powershell
$env:VOXMEM_ALLOWED_ORIGINS = "http://127.0.0.1:5173"
```

### 真实 ASR 无法使用

确认 `.env` 中已配置 `DASHSCOPE_API_KEY`，并先运行：

```powershell
cd D:\VoxMem\server
go run .\cmd\asr-probe -check-only
```

### 轻整理或 Markdown 失败

确认已配置 `VOXMEM_LLM_API_KEY`、`VOXMEM_LLM_BASE_URL` 和 `VOXMEM_LLM_MODEL`。如果只需要语音识别和本地记忆，请使用原声模式。

## 当前边界

- 当前优先支持 Chrome / Edge 浏览器。
- 当前不做系统级输入法集成。
- 当前不做账号体系和多端同步，通过浏览器本地 `user_id` 区分用户。
- 实时链路不承诺真正声纹识别，多人声音处理主要依赖可选文件转写流程。
- LLM 只做保守整理，不主动扩写用户没有说过的内容。
- Docker 部署属于后续阶段，当前交付重点是本地可演示 MVP。
