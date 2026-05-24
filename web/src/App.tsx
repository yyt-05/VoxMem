import { Mic, RefreshCw, Send, Server, Square, Trash2, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type HealthState = 'checking' | 'ok' | 'error';
type RecordingState = 'idle' | 'connecting' | 'recording' | 'stopping' | 'completed' | 'error';
type OutputMode = 'polish' | 'raw' | 'markdown';
type ProcessingState = 'idle' | 'processing' | 'completed' | 'failed';

type HealthPayload = {
  status: string;
  service: string;
  env: string;
  timestamp: string;
};

type ASRMessage = {
  type: 'ready' | 'transcript' | 'input_ready' | 'processing' | 'processed' | 'done' | 'error';
  task_id?: string;
  text?: string;
  final?: boolean;
  message?: string;
  mode?: OutputMode;
  status?: string;
  source?: string;
  latency_ms?: number;
  original_text?: string;
  enhanced_text?: string;
  mappings?: HotwordMapping[];
};

type HotwordMapping = {
  id: number;
  from_text: string;
  to_text: string;
  correction_count: number;
  hit_count: number;
};

type HotwordsResponse = {
  mappings?: HotwordMapping[];
  error?: string;
};

type CorrectionResponse = {
  status: string;
  mappings?: HotwordMapping[];
  error?: string;
};

type InputCommitResponse = {
  status: string;
  text: string;
  mode: OutputMode;
  source: string;
  latency_ms: number;
  mappings?: HotwordMapping[];
  error?: string;
};

type RecorderStats = {
  frames: number;
  bytes: number;
  level: number;
  peakLevel: number;
};

type MicDiagnostics = {
  label: string;
  state: string;
  muted: boolean;
  sampleRate?: number;
  channelCount?: number;
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
  microphone: '\u9ea6\u514b\u98ce',
  defaultMicrophone: '\u7cfb\u7edf\u9ed8\u8ba4\u9ea6\u514b\u98ce',
  polish: '\u8f7b\u6574\u7406',
  raw: '\u539f\u58f0',
  start: '\u5f00\u59cb',
  recording: '\u5f55\u97f3\u4e2d',
  retryAPI: '\u91cd\u8bd5 API',
  stop: '\u505c\u6b62',
  realtimeTranscript: '\u5b9e\u65f6\u8bc6\u522b',
  realtimePlaceholder: '\u70b9\u51fb\u5f00\u59cb\u5e76\u8bf4\u8bdd\uff0c\u5b9e\u65f6\u8bc6\u522b\u6587\u672c\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002',
  finalOutput: '\u6700\u7ec8\u8f93\u51fa',
  inputText: '\u8f93\u5165\u6587\u672c',
  inputTextAria: '\u8f93\u5165\u6587\u672c',
  processedOutput: '\u5904\u7406\u7ed3\u679c',
  finalPlaceholder:
    '\u505c\u6b62\u5f55\u97f3\u540e\uff0c\u6309\u5f53\u524d\u6a21\u5f0f\u5904\u7406\u7684\u6700\u7ec8\u6587\u672c\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002',
  inputPlaceholder:
    '\u505c\u6b62\u5f55\u97f3\u540e\uff0c\u672c\u5730\u8bb0\u5fc6\u66ff\u6362\u540e\u7684\u53ef\u7f16\u8f91\u6587\u672c\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002',
  rawFinal: '\u539f\u59cb\u8bc6\u522b',
  enhancedFinal: '\u672c\u5730\u66ff\u6362\u540e',
  processing: 'LLM \u5904\u7406\u4e2d',
  processedBy: '\u5904\u7406\u6765\u6e90',
  send: '\u53d1\u9001',
  autoWaiting: '\u7f16\u8f91\u5b8c\u6210\u540e\u70b9\u51fb\u7a7a\u767d\u5904\u6216\u6309\u53d1\u9001\u63d0\u4ea4',
  autoProcessing: '\u5904\u7406\u4e2d',
  autoProcessed: '\u5df2\u5904\u7406',
  correction: '\u63d0\u4ea4\u4fee\u6b63',
  correctionSaved: '\u4fee\u6b63\u5df2\u4fdd\u5b58',
  correctionUnchanged: '\u7f16\u8f91\u6700\u7ec8\u6587\u672c\u540e\u53ef\u63d0\u4ea4\u4fee\u6b63\u3002',
  memoryLearned: '\u5df2\u8bb0\u4f4f\u672c\u5730\u66ff\u6362',
  undo: '\u64a4\u9500',
  close: '\u5173\u95ed',
  hotwordMemory: '\u672c\u5730\u8bb0\u5fc6',
  noHotwords: '\u6682\u65e0\u672c\u5730\u66ff\u6362\u8bb0\u5fc6',
  deleteHotword: '\u5220\u9664\u672c\u5730\u66ff\u6362',
  runtimeStatus: '\u8fd0\u884c\u72b6\u6001',
  service: '\u670d\u52a1',
  offline: '\u79bb\u7ebf',
  environment: '\u73af\u5883',
  lastCheck: '\u6700\u8fd1\u68c0\u67e5',
  recorder: '\u5f55\u97f3\u72b6\u6001',
  inputDevice: '\u8f93\u5165\u8bbe\u5907',
  asrTask: 'ASR \u4efb\u52a1',
  voiceWave: '\u97f3\u6ce2',
  micSilent: '\u672a\u68c0\u6d4b\u5230\u9ea6\u514b\u98ce\u58f0\u97f3\uff0c\u8bf7\u68c0\u67e5\u6d4f\u89c8\u5668\u9ea6\u514b\u98ce\u6743\u9650\u548c\u8f93\u5165\u8bbe\u5907\u3002',
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
  const [mode, setMode] = useState<OutputMode>('polish');
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [liveText, setLiveText] = useState('');
  const [inputText, setInputText] = useState('');
  const [inputBaseline, setInputBaseline] = useState('');
  const [processedText, setProcessedText] = useState('');
  const [rawFinalText, setRawFinalText] = useState('');
  const [enhancedText, setEnhancedText] = useState('');
  const [processingState, setProcessingState] = useState<ProcessingState>('idle');
  const [processingSource, setProcessingSource] = useState('');
  const [processingLatencyMS, setProcessingLatencyMS] = useState<number | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [learnedMappings, setLearnedMappings] = useState<HotwordMapping[]>([]);
  const [memoryDialogOpen, setMemoryDialogOpen] = useState(false);
  const [hotwords, setHotwords] = useState<HotwordMapping[]>([]);
  const [userID] = useState(() => getUserID());
  const [taskId, setTaskId] = useState<string | null>(null);
  const [recorderStats, setRecorderStats] = useState<RecorderStats>({ frames: 0, bytes: 0, level: 0, peakLevel: 0 });
  const [waveLevels, setWaveLevels] = useState<number[]>(() => createSilentWave());
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [micDiagnostics, setMicDiagnostics] = useState<MicDiagnostics | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const recordingStateRef = useRef<RecordingState>('idle');
  const finalSegmentsRef = useRef<string[]>([]);
  const commitSeqRef = useRef(0);
  const lastCommittedKeyRef = useRef('');
  const inFlightCommitKeyRef = useRef<string | null>(null);
  const latestInputKeyRef = useRef('');

  const statusLabel = useMemo(() => {
    if (healthState === 'ok') return text.apiConnected;
    if (healthState === 'checking') return text.apiChecking;
    return text.apiOffline;
  }, [healthState]);

  const isRecordingActive = ['connecting', 'recording', 'stopping'].includes(recordingState);
  const canUseRecordButton = healthState === 'ok' && !['connecting', 'stopping'].includes(recordingState);
  const micLooksSilent = recordingState === 'recording' && recorderStats.frames > 20 && recorderStats.peakLevel < 0.001;
  const canSendInput = inputText.trim() !== '' && processingState !== 'processing';

  useEffect(() => {
    void checkHealth();
    void refreshAudioDevices();
    void loadHotwords();

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

  async function refreshAudioDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const microphones = devices.filter((device) => device.kind === 'audioinput');
      setAudioDevices(microphones);
      debugLog('audio devices refreshed', microphones.map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
      })));
    } catch (err) {
      debugLog('audio devices refresh failed', err instanceof Error ? err.message : err);
    }
  }

  async function loadHotwords() {
    try {
      const response = await fetch(`${apiBaseUrl}/api/hotwords?user_id=${encodeURIComponent(userID)}`);
      const payload = (await response.json()) as HotwordsResponse;
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      setHotwords(payload.mappings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendInputNow() {
    if (!inputText.trim()) {
      return;
    }
    const commitKey = createCommitKey(mode, rawFinalText, enhancedText, inputText);
    latestInputKeyRef.current = commitKey;
    await commitInput(commitKey, true);
  }

  function handleInputBlur() {
    if (!inputText.trim()) {
      return;
    }
    const commitKey = createCommitKey(mode, rawFinalText, enhancedText, inputText);
    if (commitKey === lastCommittedKeyRef.current || commitKey === inFlightCommitKeyRef.current) {
      return;
    }
    void commitInput(commitKey);
  }

  async function commitInput(commitKey: string, force = false) {
    if (!inputText.trim()) {
      return;
    }
    if (!force && (commitKey === lastCommittedKeyRef.current || commitKey === inFlightCommitKeyRef.current)) {
      return;
    }

    const requestID = crypto.randomUUID();
    const requestSeq = commitSeqRef.current + 1;
    commitSeqRef.current = requestSeq;
    inFlightCommitKeyRef.current = commitKey;
    setProcessingState('processing');
    setCommitMessage(text.autoProcessing);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/api/input/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userID,
          session_id: taskId,
          mode,
          original_text: rawFinalText,
          enhanced_text: enhancedText || inputBaseline,
          final_text: inputText,
          request_id: requestID,
        }),
      });
      const payload = (await response.json()) as InputCommitResponse;
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      if (requestSeq !== commitSeqRef.current || commitKey !== latestInputKeyRef.current) {
        setProcessingState('idle');
        return;
      }

      lastCommittedKeyRef.current = commitKey;
      setProcessingState('completed');
      setProcessedText(payload.text ?? '');
      setProcessingSource(payload.source ?? '');
      setProcessingLatencyMS(payload.latency_ms ?? null);
      setCommitMessage(`${text.autoProcessed}${payload.mappings?.length ? `\uff0c${payload.mappings.length} \u6761\u66ff\u6362` : ''}`);
      if (payload.mappings?.length) {
        setLearnedMappings(payload.mappings);
        setMemoryDialogOpen(true);
        await loadHotwords();
      }
    } catch (err) {
      if (requestSeq !== commitSeqRef.current || commitKey !== latestInputKeyRef.current) {
        setProcessingState('idle');
        return;
      }
      setProcessingState('failed');
      const message = err instanceof Error ? err.message : String(err);
      setCommitMessage(message);
      setError(message);
    } finally {
      if (inFlightCommitKeyRef.current === commitKey) {
        inFlightCommitKeyRef.current = null;
      }
    }
  }

  async function deleteHotword(id: number) {
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/hotwords/${id}?user_id=${encodeURIComponent(userID)}`, {
        method: 'DELETE',
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      await loadHotwords();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function undoLearnedMapping(id: number) {
    await deleteHotword(id);
    setLearnedMappings((mappings) => {
      const next = mappings.filter((mapping) => mapping.id !== id);
      if (next.length === 0) {
        setMemoryDialogOpen(false);
      }
      return next;
    });
  }

  async function startRecording() {
    setError(null);
    setLiveText('');
    setInputText('');
    setInputBaseline('');
    setProcessedText('');
    setRawFinalText('');
    setEnhancedText('');
    setProcessingState('idle');
    setProcessingSource('');
    setProcessingLatencyMS(null);
    setCommitMessage('');
    setLearnedMappings([]);
    setMemoryDialogOpen(false);
    setTaskId(null);
    setRecorderStats({ frames: 0, bytes: 0, level: 0, peakLevel: 0 });
    setWaveLevels(createSilentWave());
    finalSegmentsRef.current = [];
    commitSeqRef.current += 1;
    lastCommittedKeyRef.current = '';
    inFlightCommitKeyRef.current = null;
    latestInputKeyRef.current = '';
    setRecordingStateSafe('connecting');

    try {
      debugLog('recording start requested');
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: createAudioConstraints(selectedDeviceId) });
      mediaStreamRef.current = mediaStream;
      updateMicDiagnostics(mediaStream);
      void refreshAudioDevices();
      const audioContext = createAudioContext();
      await audioContext.resume();
      audioContextRef.current = audioContext;
      debugLog('audio context prepared', { state: audioContext.state, sampleRate: audioContext.sampleRate });

      const ws = new WebSocket(
        `${toWebSocketBase(apiBaseUrl)}/ws/asr?user_id=${encodeURIComponent(userID)}&mode=${encodeURIComponent(mode)}`,
      );
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
        setRawFinalText(joined);
        setLiveText(joined);
      } else {
        setLiveText(`${finalSegmentsRef.current.join('')}${message.text}`);
      }
      return;
    }

    if (message.type === 'processing') {
      setProcessingState('processing');
      setRawFinalText(message.original_text ?? rawFinalText);
      setEnhancedText(message.enhanced_text ?? '');
      return;
    }

    if (message.type === 'input_ready') {
      const original = message.original_text ?? rawFinalText;
      const enhanced = message.enhanced_text ?? message.text ?? original;
      const input = message.text ?? enhanced;
      setRawFinalText(original);
      setEnhancedText(enhanced);
      setInputBaseline(enhanced);
      setInputText(input);
      setProcessedText('');
      setProcessingState('idle');
      setProcessingSource('');
      setProcessingLatencyMS(null);
      setCommitMessage(text.autoWaiting);
      if (message.mappings?.length) {
        void loadHotwords();
      }
      return;
    }

    if (message.type === 'processed') {
      const output = message.text ?? '';
      setProcessingState('completed');
      setProcessingSource(message.source ?? '');
      setProcessingLatencyMS(message.latency_ms ?? null);
      setRawFinalText(message.original_text ?? rawFinalText);
      setEnhancedText(message.enhanced_text ?? '');
      setInputBaseline(message.enhanced_text ?? output);
      setInputText(output);
      setProcessedText(output);
      setCommitMessage(text.autoProcessed);
      if (message.mappings?.length) {
        void loadHotwords();
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
      if (message.source === 'llm') {
        setProcessingState('failed');
      }
      setRawFinalText(message.original_text ?? rawFinalText);
      setEnhancedText(message.enhanced_text ?? enhancedText);
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
    const audioContext = audioContextRef.current ?? createAudioContext();
    audioContextRef.current = audioContext;
    void audioContext.resume();
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
      const peakLevel = calculatePeak(input);
      const normalizedLevel = normalizeVoiceLevel(level, peakLevel);
      setWaveLevels((levels) => [...levels.slice(1), normalizedLevel]);
      setRecorderStats((stats) => {
        const next = {
          frames: stats.frames + 1,
          bytes: stats.bytes + pcm.byteLength,
          level,
          peakLevel: Math.max(stats.peakLevel, peakLevel),
        };
        if (debugEnabled && next.frames % 100 === 1) {
          debugLog('audio frame sent', { frames: next.frames, bytes: next.bytes, level, peakLevel });
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

  function updateMicDiagnostics(mediaStream: MediaStream) {
    const track = mediaStream.getAudioTracks()[0];
    if (!track) {
      setMicDiagnostics(null);
      return;
    }
    const settings = track.getSettings();
    const diagnostics = {
      label: track.label || text.defaultMicrophone,
      state: track.readyState,
      muted: track.muted,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
    };
    setMicDiagnostics(diagnostics);
    debugLog('microphone opened', diagnostics);
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
                disabled={isRecordingActive}
                onClick={() => setMode(value as typeof mode)}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="mic-selector">
            <span>{text.microphone}</span>
            <select
              value={selectedDeviceId}
              onChange={(event) => setSelectedDeviceId(event.target.value)}
              disabled={isRecordingActive}
            >
              <option value="">{text.defaultMicrophone}</option>
              {audioDevices.map((device, index) => (
                <option key={device.deviceId || `mic-${index}`} value={device.deviceId}>
                  {device.label || `${text.microphone} ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

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
              <h2>{text.inputText}</h2>
              <span>
                {processingState === 'processing'
                  ? text.autoProcessing
                  : mode === 'markdown'
                    ? 'Markdown'
                    : mode === 'raw'
                      ? text.raw
                      : text.polish}
              </span>
            </div>
            {rawFinalText ? (
              <div className="source-text">
                <span>{text.rawFinal}</span>
                <p>{rawFinalText}</p>
              </div>
            ) : null}
            {enhancedText && enhancedText !== rawFinalText ? (
              <div className="source-text">
                <span>{text.enhancedFinal}</span>
                <p>{enhancedText}</p>
              </div>
            ) : null}
            <textarea
              aria-label={text.inputTextAria}
              value={inputText}
              onChange={(event) => {
                setInputText(event.target.value);
                setProcessedText('');
                setProcessingSource('');
                setProcessingLatencyMS(null);
              }}
              onBlur={handleInputBlur}
              placeholder={text.inputPlaceholder}
              rows={8}
            />
            <div className="correction-row">
              <button type="button" onClick={() => void sendInputNow()} disabled={!canSendInput}>
                <Send size={16} aria-hidden="true" />
                <span>{text.send}</span>
              </button>
              <span className={processingState === 'failed' ? 'correction-error' : ''}>
                {commitMessage || (inputText ? text.autoWaiting : text.inputPlaceholder)}
              </span>
            </div>
            {processedText ? (
              <div className="source-text processed-output">
                <span>{text.processedOutput}</span>
                <p>{processedText}</p>
              </div>
            ) : null}
            {processingSource ? (
              <p className="processing-meta">
                {text.processedBy}: {processingSource}
                {processingLatencyMS !== null ? ` / ${processingLatencyMS}ms` : ''}
              </p>
            ) : null}
          </section>
        </div>
      </section>

      <section className="hotword-panel" aria-label={text.hotwordMemory}>
        <div className="pane-heading">
          <h2>{text.hotwordMemory}</h2>
          <span>{hotwords.length}</span>
        </div>
        {hotwords.length === 0 ? (
          <p className="placeholder">{text.noHotwords}</p>
        ) : (
          <div className="hotword-list">
            {hotwords.map((mapping) => (
              <div className="hotword-item" key={mapping.id}>
                <div>
                  <strong>{mapping.from_text} {'->'} {mapping.to_text}</strong>
                  <span>
                    {mapping.correction_count} / {mapping.hit_count}
                  </span>
                </div>
                <button
                  type="button"
                  title={text.deleteHotword}
                  aria-label={text.deleteHotword}
                  onClick={() => void deleteHotword(mapping.id)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
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
          <span>{text.inputDevice}</span>
          <strong title={micDiagnostics ? formatMicDiagnostics(micDiagnostics) : undefined}>
            {micDiagnostics ? formatMicDiagnostics(micDiagnostics) : '-'}
          </strong>
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
          {micLooksSilent ? <strong className="wave-warning">{text.micSilent}</strong> : null}
        </div>
      </section>

      {memoryDialogOpen && learnedMappings.length > 0 ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={text.memoryLearned}>
          <div className="memory-modal">
            <div className="pane-heading">
              <h2>{text.memoryLearned}</h2>
              <button type="button" aria-label={text.close} title={text.close} onClick={() => setMemoryDialogOpen(false)}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="hotword-list">
              {learnedMappings.map((mapping) => (
                <div className="hotword-item" key={mapping.id}>
                  <div>
                    <strong>{mapping.from_text} {'->'} {mapping.to_text}</strong>
                    <span>
                      {mapping.correction_count} / {mapping.hit_count}
                    </span>
                  </div>
                  <button
                    type="button"
                    title={text.undo}
                    aria-label={text.undo}
                    onClick={() => void undoLearnedMapping(mapping.id)}
                  >
                    <Undo2 size={16} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

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

function calculatePeak(input: Float32Array) {
  let peak = 0;
  for (let i = 0; i < input.length; i += 1) {
    peak = Math.max(peak, Math.abs(input[i]));
  }
  return peak;
}

function normalizeVoiceLevel(rms: number, peak: number) {
  return Math.max(0, Math.min(1, Math.max(rms * 45, peak * 2.5)));
}

function createSilentWave() {
  return Array.from({ length: waveBarCount }, () => 0);
}

function createAudioConstraints(deviceId: string): MediaTrackConstraints {
  return {
    autoGainControl: false,
    channelCount: 1,
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: false,
    noiseSuppression: false,
  };
}

function createAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error(text.audioContextUnsupported);
  }
  return new AudioContextClass();
}

function formatMicDiagnostics(diagnostics: MicDiagnostics) {
  const details = [
    diagnostics.label,
    diagnostics.muted ? 'muted' : '',
    diagnostics.sampleRate ? `${diagnostics.sampleRate}Hz` : '',
    diagnostics.channelCount ? `${diagnostics.channelCount}ch` : '',
    diagnostics.state,
  ].filter(Boolean);
  return details.join(' / ');
}

function toWebSocketBase(httpBase: string) {
  const url = new URL(httpBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}

function createCommitKey(mode: OutputMode, originalText: string, enhancedText: string, inputText: string) {
  return [mode, originalText.trim(), enhancedText.trim(), inputText.trim()].join('\u0000');
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
