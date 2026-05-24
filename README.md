# VoxMem

VoxMem is a lightweight voice input workspace for fast ASR, conservative LLM text cleanup, and user-level correction memory.

The current implementation includes a React workbench, Go API health checks, browser microphone capture, realtime WebSocket ASR streaming, OpenAI-compatible LLM post-processing, SQLite-backed local correction memory, and a deterministic mock ASR mode for E2E tests. Docker deployment is implemented in a later phase.

## Local Development

Prerequisites:

- Node.js 20+
- npm 10+
- Go 1.22+

Start the Go API:

```powershell
cd D:\VoxMem\server
go run .\cmd\server
```

Start the web app:

```powershell
cd D:\VoxMem\web
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

For `polish` and `markdown` output modes, configure the LLM before starting the Go API:

```powershell
$env:VOXMEM_LLM_API_KEY = "your-llm-api-key"
$env:VOXMEM_LLM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:VOXMEM_LLM_MODEL = "qwen-plus"
```

VoxMem does not silently fall back when LLM post-processing fails. Missing keys, timeout, or upstream errors are returned to the web app as visible errors. Use `raw` mode when you only want ASR output plus local replacement memory.

The web app calls `http://127.0.0.1:8080/healthz` by default. To use a different API URL:

```powershell
$env:VITE_API_BASE_URL = "http://127.0.0.1:8080"
npm run dev
```

## Validation

Backend:

```powershell
cd D:\VoxMem\server
go test ./...
```

Frontend:

```powershell
cd D:\VoxMem\web
npm install
npm run build
npm run test:e2e
```

## ASR Probe

After setting `DASHSCOPE_API_KEY` in `D:\VoxMem\.env`, verify Aliyun Paraformer WebSocket authentication and task startup:

```powershell
cd D:\VoxMem\server
go run .\cmd\asr-probe -check-only
```

To verify recognition with a local audio file, use mono 16kHz PCM by default:

```powershell
cd D:\VoxMem\server
go run .\cmd\asr-probe -audio D:\path\to\sample.pcm
```

For a WAV file, set the format flag:

```powershell
cd D:\VoxMem\server
go run .\cmd\asr-probe -audio D:\path\to\sample.wav -format wav
```

## Realtime ASR

With the Go API running and `DASHSCOPE_API_KEY` set in `D:\VoxMem\.env`, open the web app and start recording.

If another app already uses port `5173`, start VoxMem on another port:

```powershell
cd D:\VoxMem\web
npm run dev -- --host 127.0.0.1 --port 5174
```

Then open `http://127.0.0.1:5174/`. Realtime ASR results appear in the transcript panel, and local-memory-enhanced input text appears in the editable input area after stopping the recording.

The output modes are:

- `raw`: apply local replacement memory and return the resulting text without calling the LLM.
- `polish`: call the configured LLM for conservative cleanup and self-correction handling.
- `markdown`: call the configured LLM and request Markdown body output.

When you edit the input text, the web app waits briefly for the text to stabilize, then automatically sends it to the API for `raw`, `polish`, or `markdown` processing. If the edited input differs from the local-memory-enhanced ASR text, the API stores a correction record in SQLite and extracts a local `from_text -> to_text` replacement. Future ASR final text for the same browser `user_id` applies those replacements before any LLM call. Newly learned replacements appear in a dismissible memory dialog with an undo action, and the hotword memory panel shows recent replacements and allows deletion.

## File Transcription Voice Filter

The optional voice-filter flow records the full browser WAV, posts it to `POST /api/transcribe/file`, uploads it to Qiniu Kodo, then submits the downloadable URL to DashScope file transcription with speaker diarization enabled. The API returns `sentences`, `full_text`, and `speaker_count`; the web app can then let the user keep one detected speaker.

Configure Kodo before using this flow. Supported `VOXMEM_KODO_REGION` values include `z0`, `z1`, `z2`, `na0`, `as0`, and `cn-east-2`.

```powershell
$env:VOXMEM_KODO_ACCESS_KEY = "your-qiniu-access-key"
$env:VOXMEM_KODO_SECRET_KEY = "your-qiniu-secret-key"
$env:VOXMEM_KODO_BUCKET = "your-bucket"
$env:VOXMEM_KODO_REGION = "z0"
$env:VOXMEM_KODO_DOMAIN = "https://your-download-domain.example.com"
$env:VOXMEM_KODO_USE_HTTPS = "true"
```

`VOXMEM_KODO_DOMAIN` must be reachable by DashScope. For private Kodo buckets, also set:

```powershell
$env:VOXMEM_KODO_PRIVATE_BUCKET = "true"
$env:VOXMEM_KODO_URL_TTL_SECONDS = "3600"
```

## Debug Logs and Audio Capture

The API writes structured logs for these core events:

- HTTP request method, path, and duration.
- ASR session startup, mode, task id, audio format, and sample rate.
- Browser audio frame counts and byte counts.
- Browser stop requests and session duration.
- ASR transcript forwarding and final output events.

The web app also writes development console logs for health checks, microphone access, WebSocket messages, WebSocket errors, and periodic audio frame sends.

To save microphone audio for debugging, enable the audio debug recorder before starting the Go API:

```powershell
$env:VOXMEM_AUDIO_DEBUG_ENABLED = "true"
$env:VOXMEM_AUDIO_DEBUG_DIR = "D:\VoxMem\tmp\audio-debug"
cd D:\VoxMem\server
go run .\cmd\server
```

Each ASR session writes both raw PCM and playable WAV files:

```text
D:\VoxMem\tmp\audio-debug\<task_id>.pcm
D:\VoxMem\tmp\audio-debug\<task_id>.wav
```

Use the WAV file to verify whether the browser actually captured clear speech before debugging the ASR service.

## Deterministic E2E Mode

For deterministic local E2E checks, run the API in mock ASR mode:

```powershell
$env:VOXMEM_ASR_MODE = "mock"
$env:VOXMEM_ALLOWED_ORIGINS = "http://127.0.0.1:5175"
cd D:\VoxMem\server
go run .\cmd\server
```

## Development Workflow

- Keep each pull request focused on one feature, fix, or workflow change.
- Keep the target branch runnable after every merge.
- Record validation commands and results in every pull request description.
