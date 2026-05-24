import {
  Brain,
  Check,
  Clipboard,
  Database,
  FileText,
  Mic,
  RefreshCw,
  Save,
  Send,
  Server,
  Settings,
  Sparkles,
  Square,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type HealthState = 'checking' | 'ok' | 'error';
type RecordingState = 'idle' | 'connecting' | 'recording' | 'stopping' | 'completed' | 'error';
type OutputMode = 'polish' | 'raw' | 'markdown';
type CleanupOptionKey = 'hotword' | 'revision' | 'filler' | 'markdown' | 'paragraph';
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
  speaker_id?: string;
  message?: string;
  mode?: OutputMode;
  status?: string;
  source?: string;
  latency_ms?: number;
  original_text?: string;
  enhanced_text?: string;
  mappings?: HotwordMapping[];
};

type Preference = {
  key: string;
  value: string;
};

type PreferencesResponse = {
  preferences?: Preference[];
  error?: string;
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

type FileTranscribeSentence = {
  text: string;
  speaker_id: number;
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8080';
const targetSampleRate = 16000;
const debugEnabled = import.meta.env.DEV;
const waveBarCount = 44;

const cleanupOptions: Array<{ key: CleanupOptionKey; label: string }> = [
  { key: 'hotword', label: '\u4e13\u6709\u8bcd\u7ea0\u9519' },
  { key: 'revision', label: '\u4fee\u6b63\u6539\u53e3' },
  { key: 'filler', label: '\u53bb\u53e3\u5934\u7985' },
  { key: 'markdown', label: 'Markdown \u5217\u8868' },
  { key: 'paragraph', label: '\u6bb5\u843d\u4f18\u5316' },
];

const text = {
  apiConnected: '\u0041\u0050\u0049 \u5df2\u8fde\u63a5',
  apiChecking: '\u6b63\u5728\u68c0\u67e5 \u0041\u0050\u0049',
  apiOffline: '\u0041\u0050\u0049 \u672a\u8fde\u63a5',
  workspaceTitle: '\u8bed\u97f3\u8bb0\u5fc6\u8f93\u5165\u53f0',
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
  memoryLearned: '\u5df2\u65b0\u589e\u70ed\u8bcd\u8bb0\u5f55',
  memoryLearnedNotice: '\u4e0b\u6b21\u8bc6\u522b\u5230\u5de6\u4fa7\u8bcd\u65f6\u4f1a\u81ea\u52a8\u66ff\u6362\u4e3a\u53f3\u4fa7\u8bcd\uff0c\u5982\u679c\u4e0d\u9700\u8981\u53ef\u4ee5\u5728\u8fd9\u91cc\u5220\u9664\u3002',
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
  const [showIntro, setShowIntro] = useState(true);
  const [healthState, setHealthState] = useState<HealthState>('checking');
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode] = useState<OutputMode>('polish');
  const [enabledCleanupOptions, setEnabledCleanupOptions] = useState<Record<CleanupOptionKey, boolean>>({
    hotword: true,
    revision: true,
    filler: true,
    markdown: true,
    paragraph: true,
  });
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
  const [memoryManagerOpen, setMemoryManagerOpen] = useState(false);
  const [hotwords, setHotwords] = useState<HotwordMapping[]>([]);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [userID] = useState(() => getUserID());
  const [taskId, setTaskId] = useState<string | null>(null);
  const [recorderStats, setRecorderStats] = useState<RecorderStats>({ frames: 0, bytes: 0, level: 0, peakLevel: 0 });
  const [filteredFrames, setFilteredFrames] = useState(0);
  const [speakerSegments, setSpeakerSegments] = useState<Map<string, string[]>>(new Map());
  const [selectedSpeaker, setSelectedSpeaker] = useState('');
  const [hasMultipleSpeakers, setHasMultipleSpeakers] = useState(false);
  const [voiceFilterMode, setVoiceFilterMode] = useState(false);
  const [voiceFilterLoading, setVoiceFilterLoading] = useState(false);
  const [voiceFilterResult, setVoiceFilterResult] = useState<{
    sentences: FileTranscribeSentence[];
    speaker_count: number;
  } | null>(null);
  const audioBufferRef = useRef<Float32Array[]>([]);
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
  const voiceBaselineRef = useRef(0);
  const voiceFrameCountRef = useRef(0);
  const voiceFilterSampleRateRef = useRef(targetSampleRate);
  const filteredFrameCountRef = useRef(0);

  const statusLabel = useMemo(() => {
    if (healthState === 'ok') return text.apiConnected;
    if (healthState === 'checking') return text.apiChecking;
    return text.apiOffline;
  }, [healthState]);

  const isRecordingActive = ['connecting', 'recording', 'stopping'].includes(recordingState);
  const canUseRecordButton = healthState === 'ok' && !['connecting', 'stopping'].includes(recordingState);
  const micLooksSilent = recordingState === 'recording' && recorderStats.frames > 20 && recorderStats.peakLevel < 0.001;
  const canSendInput = inputText.trim() !== '' && processingState !== 'processing';
  const previewWaveLevels = useMemo(() => createPreviewWave(), []);
  const visibleWaveLevels = isRecordingActive ? waveLevels : previewWaveLevels;
  const originalTranscript = rawFinalText || liveText;
  const resultText = processedText || inputText || enhancedText;
  const displayedMappings = useMemo(() => {
    return learnedMappings.slice(0, 3);
  }, [learnedMappings]);

  useEffect(() => {
    void checkHealth();
    void refreshAudioDevices();
    void loadHotwords();
    void loadPreferences();

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

  async function loadPreferences() {
    try {
      const response = await fetch(`${apiBaseUrl}/api/preferences?user_id=${encodeURIComponent(userID)}`);
      const payload = (await response.json()) as PreferencesResponse;
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      setPreferences(payload.preferences ?? []);
    } catch {
      // silently ignore preference load errors
    }
  }

  async function deletePreference(key: string) {
    try {
      const response = await fetch(`${apiBaseUrl}/api/preferences/${encodeURIComponent(key)}?user_id=${encodeURIComponent(userID)}`, {
        method: 'DELETE',
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      await loadPreferences();
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
        await loadPreferences();
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

  async function deleteLearnedMapping(id: number) {
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
    setFilteredFrames(0);
    setSpeakerSegments(new Map());
    setSelectedSpeaker('');
    setHasMultipleSpeakers(false);
    voiceBaselineRef.current = 0;
    voiceFrameCountRef.current = 0;
    filteredFrameCountRef.current = 0;
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

      if (voiceFilterMode) {
        audioBufferRef.current = [];
        startAudioProcessingForFilter(mediaStream);
        return;
      }

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
        const sid = message.speaker_id || '';
        if (sid) {
          setSpeakerSegments((prev) => {
            const next = new Map(prev);
            const existing = next.get(sid) || [];
            next.set(sid, [...existing, message.text!]);
            if (next.size > 1) {
              setHasMultipleSpeakers(true);
            }
            return next;
          });
          if (!selectedSpeaker) {
            setSelectedSpeaker(sid);
          }
        }
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

    if (voiceFilterMode) {
      void processVoiceFilterAudio();
      return;
    }

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      return;
    }

    setRecordingStateSafe('completed');
  }

  async function processVoiceFilterAudio() {
    const buffers = audioBufferRef.current;
    debugLog('voice filter: stop received', { bufferCount: buffers.length });
    if (buffers.length === 0) {
      setRecordingStateSafe('completed');
      return;
    }

    setVoiceFilterLoading(true);
    setVoiceFilterResult(null);

    try {
      const totalLength = buffers.reduce((s, b) => s + b.length, 0);
      setLiveText(`Voice filter: combining ${buffers.length} frames (${(totalLength / targetSampleRate).toFixed(1)}s)...`);
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const buf of buffers) {
        combined.set(buf, offset);
        offset += buf.length;
      }

      setLiveText('Voice filter: encoding WAV...');
      const inputSampleRate = voiceFilterSampleRateRef.current || targetSampleRate;
      const downsampled = downsample(combined, inputSampleRate, targetSampleRate);
      const wav = encodeWAV(downsampled, targetSampleRate);
      debugLog('voice filter: wav encoded', {
        inputSampleRate,
        outputSampleRate: targetSampleRate,
        inputSamples: combined.length,
        outputSamples: downsampled.length,
        wavBytes: wav.byteLength,
        durationS: (downsampled.length / targetSampleRate).toFixed(1),
      });

      setLiveText('Voice filter: uploading audio...');
      const response = await fetch(apiBaseUrl + '/api/transcribe/file', {
        method: 'POST',
        body: wav,
      });
      debugLog('voice filter: upload response', { status: response.status });
      const payload = (await response.json()) as {
        sentences?: FileTranscribeSentence[];
        full_text?: string;
        speaker_count?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || 'HTTP ' + response.status);
      }

      debugLog('voice filter: result', { sentences: payload.sentences?.length, speakers: payload.speaker_count });
      const sentences = payload.sentences || [];
      setVoiceFilterResult({
        sentences,
        speaker_count: payload.speaker_count || 0,
      });
      const firstSpeakerID = firstSpeakerIDFromSentences(sentences);
      const userText = firstSpeakerID === null
        ? (payload.full_text || '')
        : textForSpeaker(sentences, firstSpeakerID);
      setSelectedSpeaker(firstSpeakerID === null ? 'all' : String(firstSpeakerID));
      setRawFinalText(userText);
      setInputText(userText);
      setLiveText(userText);
    } catch (err) {
      debugLog('voice filter: failed', err instanceof Error ? err.message : err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVoiceFilterLoading(false);
      setRecordingStateSafe('completed');
      audioBufferRef.current = [];
    }
  }

  function toggleRecording() {
    if (recordingStateRef.current === 'recording') {
      stopRecording();
      return;
    }
    void startRecording();
  }

  function startAudioProcessingForFilter(mediaStream: MediaStream) {
    const audioContext = audioContextRef.current ?? createAudioContext();
    audioContextRef.current = audioContext;
    void audioContext.resume();
    voiceFilterSampleRateRef.current = audioContext.sampleRate;
    const source = audioContext.createMediaStreamSource(mediaStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (recordingStateRef.current !== 'recording') return;
      const input = event.inputBuffer.getChannelData(0);
      audioBufferRef.current.push(new Float32Array(input));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    sourceRef.current = source;
    processorRef.current = processor;
    setRecordingStateSafe('recording');
    debugLog('voice filter recording started', { inputSampleRate: audioContext.sampleRate, targetSampleRate });
  }

  function startAudioProcessing(mediaStream: MediaStream, ws: WebSocket) {
    const audioContext = audioContextRef.current ?? createAudioContext();
    audioContextRef.current = audioContext;
    void audioContext.resume();
    const source = audioContext.createMediaStreamSource(mediaStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    const voiceFilterThreshold = 0.25;

    processor.onaudioprocess = (event) => {
      if (ws.readyState !== WebSocket.OPEN || recordingStateRef.current !== 'recording') {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const level = calculateRMS(input);
      const peakLevel = calculatePeak(input);

      voiceFrameCountRef.current += 1;
      if (level > voiceBaselineRef.current * 1.2) {
        voiceBaselineRef.current = level;
      } else {
        voiceBaselineRef.current *= 0.9998;
      }

      const normalizedLevel = normalizeVoiceLevel(level, peakLevel);
      setWaveLevels((levels) => [...levels.slice(1), normalizedLevel]);

      const voiceLearned = voiceBaselineRef.current > 0.0005 && voiceFrameCountRef.current > 30;
      if (voiceLearned && level < voiceBaselineRef.current * voiceFilterThreshold) {
        filteredFrameCountRef.current += 1;
        if (filteredFrameCountRef.current % 20 === 1) {
          setFilteredFrames(filteredFrameCountRef.current);
        }
        setRecorderStats((stats) => ({
          frames: stats.frames + 1,
          bytes: stats.bytes,
          level,
          peakLevel: Math.max(stats.peakLevel, peakLevel),
        }));
        return;
      }

      const downsampled = downsample(input, audioContext.sampleRate, targetSampleRate);
      const pcm = encodePCM16(downsampled);
      ws.send(pcm);

      setRecorderStats((stats) => {
        const next = {
          frames: stats.frames + 1,
          bytes: stats.bytes + pcm.byteLength,
          level,
          peakLevel: Math.max(stats.peakLevel, peakLevel),
        };
        if (debugEnabled && next.frames % 100 === 1) {
          debugLog('audio frame sent', { frames: next.frames, bytes: next.bytes, level, peakLevel, baseline: voiceBaselineRef.current });
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

  function toggleCleanupOption(option: CleanupOptionKey) {
    setEnabledCleanupOptions((current) => ({
      ...current,
      [option]: !current[option],
    }));
  }

  function clearSessionText() {
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
    setError(null);
    setWaveLevels(createSilentWave());
    finalSegmentsRef.current = [];
    latestInputKeyRef.current = '';
    lastCommittedKeyRef.current = '';
    inFlightCommitKeyRef.current = null;
  }

  async function copyResult() {
    const content = (resultText || originalTranscript).trim();
    if (!content) {
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setCommitMessage('\u5df2\u590d\u5236\u7ed3\u679c');
    } catch {
      setError('\u590d\u5236\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u9009\u62e9\u6587\u672c\u590d\u5236');
    }
  }

  if (showIntro) {
    return (
      <main className="intro-shell">
        <div className="intro-hero">
          <div className="intro-copy">
            <span className="intro-kicker">VoxMem</span>
            <h1>语音记忆输入台</h1>
            <p>
              轻量级语音输入工作区 —— 实时语音识别、智能文本整理、个人记忆纠错，让每一次口述都精准高效。
            </p>
            <div className="intro-actions">
              <button type="button" className="intro-primary" onClick={() => setShowIntro(false)}>
                开始体验
                <Send size={20} aria-hidden="true" />
              </button>
              <span>无需登录，打开即用。支持 Chrome / Edge / Firefox。</span>
            </div>
          </div>

          <div className="intro-product">
            <div className="intro-console">
              <div className="intro-console-top">
                <span className="intro-status-dot" />
                <strong>实时 ASR</strong>
                <em>&middot;</em>
                <span>Paraformer 流式识别</span>
              </div>
              <div className="intro-waveform">
                {Array.from({ length: 64 }, (_, i) => (
                  <i
                    key={i}
                    style={{
                      '--level': `${0.15 + Math.sin(i * 0.32) * 0.2 + Math.cos(i * 0.18) * 0.15 + Math.random() * 0.1}`,
                      '--delay': `${i * 28}ms`,
                    } as CSSProperties}
                  />
                ))}
              </div>
            </div>

            <div className="intro-transform">
              <section>
                <span>原始转写</span>
                <p>今天星期一，不对，今天是星期二，那个张力要同步熔断机制...</p>
              </section>
              <section>
                <span>智能整理后</span>
                <p>今天是星期二。张力需要同步熔断机制。</p>
              </section>
            </div>

            <div className="intro-capabilities">
              <article>
                <Mic size={26} aria-hidden="true" />
                <h2>实时语音识别</h2>
                <p>浏览器端麦克风采集，WebSocket 流式传输，Paraformer 实时转写。</p>
              </article>
              <article>
                <Sparkles size={26} aria-hidden="true" />
                <h2>LLM 智能整理</h2>
                <p>口语修正、填充词去除、段落优化、Markdown 格式化。</p>
              </article>
              <article>
                <Brain size={26} aria-hidden="true" />
                <h2>个人记忆纠错</h2>
                <p>自动学习你的专属词汇替换，越用越准。</p>
              </article>
              <article>
                <Zap size={26} aria-hidden="true" />
                <h2>开箱即用</h2>
                <p>无需注册、无需登录，打开浏览器即可开始语音输入。</p>
              </article>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          <span className="brand-icon"><Mic size={24} aria-hidden="true" /></span>
          <h1>{'\u8bed\u97f3\u52a9\u624b'}</h1>
        </div>
        <div className="topbar-actions">
          <span className={`service-pill status-${healthState}`}>
            <span className="status-dot" aria-hidden="true" />
            {statusLabel}
          </span>
          <button type="button" className="ghost-button" onClick={() => void checkHealth()} title={text.retryAPI}>
            <Server size={18} aria-hidden="true" />
            <span>{'\u6307\u6807\u770b\u677f'}</span>
          </button>
          <button type="button" className="ghost-button" onClick={() => setMemoryManagerOpen(true)}>
            <Database size={18} aria-hidden="true" />
            <span>{'\u70ed\u8bcd\u7ba1\u7406'}</span>
          </button>
        </div>
      </header>

      <section className="workspace" aria-label={text.workspaceTitle}>
        <div className="recorder-panel">
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
          <label className="voice-filter-toggle">
            <input
              type="checkbox"
              checked={voiceFilterMode}
              onChange={(event) => setVoiceFilterMode(event.target.checked)}
              disabled={isRecordingActive}
            />
            <span>{'\u79bb\u7ebf\u4eba\u58f0\u5206\u79bb'}</span>
          </label>
        </div>

        <div className="text-grid">
          <section className="text-pane main-pane">
            <p className="input-hint">{'\u70b9\u51fb\u9ea6\u514b\u98ce\u5f00\u59cb\u8bed\u97f3\u8f93\u5165...'}</p>
            <div className="voice-console">
              <div className="voice-waveform" aria-label={text.voiceWave}>
                {visibleWaveLevels.map((level, index) => (
                  <i
                    aria-hidden="true"
                    key={`${index}-${level.toFixed(3)}`}
                    style={{
                      '--level': `${0.12 + level * 0.88}`,
                      '--delay': `${index * 18}ms`,
                    } as CSSProperties}
                  />
                ))}
              </div>
              <div className="listen-status">
                <span aria-hidden="true" />
                <strong>{isRecordingActive ? '\u6b63\u5728\u542c\u5199' : recordingStateLabel(recordingState)}</strong>
                <em>{'\u00b7'}</em>
                <span>{'\u5df2\u542f\u7528\u4e2a\u4eba\u8bb0\u5fc6\u4e0e\u667a\u80fd\u6574\u7406'}</span>
              </div>
            </div>

            <div className="result-flow">
              <section className="source-text transcript-card live-transcript-panel">
                <div className="card-title">
                  <FileText size={18} aria-hidden="true" />
                  <h2>{'\u539f\u59cb\u8f6c\u5199'}</h2>
                </div>
                <p className={liveText ? 'transcript-text' : 'placeholder'}>
                  {liveText || '\u4eca\u5929\u662f\u661f\u671f\u4e00\uff0c\u4e0d\u5bf9\uff0c\u4eca\u5929\u662f\u661f\u671f\u4e8c\uff0c\n\u7136\u540e\u90a3\u4e2a\u5f20\u529b\u8981\u540c\u6b65\u7194\u65ad\u673a\u5236...'}
                </p>
              </section>
              <span className="flow-arrow" aria-hidden="true">{'\u2192'}</span>
              <section className="source-text edited-card polished-text-panel">
                <div className="card-title">
                  <Sparkles size={18} aria-hidden="true" />
                  <h2>{'\u6574\u7406\u540e\u6587\u5b57'}</h2>
                </div>
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
                  rows={4}
                />
                {processedText ? <p className="processed-inline">{processedText}</p> : null}
              </section>
            </div>

            {hasMultipleSpeakers ? (
              <div className="source-text speaker-filter">
                <span>{'\u68c0\u6d4b\u5230\u591a\u4e2a\u8bf4\u8bdd\u4eba\uff0c\u8bf7\u9009\u62e9\u4f60\u7684\u58f0\u97f3\uff1a'}</span>
                {Array.from(speakerSegments.keys()).map((sid) => (
                  <label key={sid}>
                    <input
                      type="radio"
                      name="speaker"
                      value={sid}
                      checked={selectedSpeaker === sid}
                      onChange={() => setSelectedSpeaker(sid)}
                    />
                    {' Speaker ' + sid}
                  </label>
                ))}
              </div>
            ) : null}

            {voiceFilterLoading ? (
              <div className="source-text">
                <span>Voice Filter</span>
                <p>Processing audio with speaker diarization...</p>
              </div>
            ) : null}

            {voiceFilterResult && voiceFilterResult.speaker_count > 1 ? (
              <div className="source-text speaker-filter">
                <span>{voiceFilterResult.speaker_count} speakers detected - select speaker to keep:</span>
                {Array.from(new Set(voiceFilterResult.sentences.map((sentence) => sentence.speaker_id))).map((sid) => (
                  <label key={sid}>
                    <input
                      type="radio"
                      name="vfspeaker"
                      value={sid}
                      checked={selectedSpeaker === String(sid)}
                      onChange={() => {
                        setSelectedSpeaker(String(sid));
                        const filtered = voiceFilterResult.sentences
                          .filter((sentence) => sentence.speaker_id === sid)
                          .map((sentence) => sentence.text)
                          .join('');
                        setRawFinalText(filtered);
                        setInputText(filtered);
                        setLiveText(filtered);
                      }}
                    />
                    {' Speaker ' + sid}
                  </label>
                ))}
                <button type="button" onClick={() => {
                  setSelectedSpeaker('all');
                  const all = voiceFilterResult.sentences.map((sentence) => sentence.text).join('');
                  setRawFinalText(all);
                  setInputText(all);
                  setLiveText(all);
                }}>
                  Show all
                </button>
              </div>
            ) : null}

            <section className="command-bar" aria-label="鎿嶄綔">
              <button
                className={`record-action ${isRecordingActive ? 'recording' : ''}`}
                type="button"
                disabled={!canUseRecordButton}
                onClick={toggleRecording}
                title={text.startRecordingTitle}
              >
                {isRecordingActive ? <Square size={28} aria-hidden="true" /> : <Mic size={30} aria-hidden="true" />}
              </button>
              <button type="button" onClick={() => void sendInputNow()} disabled={!canSendInput}>
                <Check size={18} aria-hidden="true" />
                <span>{'\u786e\u8ba4'}</span>
              </button>
              <button type="button" onClick={() => void copyResult()} disabled={!(resultText || originalTranscript)}>
                <Clipboard size={18} aria-hidden="true" />
                <span>{'\u590d\u5236'}</span>
              </button>
              <button type="button" onClick={clearSessionText} disabled={!(resultText || originalTranscript)}>
                <Trash2 size={18} aria-hidden="true" />
                <span>{'\u6e05\u7a7a'}</span>
              </button>
            </section>
            <p className={processingState === 'failed' ? 'process-meta correction-error' : 'process-meta'}>
              {commitMessage || (inputText ? text.autoWaiting : '\u7b49\u5f85\u8bed\u97f3\u8f93\u5165')}
              {processingSource ? ` / ${text.processedBy}: ${processingSource}` : ''}
              {processingLatencyMS !== null ? ` / ${processingLatencyMS}ms` : ''}
            </p>
          </section>

          <aside className="text-pane insight-pane">
            {displayedMappings.length > 0 ? (
              <section className="memory-hit-card">
                <div className="pane-heading">
                  <h2><Brain size={18} aria-hidden="true" />{'\u4e2a\u4eba\u8bb0\u5fc6\u547d\u4e2d'}</h2>
                </div>
                <div className="memory-hit-list">
                  {displayedMappings.map((mapping, index) => (
                    <div className="memory-hit" key={mapping.id}>
                      <span>{mapping.from_text}</span>
                      <i aria-hidden="true">{'\u2192'}</i>
                      <strong>{mapping.to_text}</strong>
                      <em>{memoryKindLabel(index)}</em>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            {enhancedText && enhancedText !== rawFinalText ? (
              <div className="source-text compact-source">
                <span>{text.enhancedFinal}</span>
                <p>{enhancedText}</p>
              </div>
            ) : null}

            <section className="cleanup-card">
              <div className="pane-heading">
                <h2><Sparkles size={18} aria-hidden="true" />{'\u667a\u80fd\u6574\u7406'}</h2>
              </div>
              <div className="toggle-stack">
                {cleanupOptions.map((option) => (
                  <button
                    key={option.key}
                    className={enabledCleanupOptions[option.key] ? 'active' : ''}
                    type="button"
                    aria-pressed={enabledCleanupOptions[option.key]}
                    onClick={() => toggleCleanupOption(option.key)}
                  >
                    <span>{option.label}</span>
                    <Check size={15} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </section>
          </aside>
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
            <p className="memory-learned-notice">{text.memoryLearnedNotice}</p>
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
                    title={text.deleteHotword}
                    aria-label={text.deleteHotword}
                    onClick={() => void deleteLearnedMapping(mapping.id)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {memoryManagerOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={text.hotwordMemory}>
          <div className="memory-modal memory-manager">
            <div className="pane-heading">
              <h2>{text.hotwordMemory}</h2>
              <button type="button" aria-label={text.close} title={text.close} onClick={() => setMemoryManagerOpen(false)}>
                <X size={16} aria-hidden="true" />
              </button>
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

function createPreviewWave() {
  return Array.from({ length: waveBarCount }, (_, index) => {
    const centerDistance = Math.abs(index - (waveBarCount - 1) / 2) / (waveBarCount / 2);
    const envelope = Math.max(0.02, 1 - Math.pow(centerDistance, 1.85));
    const pulse = Math.abs(Math.sin(index * 0.9)) * 0.5 + Math.abs(Math.cos(index * 0.41)) * 0.2;
    const centerBoost = Math.exp(-centerDistance * centerDistance * 10) * 0.34;
    return Math.min(1, envelope * (0.06 + pulse) + centerBoost);
  });
}

function firstSpeakerIDFromSentences(sentences: FileTranscribeSentence[]) {
  return sentences.length > 0 ? sentences[0].speaker_id : null;
}

function textForSpeaker(sentences: FileTranscribeSentence[], speakerID: number) {
  return sentences
    .filter((sentence) => sentence.speaker_id === speakerID)
    .map((sentence) => sentence.text)
    .join('');
}

function memoryKindLabel(index: number) {
  return ['\u4eba\u540d', '\u884c\u4e1a\u672f\u8bed', '\u9879\u76ee\u540d'][index] ?? '\u8bb0\u5fc6';
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

function preferenceLabel(key: string, value: string) {
  const labels: Record<string, Record<string, string>> = {
    punctuation: { chinese: 'Chinese punctuation', english: 'English punctuation' },
    end_period: { always: 'End sentences with period', never: 'No ending period' },
    list_style: { numbered: 'Numbered lists', dash: 'Dash lists' },
    cn_en_space: { true: 'Space between CN/EN', false: 'No space between CN/EN' },
  };
  return labels[key]?.[value] ?? `${key}=${value}`;
}

function encodeWAV(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function writeString(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) {
    view.setUint8(offset + i, s.charCodeAt(i));
  }
}
