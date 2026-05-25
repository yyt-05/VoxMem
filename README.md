# VoxMem

VoxMem 是一个轻量级语音输入工作台，目标是把「说出来的内容」快速变成可用文本，并通过本地纠错记忆让系统逐步适应用户的专有名词和表达习惯。

当前版本已经包含 React 前端工作台、Go 后端 API、浏览器麦克风采集、实时 WebSocket ASR、OpenAI 兼容的 LLM 文本整理、SQLite 本地纠错记忆、可选的文件转写说话人过滤流程，以及用于 E2E 测试的确定性 mock ASR 模式。Docker 部署属于后续阶段。

## 核心能力

- 实时语音输入：浏览器采集麦克风音频，通过 Go 后端转发到阿里云 DashScope Paraformer 实时 ASR。
- 文本整理：支持 `raw`、`polish`、`markdown` 三种输出模式。
- 本地记忆：用户编辑识别结果后，系统会把修正记录写入 SQLite，并提取本地替换映射。
- 可见反馈：前端显示实时转写、最终文本、整理结果、本地记忆和错误状态。
- 可选声纹过滤：文件转写流程可上传完整 WAV 到七牛 Kodo，再交给 DashScope 文件转写做说话人分离。
- 可测试模式：mock ASR 模式可以稳定跑前端 E2E，不依赖真实语音服务。

## 本地开发环境

建议使用 Windows + PowerShell。

依赖：

- Node.js 20+
- npm 10+
- Go 1.22+

复制并填写本地配置：

```powershell
cd D:\VoxMem
Copy-Item .env.example .env
```

至少需要配置 `D:\VoxMem\.env` 中的 `DASHSCOPE_API_KEY`，才能使用真实实时 ASR。

## 启动后端

```powershell
cd D:\VoxMem\server
go run .\cmd\server
```

默认监听 `http://127.0.0.1:8080`。

## 启动前端

```powershell
cd D:\VoxMem\web
npm install
npm run dev
```

然后打开：

```text
http://127.0.0.1:5173
```

如果 `5173` 端口被占用，可以换端口：

```powershell
cd D:\VoxMem\web
npm run dev -- --host 127.0.0.1 --port 5174
```

如果后端地址不是默认值，启动前端前设置：

```powershell
$env:VITE_API_BASE_URL = "http://127.0.0.1:8080"
npm run dev
```

## 输出模式

- `raw`：只应用本地替换记忆，不调用 LLM。
- `polish`：调用 LLM 做保守文本整理，处理明显口误、自我纠正和基础可读性问题。
- `markdown`：调用 LLM，把口语内容整理成 Markdown 正文。

使用 `polish` 或 `markdown` 前，需要配置 LLM：

```powershell
$env:VOXMEM_LLM_API_KEY = "your-llm-api-key"
$env:VOXMEM_LLM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:VOXMEM_LLM_MODEL = "qwen-plus"
```

LLM 后处理失败时，VoxMem 不会静默降级。缺少密钥、请求超时或上游错误都会在前端显示为可见错误。只需要 ASR 和本地记忆时，请使用 `raw` 模式。

## 实时 ASR

设置 `DASHSCOPE_API_KEY` 后，启动后端和前端，在页面中开始录音即可。

工作流：

1. 浏览器采集麦克风音频。
2. 前端通过 WebSocket 发送音频帧到 Go 后端。
3. 后端连接 DashScope Paraformer 实时 ASR。
4. 前端展示中间结果和最终结果。
5. 停止录音后，系统把本地记忆增强后的文本放入可编辑输入区。
6. 用户编辑文本后，系统等待文本稳定并自动触发对应输出模式。
7. 如果编辑后的文本和 ASR 增强文本不同，后端会记录纠错并生成本地替换记忆。

## ASR 探针

设置 `DASHSCOPE_API_KEY` 后，可以先验证阿里云 Paraformer WebSocket 鉴权和任务启动：

```powershell
cd D:\VoxMem\server
go run .\cmd\asr-probe -check-only
```

