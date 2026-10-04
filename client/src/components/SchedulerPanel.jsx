import React, { useEffect, useRef, useState } from 'react';
import { runScheduled } from '../api.js';

const MIN_INTERVAL_SECONDS = 5;
const MAX_RUNS = 20;

// Client-side scheduling only: this ticks while the panel is mounted (i.e. while
// this flow's Scheduler tab is open) and stops on unmount/navigation. What makes
// this genuinely "no human login" is the endpoint it calls — /api/scheduler/run
// takes no session and can just as well be driven by a real external scheduler.
export default function SchedulerPanel({ flow, onSteps }) {
  const cfg = flow.scheduler;
  const [tool, setTool] = useState(cfg.tools[0]?.value);
  const [intervalSeconds, setIntervalSeconds] = useState(60);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState([]);
  const busyRef = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearInterval(timerRef.current), []);

  async function runOnce(trigger) {
    if (busyRef.current) return; // previous call still in flight — skip this tick
    busyRef.current = true;
    try {
      const res = await runScheduled(flow.id, tool);
      onSteps(res.steps || []);
      setRuns((prev) =>
        [
          {
            id: `${res.ranAt || Date.now()}-${Math.random().toString(36).slice(2)}`,
            at: res.ranAt || Date.now(),
            trigger,
            tool,
            ok: !!res.ok,
            durationMs: res.durationMs,
            answer: res.answer,
          },
          ...prev,
        ].slice(0, MAX_RUNS)
      );
    } finally {
      busyRef.current = false;
    }
  }

  function startSchedule() {
    const seconds = Math.max(MIN_INTERVAL_SECONDS, Number(intervalSeconds) || MIN_INTERVAL_SECONDS);
    setIntervalSeconds(seconds);
    setRunning(true);
    timerRef.current = setInterval(() => runOnce('scheduled'), seconds * 1000);
  }

  function stopSchedule() {
    clearInterval(timerRef.current);
    setRunning(false);
  }

  return (
    <div className="scheduler-panel">
      <span className="mode-badge">{cfg.badge}</span>
      <h2>{cfg.title}</h2>
      <p className="scheduler-blurb">{cfg.blurb}</p>

      <div className="scheduler-config">
        <label>
          {cfg.toolLabel}
          <select value={tool} disabled={running} onChange={(e) => setTool(e.target.value)}>
            {cfg.tools.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Every (seconds)
          <input
            type="number"
            min={MIN_INTERVAL_SECONDS}
            value={intervalSeconds}
            disabled={running}
            onChange={(e) => setIntervalSeconds(e.target.value)}
          />
        </label>
      </div>

      <div className="scheduler-actions">
        {running ? (
          <button className="btn-primary btn-stop" onClick={stopSchedule}>
            Stop schedule
          </button>
        ) : (
          <button className="btn-primary" onClick={startSchedule}>
            Start schedule
          </button>
        )}
        <button className="btn-ghost dark" onClick={() => runOnce('manual')}>
          Run once now
        </button>
      </div>

      <span className={`status-pill ${running ? 'ok' : 'fail'}`}>{running ? 'Running' : 'Stopped'}</span>

      <div className="runs-head">
        <h4>RUNS ({runs.length})</h4>
        {runs.length > 0 && (
          <button className="btn-ghost dark" onClick={() => setRuns([])}>
            Clear
          </button>
        )}
      </div>
      <div className="runs-list">
        {runs.map((r) => {
          const label = cfg.tools.find((t) => t.value === r.tool)?.label || r.tool;
          return (
            <div key={r.id} className={`run-item ${r.ok ? 'card-ok' : 'card-fail'}`}>
              <div className="run-item-head">
                <span>{new Date(r.at).toLocaleTimeString()}</span>
                <span className="run-item-meta">
                  {r.trigger} · {r.durationMs}ms
                </span>
              </div>
              <div className="run-item-tool">{label}</div>
              <div className="run-item-answer">{r.answer}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
