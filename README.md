# VoxMem

VoxMem is a lightweight voice input workspace for fast ASR, conservative LLM text cleanup, and user-level correction memory.

The current implementation includes a React workbench, Go API health checks, browser microphone capture, realtime WebSocket ASR streaming, and a deterministic mock ASR mode for E2E tests. LLM post-processing, SQLite memory, and deployment are implemented in later phases.

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

Then open `http://127.0.0.1:5174/`. Realtime ASR results appear in the transcript panel, and final sentence text appears in the editable output area after stopping the recording.

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
