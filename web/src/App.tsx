import { Mic, RefreshCw, Server, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type HealthState = 'checking' | 'ok' | 'error';
type RecordingState = 'idle' | 'connecting' | 'recording' | 'stopping' | 'completed' | 'error';

type HealthPayload = {
  status: string;
  service: string;
  env: string;
  timestamp: string;
};

type ASRMessage = {
  type: 'ready' | 'transcript' | 'done' | 'error';
  task_id?: string;
  text?: string;
  final?: boolean;
  message?: string;
};

type RecorderStats = {
  frames: number;
  bytes: number;
  level: number;
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8080';
const targetSampleRate = 16000;
const debugEnabled = import.meta.env.DEV;
const waveBarCount = 24;

const text = {
  apiConnected: '\u0041\u0050\u0049 \u5df2\u8fde\u63a5',
  apiChecking: '\u6b63\u5728\u68c0\u67e5 \u0041\u0050\u0049',
  apiOffline: '\u0041\u0050\u0049 \u672a\u8fde\u63a5',
  workspaceTitle: '\u8bed\u97f3\u8f93\u5165\u5de5\u4f5c\u53f0',
  outputMode: '\u8f93\u51fa\u6a21\u5f0f',
  polish: '\u8f7b\u6574\u7406',
  raw: '\u539f\u58f0',
  start: '\u5f00\u59cb',
  recording: '\u5f55\u97f3\u4e2d',
  retryAPI: '\u91cd\u8bd5 API',
  stop: '\u505c\u6b62',
  realtimeTranscript: '\u5b9e\u65f6\u8bc6\u522b',
  realtimePlaceholder: '\u70b9\u51fb\u5f00\u59cb\u5e76\u8bf4\u8bdd\uff0c\u5b9e\u65f6\u8bc6\u522b\u6587\u672c\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002',
  finalOutput: '\u6700\u7ec8\u8f93\u51fa',
  finalOutputAria: '\u6700\u7ec8\u8f93\u51fa\u6587\u672c',
  finalPlaceholder:
    '\u505c\u6b62\u5f55\u97f3\u540e\uff0c\u6700\u7ec8\u8bc6\u522b\u6587\u672c\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002LLM \u6574\u7406\u548c\u672c\u5730\u70ed\u8bcd\u8bb0\u5fc6\u5c06\u5728\u540e\u7eed\u9636\u6bb5\u63a5\u5165\u3002',
  runtimeStatus: '\u8fd0\u884c\u72b6\u6001',
  service: '\u670d\u52a1',
  offline: '\u79bb\u7ebf',
  environment: '\u73af\u5883',
  lastCheck: '\u6700\u8fd1\u68c0\u67e5',
  recorder: '\u5f55\u97f3\u72b6\u6001',
  asrTask: 'ASR \u4efb\u52a1',
  voiceWave: '\u97f3\u6ce2',
  errorPrefix: '\u9519\u8bef\uff1a',
  cannotConnectAPI: '\u65e0\u6cd5\u8fde\u63a5 API',
  asrConnectionFailed: '\u8bed\u97f3\u8bc6\u522b\u8fde\u63a5\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u540e\u7aef\u670d\u52a1\u548c DASHSCOPE_API_KEY\u3002',
  cannotOpenMic: '\u65e0\u6cd5\u6253\u5f00\u9ea6\u514b\u98ce',
  audioCaptureFailed: '\u97f3\u9891\u91c7\u96c6\u5931\u8d25',
  asrFailed: '\u8bed\u97f3\u8bc6\u522b\u5931\u8d25',
  audioContextUnsupported: '\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 AudioContext',
  sampleRateError: '\u76ee\u6807\u91c7\u6837\u7387\u4e0d\u80fd\u9ad8\u4e8e\u8f93\u5165\u91c7\u6837\u7387',
  startRecordingTitle: '\u5f00\u59cb\u5f55\u97f3',
};

function App() {
  const [healthState, setHealthState] = useState<HealthState>('checking');
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'polish' | 'raw' | 'markdown'>('polish');
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [liveText, setLiveText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [recorderStats, setRecorderStats] = useState<RecorderStats>({ frames: 0, bytes: 0, level: 0 });
  const [waveLevels, setWaveLevels] = useState<number[]>(() => createSilentWave());

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const recordingStateRef = useRef<RecordingState>('idle');
  const finalSegmentsRef = useRef<string[]>([]);

  const statusLabel = useMemo(() => {
    if (healthState === 'ok') return text.apiConnected;
    if (healthState === 'checking') return text.apiChecking;
    return text.apiOffline;
  }, [healthState]);

  const isRecordingActive = ['connecting', 'recording', 'stopping'].includes(recordingState);
  const canUseRecordButton = healthState === 'ok' && !['connecting', 'stopping'].includes(recordingState);

  useEffect(() => {
    void checkHealth();

    return () => {
      cleanupAudio();
      wsRef.current?.close();
    };
  }, []);

  async function checkHealth() {
    setHealthState('checking');
    setError(null);

    try {
      debugLog('health check start', { apiBaseUrl });
      const response = await fetch(`${apiBaseUrl}/healthz`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as HealthPayload;
      setHealth(payload);
      setHealthState('ok');
      debugLog('health check ok', payload);
    } catch (err) {
      setHealth(null);
      setHealthState('error');
      setError(err instanceof Error ? err.message : text.cannotConnectAPI);
      debugLog('health check failed', err instanceof Error ? err.message : err);
    }
  }

  async function startRecording() {
    setError(null);
    setLiveText('');
    setFinalText('');
    setTaskId(null);
    setRecorderStats({ frames: 0, bytes: 0, level: 0 });
    setWaveLevels(createSilentWave());
    finalSegmentsRef.current = [];
    setRecordingStateSafe('connecting');

    try {
      debugLog('recording start requested');
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = mediaStream;
      debugLog('microphone opened', mediaStream.getAudioTracks().map((track) => track.label));

      const ws = new WebSocket(`${toWebSocketBase(apiBaseUrl)}/ws/asr?user_id=${encodeURIComponent(getUserID())}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data) as ASRMessage;
        debugLog('ws message', message);
        handleASRMessage(message, ws, mediaStream);
      };
      ws.onerror = () => {
        debugLog('ws error');
        setError(text.asrConnectionFailed);
        setRecordingStateSafe('error');
        cleanupAudio();
      };
      ws.onclose = () => {
        debugLog('ws closed', { state: recordingStateRef.current });
        if (recordingStateRef.current === 'recording' || recordingStateRef.current === 'connecting') {
          cleanupAudio();
          setRecordingStateSafe('completed');
        }
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : text.cannotOpenMic);
      setRecordingStateSafe('error');
      cleanupAudio();
      debugLog('recording start failed', err instanceof Error ? err.message : err);
    }
  }

  function handleASRMessage(message: ASRMessage, ws: WebSocket, mediaStream: MediaStream) {
    if (message.type === 'ready') {
      setTaskId(message.task_id ?? null);
      try {
        startAudioProcessing(mediaStream, ws);
        setRecordingStateSafe('recording');
      } catch (err) {
        setError(err instanceof Error ? err.message : text.audioCaptureFailed);
        setRecordingStateSafe('error');
        cleanupAudio();
      }
      return;
    }

    if (message.type === 'transcript' && message.text) {
      if (message.final) {
        finalSegmentsRef.current = [...finalSegmentsRef.current, message.text];
        const joined = finalSegmentsRef.current.join('');
        setFinalText(joined);
        setLiveText(joined);
      } else {
        setLiveText(`${finalSegmentsRef.current.join('')}${message.text}`);
      }
      return;
    }

    if (message.type === 'done') {
      cleanupAudio();
      setWaveLevels(createSilentWave());
      ws.close();
      setRecordingStateSafe('completed');
      return;
    }

    if (message.type === 'error') {
      setError(message.message ?? text.asrFailed);
      cleanupAudio();
      setWaveLevels(createSilentWave());
      ws.close();
      setRecordingStateSafe('error');
    }
  }

  function stopRecording() {
    debugLog('recording stop requested', recorderStats);
    setRecordingStateSafe('stopping');
    cleanupAudio();
    setWaveLevels(createSilentWave());

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      return;
    }

    setRecordingStateSafe('completed');
  }

  function toggleRecording() {
    if (recordingStateRef.current === 'recording') {
      stopRecording();
      return;
    }
    void startRecording();
  }

  function startAudioProcessing(mediaStream: MediaStream, ws: WebSocket) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error(text.audioContextUnsupported);
    }

    const audioContext = new AudioContextClass();
    const source = audioContext.createMediaStreamSource(mediaStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (ws.readyState !== WebSocket.OPEN || recordingStateRef.current !== 'recording') {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsample(input, audioContext.sampleRate, targetSampleRate);
      const pcm = encodePCM16(downsampled);
      ws.send(pcm);
      const level = calculateRMS(input);
      const normalizedLevel = normalizeVoiceLevel(level);
      setWaveLevels((levels) => [...levels.slice(1), normalizedLevel]);
      setRecorderStats((stats) => {
        const next = {
          frames: stats.frames + 1,
          bytes: stats.bytes + pcm.byteLength,
          level,
        };
        if (debugEnabled && next.frames % 100 === 1) {
          debugLog('audio frame sent', { frames: next.frames, bytes: next.bytes, level });
        }
        return next;
      });
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    debugLog('audio processing started', { inputSampleRate: audioContext.sampleRate, targetSampleRate });

    audioContextRef.current = audioContext;
    sourceRef.current = source;
    processorRef.current = processor;
  }

  function cleanupAudio() {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();

    processorRef.current = null;
    sourceRef.current = null;
    mediaStreamRef.current = null;
    audioContextRef.current = null;
  }

  function setRecordingStateSafe(nextState: RecordingState) {
    recordingStateRef.current = nextState;
    setRecordingState(nextState);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">VoxMem</p>
          <h1>{text.workspaceTitle}</h1>
        </div>
        <div className={`status-pill status-${healthState}`}>
          <Server size={16} aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>
      </header>

      <section className="workspace" aria-label={text.workspaceTitle}>
        <div className="recorder-panel">
          <div className="mode-switch" aria-label={text.outputMode}>
            {[
              ['polish', text.polish],
              ['raw', text.raw],
              ['markdown', 'Markdown'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={mode === value ? 'active' : ''}
                type="button"
                onClick={() => setMode(value as typeof mode)}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            className={`record-button ${isRecordingActive ? 'recording' : ''}`}
            type="button"
            disabled={!canUseRecordButton}
            onClick={toggleRecording}
            title={text.startRecordingTitle}
          >
            {isRecordingActive ? <Square size={28} aria-hidden="true" /> : <Mic size={28} aria-hidden="true" />}
            <span>{isRecordingActive ? text.stop : text.start}</span>
          </button>

          <div className="actions">
            <button type="button" onClick={() => void checkHealth()}>
              <RefreshCw size={16} aria-hidden="true" />
              <span>{text.retryAPI}</span>
            </button>
          </div>
        </div>

        <div className="text-grid">
          <section className="text-pane">
            <div className="pane-heading">
              <h2>{text.realtimeTranscript}</h2>
              <span>{recordingStateLabel(recordingState)}</span>
            </div>
            <p className={liveText ? 'transcript-text' : 'placeholder'}>
              {liveText || text.realtimePlaceholder}
            </p>
          </section>

          <section className="text-pane">
            <div className="pane-heading">
              <h2>{text.finalOutput}</h2>
              <span>{mode === 'markdown' ? 'Markdown' : mode === 'raw' ? text.raw : text.polish}</span>
            </div>
            <textarea
              aria-label={text.finalOutputAria}
              value={finalText}
              onChange={(event) => setFinalText(event.target.value)}
              placeholder={text.finalPlaceholder}
              rows={8}
            />
          </section>
        </div>
      </section>

      <section className="diagnostics" aria-label={text.runtimeStatus}>
        <div>
          <span>API</span>
          <strong>{apiBaseUrl}</strong>
        </div>
        <div>
          <span>{text.service}</span>
          <strong>{health?.service ?? text.offline}</strong>
        </div>
        <div>
          <span>{text.environment}</span>
          <strong>{health?.env ?? '-'}</strong>
        </div>
        <div>
          <span>{text.lastCheck}</span>
          <strong>{health?.timestamp ? new Date(health.timestamp).toLocaleTimeString() : '-'}</strong>
        </div>
        <div>
          <span>{text.recorder}</span>
          <strong>{recordingStateLabel(recordingState)}</strong>
        </div>
        <div>
          <span>{text.asrTask}</span>
          <strong>{taskId ?? '-'}</strong>
        </div>
        <div className="wave-diagnostic">
          <span>{text.voiceWave}</span>
          <div className="wave-bars" aria-label={text.voiceWave}>
            {waveLevels.map((level, index) => (
              <i
                aria-hidden="true"
                key={`${index}-${level.toFixed(3)}`}
                style={{
                  opacity: 0.24 + level * 0.76,
                  transform: `scaleY(${0.08 + level * 0.92})`,
                }}
              />
            ))}
          </div>
        </div>
      </section>

      {error ? <p className="error-banner">{text.errorPrefix}{error}</p> : null}
    </main>
  );
}

export default App;

function downsample(input: Float32Array, inputSampleRate: number, outputSampleRate: number) {
  if (outputSampleRate === inputSampleRate) {
    return input;
  }
  if (outputSampleRate > inputSampleRate) {
    throw new Error(text.sampleRateError);
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j];
    }
    output[i] = sum / Math.max(1, end - start);
  }

  return output;
}

function encodePCM16(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

function calculateRMS(input: Float32Array) {
  if (input.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    sum += input[i] * input[i];
  }
  return Math.sqrt(sum / input.length);
}

function normalizeVoiceLevel(rms: number) {
  const noiseFloor = 0.008;
  return Math.max(0, Math.min(1, (rms - noiseFloor) * 18));
}

function createSilentWave() {
  return Array.from({ length: waveBarCount }, () => 0);
}

function toWebSocketBase(httpBase: string) {
  const url = new URL(httpBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}

function getUserID() {
  const storageKey = 'voxmem_user_id';
  const existing = localStorage.getItem(storageKey);
  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  localStorage.setItem(storageKey, id);
  return id;
}

function recordingStateLabel(state: RecordingState) {
  const labels: Record<RecordingState, string> = {
    idle: '\u5f85\u5f55\u97f3',
    connecting: '\u8fde\u63a5\u4e2d',
    recording: '\u5f55\u97f3\u4e2d',
    stopping: '\u505c\u6b62\u4e2d',
    completed: '\u5df2\u5b8c\u6210',
    error: '\u9519\u8bef',
  };
  return labels[state];
}

function debugLog(message: string, data?: unknown) {
  if (!debugEnabled) {
    return;
  }
  if (data === undefined) {
    console.info(`[VoxMem] ${message}`);
    return;
  }
  console.info(`[VoxMem] ${message}`, data);
}
