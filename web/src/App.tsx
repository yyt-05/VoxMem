import {
  Brain,
  Check,
  Clipboard,
  Database,
  FileText,
  Mic,
  RefreshCw,
  Send,
  Server,
  Settings,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { type CSSProperties, type WheelEvent, useEffect, useMemo, useRef, useState } from 'react';

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

type RecentCorrectionMetric = {
  id: number;
  session_id?: string;
  original_text: string;
  enhanced_text?: string;
  corrected_text: string;
  edit_distance: number;
  edit_rate: number;
  created_at: string;
};

type MetricsSummary = {
  correction_count: number;
  average_edit_rate: number;
  hotword_count: number;
  hotword_hit_count: number;
  hotword_learned_count: number;
  recent_corrections?: RecentCorrectionMetric[];
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
  begin_time?: number;
  end_time?: number;
};

type FileTranscribeResponse = {
  sentences?: FileTranscribeSentence[];
  full_text?: string;
  speaker_count?: number;
  error?: string;
};

type IntroScene = 'polish' | 'memory' | 'voice';

const introSceneOrder: IntroScene[] = ['polish', 'memory', 'voice'];

const introFeatureCards: Array<{
  key: IntroScene;
  label: string;
  title: string;
  body: string;
  metric: string;
}> = [
  {
    key: 'polish',
    label: '01 / 改口清理',
    title: '先听懂你真正要保留的那句话',
    body: '口述里的“不对、应该是、刚才说错了”会被识别成修正动作，重复和填充词自动退到背景里。',
    metric: '把反复确认压缩成最终结论',
  },
  {
    key: 'memory',
    label: '02 / 本地记忆',
    title: '你修正过一次的词，下次优先命中',
    body: '同事名、客户名、项目代号会沉淀成本地替换规则，不需要每次重新纠正。',
    metric: '编辑后进入个人热词规则',
  },
  {
    key: 'voice',
    label: '03 / 声纹过滤',
    title: '多人声音里，只留下你的正文',
    body: '会议室和开放办公区里，先切分说话人，再把旁人的插话折叠掉，减少混入正文。',
    metric: '保留目标说话人的有效片段',
  },
];

const introScenarios: Record<IntroScene, {
  eyebrow: string;
  titleLines: string[];
  description: string;
  raw: string;
  output: string;
  proof: string;
}> = {
  polish: {
    eyebrow: '口述里的反悔，自动收掉',
    titleLines: ['把“星期一，不对星期二”', '直接变成可用文字'],
    description: '实时识别不只是转写。VoxMem 会识别改口、重复和口头填充，把最终意图留在输入框里。',
    raw: '今天是星期一，不对，今天是星期二，那个下午三点同步下需求。',
    output: '今天是星期二，下午三点同步需求。',
    proof: '删除改口与口头禅',
  },
  memory: {
    eyebrow: '编辑一次，下次记住',
    titleLines: ['专属人名和热词', '会进入本地记忆'],
    description: '你把“张立”改成“张莉”后，同一个用户后续再说到这个名字会优先走本地替换。',
    raw: '今天去找张立开会，顺便确认声纹过滤方案。',
    output: '今天去找张莉开会，顺便确认声纹过滤方案。',
    proof: '张立 -> 张莉 已学习',
  },
  voice: {
    eyebrow: '别人插话，不抢你的稿子',
    titleLines: ['声纹过滤先分离说话人', '再保留你的声音'],
    description: '会议室、开放办公区和嘈杂环境里，VoxMem 会按说话人切分，减少旁边声音混进正文。',
    raw: '我：明天发版本。旁人：帮我拿杯咖啡。我：重点看热词命中。',
    output: '明天发版本，重点看热词命中。',
    proof: '保留主说话人 2 段',
  },
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8080';
const targetSampleRate = 16000;
const realtimeProcessorBufferSize = 1024;
const voiceFilterProcessorBufferSize = 4096;
const realtimeUIUpdateEveryFrames = 4;
const debugEnabled = import.meta.env.DEV;
const voiceGuideStorageKey = 'voxmem.voice-filter-guide.dismissed';

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
  voiceProcessing: '\u58f0\u97f3\u5904\u7406',
  voiceFilter: '\u53bb\u9664\u5468\u56f4\u4eba\u58f0',
  voiceFilterWorking: '\u6b63\u5728\u79bb\u7ebf\u8bc6\u522b\u5e76\u5206\u79bb\u8bf4\u8bdd\u4eba...',
  voiceFilterApplied: '\u5df2\u6309\u9996\u4e2a\u8bf4\u8bdd\u4eba\u4fdd\u7559\u672c\u4eba\u58f0\u97f3',
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
  stopRecordingTitle: '\u505c\u6b62\u5f55\u97f3',
};

function App() {
  const [showIntro, setShowIntro] = useState(true);
  const [introScene, setIntroScene] = useState<IntroScene>('polish');
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
  const [memoryManagerOpen, setMemoryManagerOpen] = useState(false);
  const [hotwords, setHotwords] = useState<HotwordMapping[]>([]);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsSummary, setMetricsSummary] = useState<MetricsSummary | null>(null);
  const [userID] = useState(() => getUserID());
  const [taskId, setTaskId] = useState<string | null>(null);
  const [recorderStats, setRecorderStats] = useState<RecorderStats>({ frames: 0, bytes: 0, level: 0, peakLevel: 0 });
  const [filteredFrames, setFilteredFrames] = useState(0);
  const [speakerSegments, setSpeakerSegments] = useState<Map<string, string[]>>(new Map());
  const [selectedSpeaker, setSelectedSpeaker] = useState('');
  const [hasMultipleSpeakers, setHasMultipleSpeakers] = useState(false);
  const [voiceFilterMode, setVoiceFilterMode] = useState(false);
  const [voiceGuideDismissed, setVoiceGuideDismissed] = useState(() => {
    try {
      return localStorage.getItem(voiceGuideStorageKey) === 'true';
    } catch {
      return false;
    }
  });
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
  const manualEditBaseRef = useRef('');
  const hasManualEditRef = useRef(false);
  const voiceBaselineRef = useRef(0);
  const voiceFrameCountRef = useRef(0);
  const voiceFilterSampleRateRef = useRef(targetSampleRate);
  const filteredFrameCountRef = useRef(0);
  const voiceFilterAppliedTextRef = useRef('');

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
  const currentEditRate = useMemo(() => {
    const baseline = enhancedText || rawFinalText;
    if (!baseline || !inputText || baseline === inputText) {
      return 0;
    }
    return calculateTextEditRate(baseline, inputText);
  }, [enhancedText, rawFinalText, inputText]);

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

  useEffect(() => {
    debugLog('text state changed', {
      rawFinalLength: rawFinalText.length,
      inputTextLength: inputText.length,
      processedTextLength: processedText.length,
      enhancedTextLength: enhancedText.length,
      processingState,
      inputPreview: inputText.slice(0, 80),
    });
  }, [rawFinalText, inputText, processedText, enhancedText, processingState]);

  const introStoryRefs = useRef<Array<HTMLElement | null>>([]);
  const introSectionRefs = useRef<Array<HTMLElement | null>>([]);
  const introScrollLockRef = useRef<number | null>(null);

  useEffect(() => {
    if (!showIntro) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        const scene = visibleEntry?.target.getAttribute('data-scene') as IntroScene | null;
        if (scene) {
          setIntroScene(scene);
        }
      },
      {
        root: null,
        rootMargin: '-28% 0px -46% 0px',
        threshold: [0.24, 0.42, 0.64],
      },
    );

    introStoryRefs.current.forEach((node) => {
      if (node) {
        observer.observe(node);
      }
    });

    return () => observer.disconnect();
  }, [showIntro]);

  function focusIntroScene(scene: IntroScene) {
    setIntroScene(scene);
    const index = introSceneOrder.indexOf(scene);
    introStoryRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function jumpIntroPage(direction: 1 | -1) {
    const sections = introSectionRefs.current.filter(Boolean) as HTMLElement[];
    const currentIndex = sections.reduce((closestIndex, section, index) => {
      const currentDistance = Math.abs(section.getBoundingClientRect().top);
      const closestDistance = Math.abs(sections[closestIndex].getBoundingClientRect().top);
      return currentDistance < closestDistance ? index : closestIndex;
    }, 0);
    const nextIndex = Math.max(0, Math.min(sections.length - 1, currentIndex + direction));
    sections[nextIndex]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleIntroWheel(event: WheelEvent<HTMLElement>) {
    if (Math.abs(event.deltaY) < 18) {
      return;
    }

    event.preventDefault();

    if (introScrollLockRef.current) {
      return;
    }

    jumpIntroPage(event.deltaY > 0 ? 1 : -1);
    introScrollLockRef.current = window.setTimeout(() => {
      introScrollLockRef.current = null;
    }, 760);
  }

  function dismissVoiceGuide() {
    setVoiceGuideDismissed(true);
    try {
      localStorage.setItem(voiceGuideStorageKey, 'true');
    } catch {
      // Ignore storage failures; the guide can safely reappear next session.
    }
  }

  function handleVoiceFilterModeChange(enabled: boolean) {
    setVoiceFilterMode(enabled);
    dismissVoiceGuide();
  }

  function resetManualEditTracking(baseText: string) {
    manualEditBaseRef.current = baseText;
    hasManualEditRef.current = false;
  }

  function handleInputTextChange(value: string) {
    setInputText(value);
    setProcessedText('');
    setProcessingSource('');
    setProcessingLatencyMS(null);
    hasManualEditRef.current = value.trim() !== manualEditBaseRef.current.trim();
  }

  function getManualEditCommitFields(finalText: string) {
    const shouldLearnHotwords =
      hasManualEditRef.current &&
      manualEditBaseRef.current.trim() !== '' &&
      finalText.trim() !== manualEditBaseRef.current.trim();

    return {
      learn_hotwords: shouldLearnHotwords,
      ...(shouldLearnHotwords ? { manual_edit_base: manualEditBaseRef.current } : {}),
    };
  }

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

  async function loadMetrics() {
    setMetricsLoading(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/metrics/summary?user_id=${encodeURIComponent(userID)}`);
      const payload = (await response.json()) as MetricsSummary;
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      setMetricsSummary(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMetricsLoading(false);
    }
  }

  function openMetricsDashboard() {
    setMetricsOpen(true);
    void checkHealth();
    void loadHotwords();
    void loadMetrics();
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
    latestInputKeyRef.current = commitKey;
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
          ...getManualEditCommitFields(inputText),
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
      resetManualEditTracking(inputText);
      setCommitMessage(`${text.autoProcessed}${payload.mappings?.length ? `\uff0c${payload.mappings.length} \u6761\u66ff\u6362` : ''}`);
      if (payload.mappings?.length) {
        setLearnedMappings(payload.mappings);
        setMemoryDialogOpen(true);
        await loadHotwords();
        await loadPreferences();
      }
      if (metricsOpen) {
        await loadMetrics();
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

  async function processVoiceFilterInput(filteredText: string) {
    const cleanText = filteredText.trim();
    debugLog('voice filter: commit input start', { textLength: cleanText.length, preview: cleanText.slice(0, 80) });
    if (!cleanText) {
      debugLog('voice filter: commit input skipped empty text');
      return;
    }

    const requestID = crypto.randomUUID();
    setProcessingState('processing');
    setProcessingSource('');
    setProcessingLatencyMS(null);
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
          original_text: cleanText,
          enhanced_text: cleanText,
          final_text: cleanText,
          learn_hotwords: false,
          apply_hotwords: true,
          request_id: requestID,
        }),
      });
      debugLog('voice filter: commit response received', { status: response.status, ok: response.ok });
      const payload = (await response.json()) as InputCommitResponse;
      debugLog('voice filter: commit payload', {
        status: payload.status,
        textLength: payload.text?.length ?? 0,
        source: payload.source,
        latencyMS: payload.latency_ms,
        mappings: payload.mappings?.length ?? 0,
      });
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      const output = payload.text || cleanText;
      debugLog('voice filter: writing processed output', {
        rawLength: cleanText.length,
        outputLength: output.length,
        outputPreview: output.slice(0, 80),
      });
      setInputBaseline(output);
      setEnhancedText(output);
      setInputText(output);
      resetManualEditTracking(output);
      setProcessedText(output);
      setProcessingState('completed');
      setProcessingSource(payload.source ?? '');
      setProcessingLatencyMS(payload.latency_ms ?? null);
      if (payload.mappings?.length) {
        setLearnedMappings(payload.mappings);
      }
      setCommitMessage(text.autoProcessed);
    } catch (err) {
      debugLog('voice filter: commit input failed', err instanceof Error ? err.message : err);
      setProcessingState('failed');
      const message = err instanceof Error ? err.message : String(err);
      setCommitMessage(message);
      setError(message);
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
    resetManualEditTracking('');
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
    resetVoiceFilterState();
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
        startAudioProcessingForFilter(mediaStream);
        return;
      }

      const realtimeMode = voiceFilterMode ? 'raw' : mode;
      const ws = new WebSocket(
        `${toWebSocketBase(apiBaseUrl)}/ws/asr?user_id=${encodeURIComponent(userID)}&mode=${encodeURIComponent(realtimeMode)}`,
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
        const draft = `${finalSegmentsRef.current.join('')}${message.text}`;
        setLiveText(draft);
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
      if (voiceFilterMode && voiceFilterAppliedTextRef.current) {
        return;
      }
      const original = message.original_text ?? rawFinalText;
      const enhanced = message.enhanced_text ?? message.text ?? original;
      const input = message.text ?? enhanced;
      setRawFinalText(original);
      setEnhancedText(enhanced);
      setInputBaseline(enhanced);
      setInputText(input);
      resetManualEditTracking(input);
      setProcessedText('');
      setProcessingState('idle');
      setProcessingSource('');
      setProcessingLatencyMS(null);
      setCommitMessage(text.autoWaiting);
      if (message.mappings?.length) {
        setLearnedMappings(message.mappings);
        void loadHotwords();
      }
      return;
    }

    if (message.type === 'processed') {
      if (voiceFilterMode && voiceFilterAppliedTextRef.current) {
        return;
      }
      const output = message.text ?? '';
      setProcessingState('completed');
      setProcessingSource(message.source ?? '');
      setProcessingLatencyMS(message.latency_ms ?? null);
      setRawFinalText(message.original_text ?? rawFinalText);
      setEnhancedText(message.enhanced_text ?? '');
      setInputBaseline(message.enhanced_text ?? output);
      setInputText(output);
      resetManualEditTracking(output);
      setProcessedText(output);
      setCommitMessage(text.autoProcessed);
      if (message.mappings?.length) {
        setLearnedMappings(message.mappings);
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

  function resetVoiceFilterState() {
    audioBufferRef.current = [];
    voiceFilterAppliedTextRef.current = '';
    setVoiceFilterLoading(false);
    setVoiceFilterResult(null);
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
      setLiveText('\u6b63\u5728\u6574\u7406\u5f55\u97f3...');
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const buf of buffers) {
        combined.set(buf, offset);
        offset += buf.length;
      }

      setLiveText('\u6b63\u5728\u51c6\u5907\u79bb\u7ebf\u8bc6\u522b...');
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

      setLiveText(text.voiceFilterWorking);
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
      debugLog('voice filter: sentences sample', sentences.slice(0, 5).map((sentence) => ({
        speakerID: sentence.speaker_id,
        textLength: sentence.text.length,
        textPreview: sentence.text.slice(0, 50),
      })));
      setVoiceFilterResult({
        sentences,
        speaker_count: payload.speaker_count || 0,
      });
      const firstSpeakerID = firstSpeakerIDFromSentences(sentences);
      const userText = firstSpeakerID === null
        ? (payload.full_text || '')
        : textForSpeaker(sentences, firstSpeakerID);
      debugLog('voice filter: selected user speaker', {
        firstSpeakerID,
        userTextLength: userText.length,
        fullTextLength: payload.full_text?.length ?? 0,
        userTextPreview: userText.slice(0, 80),
      });
      setSelectedSpeaker(firstSpeakerID === null ? 'all' : String(firstSpeakerID));
      setRawFinalText(userText);
      setEnhancedText(userText);
      setInputBaseline(userText);
      setInputText(userText);
      resetManualEditTracking(userText);
      setLiveText(userText);
      setCommitMessage(firstSpeakerID === null ? text.autoWaiting : text.voiceFilterApplied);
      debugLog('voice filter: wrote filtered text before commit', {
        rawFinalLength: userText.length,
        inputTextLength: userText.length,
      });
      await processVoiceFilterInput(userText);
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
    const processor = audioContext.createScriptProcessor(voiceFilterProcessorBufferSize, 1, 1);

    processor.onaudioprocess = (event) => {
      if (recordingStateRef.current !== 'recording') return;
      const input = event.inputBuffer.getChannelData(0);
      const level = calculateRMS(input);
      const peakLevel = calculatePeak(input);
      const normalizedLevel = normalizeVoiceLevel(level, peakLevel);
      audioBufferRef.current.push(new Float32Array(input));
      setWaveLevels((levels) => [...levels.slice(1), normalizedLevel]);
      setRecorderStats((stats) => ({
        frames: stats.frames + 1,
        bytes: stats.bytes + input.byteLength,
        level,
        peakLevel: Math.max(stats.peakLevel, peakLevel),
      }));
      if (debugEnabled && audioBufferRef.current.length % 80 === 1) {
        debugLog('voice filter: audio buffered', {
          buffers: audioBufferRef.current.length,
          level,
          peakLevel,
          normalizedLevel,
        });
      }
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
    const processor = audioContext.createScriptProcessor(realtimeProcessorBufferSize, 1, 1);

    processor.onaudioprocess = (event) => {
      if (ws.readyState !== WebSocket.OPEN || recordingStateRef.current !== 'recording') {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const level = calculateRMS(input);
      const peakLevel = calculatePeak(input);

      voiceFrameCountRef.current += 1;
      voiceBaselineRef.current = Math.max(voiceBaselineRef.current * 0.995, level);

      const downsampled = downsample(input, audioContext.sampleRate, targetSampleRate);
      const pcm = encodePCM16(downsampled);
      ws.send(pcm);
      if (voiceFilterMode) {
        audioBufferRef.current.push(downsampled);
      }

      if (voiceFrameCountRef.current % realtimeUIUpdateEveryFrames === 0) {
        const normalizedLevel = normalizeVoiceLevel(level, peakLevel);
        setWaveLevels((levels) => [...levels.slice(1), normalizedLevel]);
        setRecorderStats((stats) => {
          const next = {
            frames: voiceFrameCountRef.current,
            bytes: stats.bytes + pcm.byteLength * realtimeUIUpdateEveryFrames,
            level,
            peakLevel: Math.max(stats.peakLevel, peakLevel),
          };
          if (debugEnabled && next.frames % 100 === 0) {
            debugLog('audio frame sent', { frames: next.frames, bytes: next.bytes, level, peakLevel, baseline: voiceBaselineRef.current, samples: downsampled.length });
          }
          return next;
        });
      }
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

  function clearSessionText() {
    setLiveText('');
    setInputText('');
    setInputBaseline('');
    resetManualEditTracking('');
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
    resetManualEditTracking('');
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

  function renderIntroDemo(scene: IntroScene) {
    const demo = introScenarios[scene];

    return (
      <section className="intro-demo-stage">
        <div className="intro-demo-top">
          <div>
            <span>{demo.eyebrow}</span>
            <strong>
              {demo.titleLines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </strong>
          </div>
          <em>{demo.proof}</em>
        </div>

        <div className="intro-waveform" aria-hidden="true">
          {Array.from({ length: 56 }, (_, i) => (
            <i
              key={i}
              style={{
                '--level': `${0.2 + Math.abs(Math.sin(i * 0.42)) * 0.64}`,
                '--delay': `${i * 24}ms`,
              } as CSSProperties}
            />
          ))}
        </div>

        <div className={`intro-effect-layer ${scene}`}>
          {scene === 'polish' ? (
            <div className="intro-token-stream" aria-label="改口清理演示">
              <span>今天是</span>
              <span className="muted">星期一</span>
              <span className="muted">不对</span>
              <span className="keep">星期二</span>
              <span>下午三点</span>
              <span className="muted">那个</span>
              <span>同步需求</span>
            </div>
          ) : null}
          {scene === 'memory' ? (
            <div className="intro-memory-demo" aria-label="热词记忆演示">
              <div className="memory-edit">
                <span>张立</span>
                <i>编辑为</i>
                <strong>张莉</strong>
              </div>
              <div className="memory-vault">
                <Brain size={18} aria-hidden="true" />
                <span>本地记忆已更新</span>
                <em>下次自动替换</em>
              </div>
            </div>
          ) : null}
          {scene === 'voice' ? (
            <div className="intro-speaker-demo" aria-label="声纹过滤演示">
              <div className="speaker-lane primary">
                <span>我</span>
                <i />
                <strong>明天发版本，重点看热词命中。</strong>
              </div>
              <div className="speaker-lane muted">
                <span>周围人</span>
                <i />
                <strong>帮我拿杯咖啡。</strong>
              </div>
            </div>
          ) : null}
        </div>

        <div className="intro-pipeline">
          <article className="intro-transcript-card">
            <span>实时听到</span>
            <p>{demo.raw}</p>
          </article>
          <div className="intro-process-rail" aria-hidden="true">
            <span />
            <Check size={18} />
            <span />
          </div>
          <article className="intro-transcript-card final">
            <span>VoxMem 输出</span>
            <p>{demo.output}</p>
          </article>
        </div>

        <p className="intro-demo-desc">{demo.description}</p>
      </section>
    );
  }

  if (showIntro) {
    return (
      <main className="intro-shell" onWheel={handleIntroWheel}>
        <section
          ref={(node) => {
            introSectionRefs.current[0] = node;
          }}
          className="intro-page-section intro-hero"
        >
          <div className="intro-copy">
            <span className="intro-kicker">
              <span className={`intro-live-dot status-${healthState}`} />
              VoxMem Voice Memory
            </span>
            <h1>把口述变成真正能提交的文字</h1>
            <p>面向中文办公口述的输入台：自动处理改口，记住你的专属热词，并从多人声音里保留你的表达。</p>
            <div className="intro-switcher" aria-label="功能演示">
              {([
                { key: 'polish' as IntroScene, label: '改口清理', icon: Sparkles },
                { key: 'memory' as IntroScene, label: '热词记忆', icon: Brain },
                { key: 'voice' as IntroScene, label: '声纹过滤', icon: Mic },
              ]).map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={introScene === item.key ? 'active' : ''}
                    onClick={() => focusIntroScene(item.key)}
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="intro-actions">
              <button type="button" className="intro-primary" onClick={() => setShowIntro(false)}>
                进入语音工作台
                <Send size={20} aria-hidden="true" />
              </button>
              <span>{statusLabel}，无需账号，直接使用本机麦克风。</span>
            </div>
          </div>

          <div className="intro-product" aria-live="polite">
            {renderIntroDemo(introScene)}
            <section className="intro-proof-grid">
              <article className={introScene === 'polish' ? 'active' : ''}>
                <Sparkles size={22} aria-hidden="true" />
                <div>
                  <strong>改口识别</strong>
                  <p>“不对、应该是、刚才说错了”会被压缩成最终结论。</p>
                </div>
              </article>
              <article className={introScene === 'memory' ? 'active' : ''}>
                <Database size={22} aria-hidden="true" />
                <div>
                  <strong>本地记忆</strong>
                  <p>人名、项目名、行业词编辑后进入个人替换规则。</p>
                </div>
              </article>
              <article className={introScene === 'voice' ? 'active' : ''}>
                <Mic size={22} aria-hidden="true" />
                <div>
                  <strong>说话人过滤</strong>
                  <p>多人语音先切分，再只保留目标说话人的内容。</p>
                </div>
              </article>
            </section>
          </div>
        </section>

        {introFeatureCards.map((card, index) => (
          <section
            key={card.key}
            ref={(node) => {
              introStoryRefs.current[index] = node;
              introSectionRefs.current[index + 1] = node;
            }}
            data-scene={card.key}
            className={`intro-page-section intro-story-panel ${introScene === card.key ? 'active' : ''}`}
          >
            <div className="intro-story-copy">
              <span>{card.label}</span>
              <h2>{card.title}</h2>
              <p>{card.body}</p>
              <em>{card.metric}</em>
              <button type="button" className="intro-primary" onClick={() => setShowIntro(false)}>
                进入语音工作台
                <Send size={20} aria-hidden="true" />
              </button>
            </div>
            <div className="intro-product">{renderIntroDemo(card.key)}</div>
          </section>
        ))}

        <section
          ref={(node) => {
            introSectionRefs.current[introFeatureCards.length + 1] = node;
          }}
          className="intro-page-section intro-scenarios-page"
        >
          <div className="intro-story-copy">
            <span>04 / 真实场景</span>
            <h2>常见办公口述，不需要重新整理一遍</h2>
            <p>会议、词库和嘈杂环境三个入口，会自然连接到同一个语音工作台。</p>
            <button type="button" className="intro-primary" onClick={() => setShowIntro(false)}>
              进入语音工作台
              <Send size={20} aria-hidden="true" />
            </button>
          </div>
          <section className="intro-scenario-strip" aria-label="真实场景">
            <article>
              <span>01</span>
              <strong>会议纪要</strong>
              <p>边说边修正，最终只留下确认后的事项。</p>
            </article>
            <article>
              <span>02</span>
              <strong>专属词库</strong>
              <p>常用同事名、客户名、项目代号越用越准。</p>
            </article>
            <article>
              <span>03</span>
              <strong>嘈杂环境</strong>
              <p>旁边人的插话不会轻易混入你的正文。</p>
            </article>
          </section>
        </section>
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
          <button type="button" className="ghost-button" onClick={openMetricsDashboard}>
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
              onChange={(event) => handleVoiceFilterModeChange(event.target.checked)}
              disabled={isRecordingActive}
            />
            <span>{text.voiceFilter}</span>
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
                  onChange={(event) => handleInputTextChange(event.target.value)}
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
              <div className="source-text speaker-filter">
                <span>{text.voiceFilter}</span>
                <p>{text.voiceFilterWorking}</p>
              </div>
            ) : null}

            {voiceFilterResult && voiceFilterResult.speaker_count > 1 && selectedSpeaker !== 'all' ? (
              <div className="source-text speaker-filter">
                <span>{text.voiceFilterApplied}</span>
                <button type="button" onClick={() => {
                  setSelectedSpeaker('all');
                  const all = voiceFilterResult.sentences.map((sentence) => sentence.text).join('');
                  setRawFinalText(all);
                  setInputText(all);
                  resetManualEditTracking(all);
                  setLiveText(all);
                }}>
                  {'\u663e\u793a\u5168\u90e8'}
                </button>
              </div>
            ) : null}

            <section className="command-bar" aria-label="鎿嶄綔">
              <button
                className={`record-action ${isRecordingActive ? 'recording' : ''}`}
                type="button"
                disabled={!canUseRecordButton}
                onClick={toggleRecording}
                aria-label={isRecordingActive ? text.stopRecordingTitle : text.startRecordingTitle}
                title={isRecordingActive ? text.stopRecordingTitle : text.startRecordingTitle}
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

            <section className={!voiceGuideDismissed ? 'voice-processing-card has-guide' : 'voice-processing-card'}>
              <div className="pane-heading">
                <h2><Mic size={18} aria-hidden="true" />{text.voiceProcessing}</h2>
              </div>
              <div className="toggle-stack">
                <label className={voiceFilterMode ? 'active voice-option' : 'voice-option'}>
                  <span>{text.voiceFilter}</span>
                  <input
                    type="checkbox"
                    checked={voiceFilterMode}
                    onChange={(event) => handleVoiceFilterModeChange(event.target.checked)}
                    disabled={isRecordingActive}
                  />
                </label>
              </div>
              {!voiceGuideDismissed ? (
                <div className="coachmark voice-filter-guide" role="note" aria-label="去除周围人声功能说明">
                  <span>新功能</span>
                  <strong>{text.voiceFilter}</strong>
                  <p>会议室或旁边有人说话时打开，录音结束后会先分离说话人，只保留主要说话人的内容。</p>
                  <button type="button" onClick={dismissVoiceGuide}>
                    知道了
                  </button>
                </div>
              ) : null}
            </section>

            <section className="mode-card">
              <div className="pane-heading">
                <h2><Sparkles size={18} aria-hidden="true" />{'\u8f93\u51fa\u6a21\u5f0f'}</h2>
              </div>
              <div className="mode-stack">
                {([
                  { key: 'raw' as OutputMode, label: '\u539f\u58f0', desc: '\u4ec5\u672c\u5730\u8bb0\u5fc6\u66ff\u6362\uff0c\u4e0d\u8c03\u7528 AI' },
                  { key: 'polish' as OutputMode, label: '\u8f7b\u6574\u7406', desc: 'AI \u4fee\u6b63\u6539\u53e3\u3001\u53bb\u53e3\u5934\u7985' },
                ]).map((opt) => (
                  <button
                    key={opt.key}
                    className={mode === opt.key ? 'active' : ''}
                    type="button"
                    onClick={() => setMode(opt.key)}
                  >
                    <span className="mode-label">{opt.label}</span>
                    <span className="mode-desc">{opt.desc}</span>
                  </button>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </section>

      {metricsOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="输入质量观察">
          <div className="memory-modal metrics-modal">
            <div className="pane-heading metrics-heading">
              <div>
                <h2>{'\u8f93\u5165\u8d28\u91cf\u89c2\u5bdf'}</h2>
                <p>{'\u770b\u8fd9\u5957\u8bed\u97f3\u8f93\u5165\u662f\u5426\u8d8a\u7528\u8d8a\u51c6\u3001\u8d8a\u7528\u8d8a\u7701\u4e8b\u3002'}</p>
              </div>
              <div className="metrics-actions">
                <button type="button" aria-label="刷新指标" title="刷新指标" onClick={() => void loadMetrics()} disabled={metricsLoading}>
                  <RefreshCw size={16} aria-hidden="true" />
                </button>
                <button type="button" aria-label={text.close} title={text.close} onClick={() => setMetricsOpen(false)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="metrics-grid">
              <article>
                <span>{'\u5e73\u5747\u4fee\u6539\u7387'}</span>
                <strong>{formatPercent(metricsSummary?.average_edit_rate ?? 0)}</strong>
                <em>{'\u6700\u8fd1 10 \u6b21\u4fee\u6539'}</em>
              </article>
              <article>
                <span>{'\u8bb0\u5fc6\u547d\u4e2d'}</span>
                <strong>{formatNumber(metricsSummary?.hotword_hit_count ?? 0)}</strong>
                <em>{'\u672c\u5730\u70ed\u8bcd\u5df2\u81ea\u52a8\u66ff\u6362'}</em>
              </article>
              <article>
                <span>{'\u70ed\u8bcd\u603b\u6570'}</span>
                <strong>{formatNumber(metricsSummary?.hotword_count ?? hotwords.length)}</strong>
                <em>{`${formatNumber(metricsSummary?.hotword_learned_count ?? 0)} \u6b21\u5b66\u4e60`}</em>
              </article>
              <article>
                <span>{'\u672c\u6b21\u6574\u7406'}</span>
                <strong>{formatLatency(processingLatencyMS)}</strong>
                <em>{processingSource ? `${text.processedBy}: ${processingSource}` : '\u7b49\u5f85\u672c\u6b21\u8f93\u5165'}</em>
              </article>
            </div>

            <div className="metrics-status-grid">
              <section>
                <h3>{'\u672c\u6b21\u8f93\u5165'}</h3>
                <dl>
                  <div><dt>{'\u4fee\u6539\u7387'}</dt><dd>{formatPercent(currentEditRate)}</dd></div>
                  <div><dt>{'\u539f\u59cb\u5b57\u6570'}</dt><dd>{formatNumber([...originalTranscript].length)}</dd></div>
                  <div><dt>{'\u8f93\u51fa\u5b57\u6570'}</dt><dd>{formatNumber([...resultText].length)}</dd></div>
                  <div><dt>{'\u97f3\u9891\u5e27'}</dt><dd>{formatNumber(recorderStats.frames)}</dd></div>
                </dl>
              </section>
              <section>
                <h3>{'\u94fe\u8def\u5065\u5eb7'}</h3>
                <dl>
                  <div><dt>API</dt><dd>{statusLabel}</dd></div>
                  <div><dt>ASR</dt><dd>{recordingStateLabel(recordingState)}</dd></div>
                  <div><dt>LLM</dt><dd>{processingState === 'processing' ? text.autoProcessing : processingState === 'failed' ? '\u5931\u8d25' : '\u53ef\u7528'}</dd></div>
                  <div><dt>{'\u9ea6\u514b\u98ce'}</dt><dd>{micLooksSilent ? '\u672a\u68c0\u6d4b\u5230\u58f0\u97f3' : micDiagnostics?.label || text.defaultMicrophone}</dd></div>
                </dl>
              </section>
            </div>

            <section className="recent-metrics">
              <div className="recent-metrics-title">
                <h3>{'\u6700\u8fd1\u4fee\u6539'}</h3>
                <span>{metricsLoading ? '\u5237\u65b0\u4e2d' : `${metricsSummary?.correction_count ?? 0} \u6b21\u7d2f\u8ba1\u4fee\u6539`}</span>
              </div>
              {metricsSummary?.recent_corrections?.length ? (
                <div className="recent-metrics-list">
                  {metricsSummary.recent_corrections.map((item) => (
                    <article key={item.id}>
                      <div>
                        <strong>{formatPercent(item.edit_rate)}</strong>
                        <span>{formatMetricTime(item.created_at)}</span>
                      </div>
                      <p>{item.corrected_text}</p>
                      <em>{`${item.edit_distance} \u5904\u4fee\u6539`}</em>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="placeholder">{'\u6682\u65e0\u4fee\u6539\u8bb0\u5f55\uff0c\u5f55\u97f3\u540e\u7f16\u8f91\u5e76\u786e\u8ba4\u4e00\u6b21\u5c31\u4f1a\u51fa\u73b0\u6570\u636e\u3002'}</p>
              )}
            </section>
          </div>
        </div>
      ) : null}

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
  return Array.from({ length: 44 }, () => 0);
}

function createPreviewWave() {
  const barCount = 44;
  return Array.from({ length: barCount }, (_, index) => {
    const centerDistance = Math.abs(index - (barCount - 1) / 2) / (barCount / 2);
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

function calculateTextEditRate(original: string, corrected: string) {
  const a = [...original];
  const b = [...corrected];
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) {
    return 0;
  }
  return levenshteinDistance(a, b) / maxLength;
}

function levenshteinDistance(a: string[], b: string[]) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, value) * 100)}%`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatLatency(value: number | null) {
  if (value === null) {
    return '--';
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  return `${value}ms`;
}

function formatMetricTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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
