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

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const recordingStateRef = useRef<RecordingState>('idle');
  const finalSegmentsRef = useRef<string[]>([]);

  const statusLabel = useMemo(() => {
    if (healthState === 'ok') return 'API 已连接';
    if (healthState === 'checking') return '正在检查 API';
    return 'API 未连接';
  }, [healthState]);

  const canStart = healthState === 'ok' && !['connecting', 'recording', 'stopping'].includes(recordingState);
  const canStop = recordingState === 'recording';

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
      const response = await fetch(`${apiBaseUrl}/healthz`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as HealthPayload;
      setHealth(payload);
      setHealthState('ok');
    } catch (err) {
      setHealth(null);
      setHealthState('error');
      setError(err instanceof Error ? err.message : '无法连接 API');
    }
  }

  async function startRecording() {
    setError(null);
    setLiveText('');
    setFinalText('');
    setTaskId(null);
    setRecorderStats({ frames: 0, bytes: 0, level: 0 });
    finalSegmentsRef.current = [];
    setRecordingStateSafe('connecting');

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = mediaStream;

      const ws = new WebSocket(`${toWebSocketBase(apiBaseUrl)}/ws/asr?user_id=${encodeURIComponent(getUserID())}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data) as ASRMessage;
        handleASRMessage(message, ws, mediaStream);
      };
      ws.onerror = () => {
        setError('语音识别连接失败，请检查后端服务和 DASHSCOPE_API_KEY。');
        setRecordingStateSafe('error');
        cleanupAudio();
      };
      ws.onclose = () => {
        if (recordingStateRef.current === 'recording' || recordingStateRef.current === 'connecting') {
          cleanupAudio();
          setRecordingStateSafe('completed');
        }
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法打开麦克风');
      setRecordingStateSafe('error');
      cleanupAudio();
    }
  }

  function handleASRMessage(message: ASRMessage, ws: WebSocket, mediaStream: MediaStream) {
    if (message.type === 'ready') {
      setTaskId(message.task_id ?? null);
      try {
        startAudioProcessing(mediaStream, ws);
        setRecordingStateSafe('recording');
      } catch (err) {
        setError(err instanceof Error ? err.message : '音频采集失败');
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
      ws.close();
      setRecordingStateSafe('completed');
      return;
    }

    if (message.type === 'error') {
      setError(message.message ?? '语音识别失败');
      cleanupAudio();
      ws.close();
      setRecordingStateSafe('error');
    }
  }

  function stopRecording() {
    setRecordingStateSafe('stopping');
    cleanupAudio();

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      return;
    }

    setRecordingStateSafe('completed');
  }

  function startAudioProcessing(mediaStream: MediaStream, ws: WebSocket) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('当前浏览器不支持 AudioContext');
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
      setRecorderStats((stats) => ({
        frames: stats.frames + 1,
        bytes: stats.bytes + pcm.byteLength,
        level,
      }));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

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
          <h1>语音输入工作台</h1>
        </div>
        <div className={`status-pill status-${healthState}`}>
          <Server size={16} aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>
      </header>

      <section className="workspace" aria-label="语音输入工作台">
        <div className="recorder-panel">
          <div className="mode-switch" aria-label="输出模式">
            {[
              ['polish', '轻整理'],
              ['raw', '原声'],
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
            className={`record-button ${recordingState === 'recording' ? 'recording' : ''}`}
            type="button"
            disabled={!canStart}
            onClick={() => void startRecording()}
            title="开始录音"
          >
            <Mic size={28} aria-hidden="true" />
            <span>{recordingState === 'recording' ? '录音中' : '开始'}</span>
          </button>

          <div className="actions">
            <button type="button" onClick={() => void checkHealth()}>
              <RefreshCw size={16} aria-hidden="true" />
              <span>重试 API</span>
            </button>
            <button type="button" disabled={!canStop} onClick={stopRecording}>
              <Square size={16} aria-hidden="true" />
              <span>停止</span>
            </button>
          </div>
        </div>

        <div className="text-grid">
          <section className="text-pane">
            <div className="pane-heading">
              <h2>实时识别</h2>
              <span>{recordingStateLabel(recordingState)}</span>
            </div>
            <p className={liveText ? 'transcript-text' : 'placeholder'}>
              {liveText || '点击开始并说话，实时识别文本会显示在这里。'}
            </p>
          </section>

          <section className="text-pane">
            <div className="pane-heading">
              <h2>最终输出</h2>
              <span>{mode === 'markdown' ? 'Markdown' : mode === 'raw' ? '原声' : '轻整理'}</span>
            </div>
            <textarea
              aria-label="最终输出文本"
              value={finalText}
              onChange={(event) => setFinalText(event.target.value)}
              placeholder="停止录音后，最终识别文本会显示在这里。LLM 整理和本地热词记忆将在后续阶段接入。"
              rows={8}
            />
          </section>
        </div>
      </section>

      <section className="diagnostics" aria-label="运行状态">
        <div>
          <span>API</span>
          <strong>{apiBaseUrl}</strong>
        </div>
        <div>
          <span>服务</span>
          <strong>{health?.service ?? '离线'}</strong>
        </div>
        <div>
          <span>环境</span>
          <strong>{health?.env ?? '-'}</strong>
        </div>
        <div>
          <span>最近检查</span>
          <strong>{health?.timestamp ? new Date(health.timestamp).toLocaleTimeString() : '-'}</strong>
        </div>
        <div>
          <span>录音状态</span>
          <strong>{recordingStateLabel(recordingState)}</strong>
        </div>
        <div>
          <span>ASR 任务</span>
          <strong>{taskId ?? '-'}</strong>
        </div>
        <div>
          <span>音频帧</span>
          <strong>{recorderStats.frames}</strong>
        </div>
        <div>
          <span>音量</span>
          <strong>{recorderStats.level.toFixed(4)}</strong>
        </div>
      </section>

      {error ? <p className="error-banner">错误：{error}</p> : null}
    </main>
  );
}

export default App;

function downsample(input: Float32Array, inputSampleRate: number, outputSampleRate: number) {
  if (outputSampleRate === inputSampleRate) {
    return input;
  }
  if (outputSampleRate > inputSampleRate) {
    throw new Error('目标采样率不能高于输入采样率');
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
    idle: '待录音',
    connecting: '连接中',
    recording: '录音中',
    stopping: '停止中',
    completed: '已完成',
    error: '错误',
  };
  return labels[state];
}