使用本地音频验证识别。默认输入为单声道 16kHz PCM：

```powershell
cd D:\VoxMem\server
go run .\cmd\asr-probe -audio D:\path\to\sample.pcm
```

如果是 WAV 文件：

```powershell
cd D:\VoxMem\server
go run .\cmd\asr-probe -audio D:\path\to\sample.wav -format wav
```

## 文件转写与说话人过滤

可选的文件转写流程会录制完整浏览器 WAV，调用 `POST /api/transcribe/file`，上传到七牛 Kodo，再把可下载 URL 提交给 DashScope 文件转写，并启用说话人分离。接口返回 `sentences`、`full_text` 和 `speaker_count`，前端可以让用户只保留一个检测到的说话人。

使用该流程前需要配置七牛 Kodo：

```powershell
$env:VOXMEM_KODO_ACCESS_KEY = "your-qiniu-access-key"
$env:VOXMEM_KODO_SECRET_KEY = "your-qiniu-secret-key"
$env:VOXMEM_KODO_BUCKET = "your-bucket"
$env:VOXMEM_KODO_REGION = "z0"
$env:VOXMEM_KODO_DOMAIN = "https://your-download-domain.example.com"
$env:VOXMEM_KODO_USE_HTTPS = "true"
```

`VOXMEM_KODO_REGION` 支持 `z0`、`z1`、`z2`、`na0`、`as0`、`cn-east-2`。`VOXMEM_KODO_DOMAIN` 必须能被 DashScope 访问。

如果使用私有 bucket，还需要：

```powershell
$env:VOXMEM_KODO_PRIVATE_BUCKET = "true"
$env:VOXMEM_KODO_URL_TTL_SECONDS = "3600"
```

## 调试日志与音频留存

后端会输出结构化日志，覆盖：

- HTTP 请求方法、路径和耗时。
- ASR 会话启动、模式、任务 ID、音频格式和采样率。
- 浏览器音频帧数量和字节数。
- 浏览器停止请求和会话时长。
- ASR 转写转发和最终输出事件。

前端开发控制台会输出健康检查、麦克风权限、WebSocket 消息、WebSocket 错误和音频帧发送日志。

如需保存麦克风音频用于排查问题，启动后端前设置：

```powershell
$env:VOXMEM_AUDIO_DEBUG_ENABLED = "true"
$env:VOXMEM_AUDIO_DEBUG_DIR = "D:\VoxMem\tmp\audio-debug"
cd D:\VoxMem\server
go run .\cmd\server
```

每次 ASR 会话会写出原始 PCM 和可播放 WAV：

```text
D:\VoxMem\tmp\audio-debug\<task_id>.pcm
D:\VoxMem\tmp\audio-debug\<task_id>.wav
```

优先用 WAV 文件确认浏览器是否真的采集到了清晰语音，再继续排查 ASR 服务。

## 验证命令

后端测试：

```powershell
cd D:\VoxMem\server
go test ./...
```

前端构建和 E2E：

```powershell
cd D:\VoxMem\web
npm install
npm run build
npm run test:e2e
```

## 确定性 E2E 模式

本地 E2E 可以使用 mock ASR，避免依赖真实 DashScope 服务：

```powershell
$env:VOXMEM_ASR_MODE = "mock"
$env:VOXMEM_ALLOWED_ORIGINS = "http://127.0.0.1:5175"
cd D:\VoxMem\server
go run .\cmd\server
```

## 当前边界

- 当前优先支持 Chrome / Edge 浏览器。
- 当前不做系统级输入法集成。
- 当前不做账号体系和多端同步，用户通过浏览器本地 `user_id` 区分。
- 实时模式不承诺真正声纹识别；多人声音处理主要依赖可选文件转写流程。
- LLM 只负责保守整理文本，不应改写事实或主动扩写用户没有说过的内容。
- 本地记忆主要保存纠错记录和替换映射，不是完整个人知识库。

## 开发约定

- 每个变更保持单一主题。
- 合并后目标分支应保持可运行。
- 提交或 PR 描述中记录执行过的验证命令和结果。
