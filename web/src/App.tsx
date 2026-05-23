import { Mic, RefreshCw, Server, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type HealthState = 'checking' | 'ok' | 'error';

type HealthPayload = {
  status: string;
  service: string;
  env: string;
  timestamp: string;
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';

function App() {
  const [healthState, setHealthState] = useState<HealthState>('checking');
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'polish' | 'raw' | 'markdown'>('polish');

  const statusLabel = useMemo(() => {
    if (healthState === 'ok') return '后端已连接';
    if (healthState === 'checking') return '检查连接中';
    return '后端未连接';
  }, [healthState]);

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
      setError(err instanceof Error ? err.message : '无法连接后端服务');
    }
  }

  useEffect(() => {
    void checkHealth();
  }, []);

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

          <button className="record-button" type="button" disabled title="录音链路将在下一阶段接入">
            <Mic size={28} aria-hidden="true" />
            <span>录音待接入</span>
          </button>

          <div className="actions">
            <button type="button" onClick={() => void checkHealth()}>
              <RefreshCw size={16} aria-hidden="true" />
              <span>重试连接</span>
            </button>
            <button type="button" disabled>
              <Square size={16} aria-hidden="true" />
              <span>停止</span>
            </button>
          </div>
        </div>

        <div className="text-grid">
          <section className="text-pane">
            <div className="pane-heading">
              <h2>实时识别</h2>
              <span>阶段一接入 ASR</span>
            </div>
            <p className="placeholder">录音链路完成后，这里会显示阿里云 Paraformer 的中间识别结果。</p>
          </section>

          <section className="text-pane">
            <div className="pane-heading">
              <h2>最终输出</h2>
              <span>{mode === 'markdown' ? 'Markdown' : mode === 'raw' ? '原声' : '轻整理'}</span>
            </div>
            <textarea
              aria-label="最终输出文本"
              placeholder="LLM 后处理和本地热词记忆会在后续阶段接入。"
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
          <strong>{health?.service ?? '未连接'}</strong>
        </div>
        <div>
          <span>环境</span>
          <strong>{health?.env ?? '-'}</strong>
        </div>
        <div>
          <span>最近检查</span>
          <strong>{health?.timestamp ? new Date(health.timestamp).toLocaleTimeString() : '-'}</strong>
        </div>
      </section>

      {error ? <p className="error-banner">后端连接失败：{error}</p> : null}
    </main>
  );
}

export default App;
