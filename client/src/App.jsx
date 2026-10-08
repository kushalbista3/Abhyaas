import { useCallback, useEffect, useState } from 'react';
import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { SUBJECT_NAMES, TOPICS } from '../../server/src/sms.js';
import { fromSql, getJson, sendJson } from './api.js';
import SmsBox from './SmsBox.jsx';

// Teacher dashboard, sized for a projector. Student names only; the message
// log shows masked numbers (the server masks them).
const LIVE_MS = 3000;
const STATS_MS = 10000;
const SUBJECT_KEY = 'abhyaas.subject';
const BAR = '#2f6f4f';

const when = (ts) => fromSql(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const clock = (ts) => fromSql(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pctText = (pct) => (pct === null ? '-' : `${pct}%`);

// Runs load() now and every `ms`; again whenever `deps` change.
function usePoll(load, ms, deps) {
  useEffect(() => {
    let live = true;
    const run = () => load(() => live);
    run();
    const id = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export default function App() {
  const [subject, setSubjectState] = useState(() => {
    try {
      return localStorage.getItem(SUBJECT_KEY) === 'SCI' ? 'SCI' : 'MATH';
    } catch {
      return 'MATH';
    }
  });
  const [stats, setStats] = useState(null);
  const [doubts, setDoubts] = useState(null);
  const [live, setLive] = useState(null);
  const [push, setPush] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  function setSubject(s) {
    setSubjectState(s);
    setStats(null);
    try {
      localStorage.setItem(SUBJECT_KEY, s);
    } catch {
      // private window: the switch just isn't remembered
    }
  }

  usePoll(
    (alive) =>
      Promise.all([getJson(`/api/dashboard?subject=${subject}`), getJson('/api/doubts')])
        .then(([s, d]) => alive() && (setStats(s), setDoubts(d), setError(null)))
        .catch((e) => alive() && setError(e.message)),
    STATS_MS,
    [subject, tick],
  );
  usePoll(
    (alive) =>
      getJson('/api/messages')
        .then((l) => alive() && setLive(l))
        .catch(() => alive() && setLive(null)),
    LIVE_MS,
    [tick],
  );
  useEffect(() => {
    getJson('/api/push').then(setPush).catch((e) => setError(e.message));
  }, []);

  const connected = live?.gateway?.mode === 'termux';

  return (
    <main className="dash">
      <header className="dash-head">
        <div>
          <h1>Abhyaas</h1>
          <p className="sub">SEE practice by SMS · Teacher dashboard</p>
        </div>
        <div className="switch" role="group" aria-label="Subject">
          {Object.entries(SUBJECT_NAMES).map(([code, name]) => (
            <button key={code} className={subject === code ? 'on' : ''} aria-pressed={subject === code} onClick={() => setSubject(code)}>
              {name}
            </button>
          ))}
        </div>
        <span className={`gateway ${connected ? 'on' : 'off'}`}>Phone gateway: {connected ? 'connected' : 'not connected'}</span>
        <a href="/phone">Phone simulator</a>
      </header>
      {error && <p className="error">Server: {error}</p>}

      <div className="grid">
        <Overview overview={stats?.overview} subject={subject} />
        <WeakTopics topics={stats?.topics} subject={subject} />
        <Students rows={stats?.students} subject={subject} />
        <Misconceptions rows={stats?.misconceptions} />
        <Doubts doubts={doubts} onSent={refresh} />
        <Broadcast students={stats?.overview.students} onSent={refresh} />
        <DailyPush push={push} setPush={setPush} onSent={refresh} />
        <MessageLog messages={live?.messages} />
      </div>
    </main>
  );
}

const Loading = () => <p className="empty">Loading...</p>;

function Card({ title, wide, children }) {
  return (
    <section className={`card ${wide ? 'wide' : ''}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Overview({ overview, subject }) {
  const tiles = overview
    ? [
        ['Students', overview.students],
        ['Answers, last 7 days', overview.answersWeek],
        ['First-try accuracy', pctText(overview.firstTryAccuracy), overview.firstTries ? `${overview.firstTries} first tries` : 'no answers yet'],
      ]
    : [];
  return (
    <Card title={`Class overview · ${SUBJECT_NAMES[subject]}`} wide>
      <div className="tiles">
        {tiles.map(([label, value, note]) => (
          <div key={label} className="tile">
            <div className="tile-value">{value}</div>
            <div className="tile-label">{label}</div>
            {note && <div className="tile-note">{note}</div>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function TopicTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const t = payload[0].payload;
  return (
    <div className="tip">
      <strong>
        {t.topic} {t.name}
      </strong>
      <br />
      {t.correct} of {t.tries} right on the first try ({t.pct}%)
    </div>
  );
}

function WeakTopics({ topics, subject }) {
  return (
    <Card title="Weak topics · first-try accuracy, worst first">
      {!topics ? (
        <Loading />
      ) : !topics.length ? (
        <p className="empty">No {SUBJECT_NAMES[subject]} answers yet.</p>
      ) : (
        <div className="chart" style={{ height: 40 + topics.length * 52 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topics} layout="vertical" margin={{ top: 4, right: 96, bottom: 4, left: 0 }} barCategoryGap={8}>
              <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} unit="%" tick={{ fontSize: 18, fill: '#55554f' }} stroke="#c9c9c0" />
              <YAxis type="category" dataKey="topic" width={80} tick={{ fontSize: 20, fill: '#1d1d1b' }} stroke="#c9c9c0" tickLine={false} />
              <Tooltip content={<TopicTip />} cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
              <Bar dataKey="pct" fill={BAR} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                <LabelList
                  dataKey="pct"
                  position="right"
                  content={({ x, y, width, height, index }) => (
                    <text x={x + width + 8} y={y + height / 2} dominantBaseline="central" fontSize={20} fill="#1d1d1b">
                      {topics[index].pct}% <tspan fill="#55554f">({topics[index].tries})</tspan>
                    </text>
                  )}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function Misconceptions({ rows }) {
  return (
    <Card title="Misconceptions · lowest first-try % first" wide>
      {!rows ? (
        <Loading />
      ) : !rows.length ? (
        <p className="empty">No answers yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="misc">
            <thead>
              <tr>
                <th>Question</th>
                <th>First try</th>
                <th>Most-chosen wrong option</th>
                <th>Approved explanation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>
                      Q{r.id} {r.topic}
                    </strong>
                    <div className="stem">{r.stem}</div>
                  </td>
                  <td className="num">
                    {pctText(r.pct)} <span className="muted">of {r.tries}</span>
                  </td>
                  <td>
                    {r.wrongOption ? (
                      <>
                        <strong>
                          {r.wrongOption}) {r.wrongText}
                        </strong>{' '}
                        <span className="muted">×{r.wrongCount}</span>
                      </>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                  <td>{r.wrongOption && (r.explanation ?? <span className="muted">No approved explanation yet</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Students({ rows, subject }) {
  return (
    <Card title={`Students · ${SUBJECT_NAMES[subject]}`}>
      {!rows ? (
        <Loading />
      ) : !rows.length ? (
        <p className="empty">No students yet. They join by texting JOIN and their name.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Streak</th>
                <th>Accuracy</th>
                <th>Weakest topic</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="num">{s.streak}</td>
                  <td className="num">
                    {pctText(s.pct)} <span className="muted">of {s.tries}</span>
                  </td>
                  <td>{s.weakest ? `${s.weakest} ${TOPICS[subject][s.weakest]}` : <span className="muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Doubts({ doubts, onSent }) {
  const [drafts, setDrafts] = useState({});
  const setDraft = (id, text) => setDrafts((d) => ({ ...d, [id]: text }));
  return (
    <Card title={`Doubts inbox${doubts ? ` (${doubts.length})` : ''}`} wide>
      {!doubts && <Loading />}
      {doubts?.length === 0 && <p className="empty">No doubts waiting. Students send ASK and their question.</p>}
      <div className="doubts">
        {doubts?.map((d) => (
          <article key={d.id} className="doubt">
            <div className="doubt-head">
              <strong>{d.name}</strong>
              <span className={`badge ${d.subject}`}>{SUBJECT_NAMES[d.subject]}</span>
              <span className="muted">{when(d.created_at)}</span>
            </div>
            <p className="doubt-text">{d.text}</p>
            {d.gemmaReply && (
              <p className="gemma">
                <span className="muted">Gemma answered:</span> {d.gemmaReply}
              </p>
            )}
            <SmsBox
              label={`Reply to ${d.name}`}
              placeholder={`Reply to ${d.name} by SMS`}
              value={drafts[d.id] ?? ''}
              onChange={(t) => setDraft(d.id, t)}
              onSend={async (text) => {
                await sendJson('POST', `/api/doubts/${d.id}/reply`, { text });
                onSent();
              }}
            />
          </article>
        ))}
      </div>
    </Card>
  );
}

function Broadcast({ students, onSent }) {
  const [text, setText] = useState('');
  const [done, setDone] = useState(null);
  return (
    <Card title="Broadcast to all students">
      <SmsBox
        label="Broadcast message"
        placeholder="e.g. No class on Friday. Keep practising: send QUIZ."
        value={text}
        onChange={(t) => (setText(t), setDone(null))}
        button={students ? `Send to ${students} students` : 'Send to all'}
        onSend={async (t) => {
          if (!window.confirm(`Send this SMS to all ${students ?? ''} students?`)) return false;
          const { queued } = await sendJson('POST', '/api/broadcast', { text: t });
          setDone(`Queued for ${queued} students.`);
          onSent();
        }}
      />
      {done && <p className="ok">{done}</p>}
    </Card>
  );
}

function DailyPush({ push, setPush, onSent }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function setTopic(topic) {
    setError(null);
    try {
      setPush(await sendJson('PUT', '/api/push', { topic: topic || null }));
    } catch (e) {
      setError(e.message);
    }
  }

  async function sendNow() {
    if (!window.confirm('Send one question to every student now?')) return;
    setBusy(true);
    setError(null);
    try {
      const { queued, skipped } = await sendJson('POST', '/api/push/now');
      setResult(`Queued ${queued} question(s)${skipped ? `, ${skipped} skipped (no approved question)` : ''}.`);
      onSent();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Daily question push">
      {push && (
        <>
          <p>
            {push.time ? (
              <>
                Every day at <strong>{push.time}</strong>
                {push.lastPushDate && <span className="muted"> · last sent {push.lastPushDate}</span>}
              </>
            ) : (
              <span className="muted">Not scheduled. Set DAILY_PUSH_TIME=HH:MM in .env and restart the server.</span>
            )}
          </p>
          <label className="field">
            Topic
            <select value={push.topic ?? ''} onChange={(e) => setTopic(e.target.value)}>
              <option value="">Each student's weakest topic</option>
              {Object.entries(TOPICS).map(([subject, topics]) => (
                <optgroup key={subject} label={SUBJECT_NAMES[subject]}>
                  {Object.entries(topics).map(([code, name]) => (
                    <option key={code} value={code}>
                      {code} {name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button className="primary" onClick={sendNow} disabled={busy}>
            {busy ? 'Sending...' : 'Send now'}
          </button>
        </>
      )}
      {result && <p className="ok">{result}</p>}
      {error && <p className="error">{error}</p>}
    </Card>
  );
}

function MessageLog({ messages }) {
  return (
    <Card title="Live message log · last 20" wide>
      {!messages ? (
        <Loading />
      ) : !messages.length ? (
        <p className="empty">No messages yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="log">
            <tbody>
              {messages.map((m) => (
                <tr key={m.id} className={m.direction}>
                  <td className="muted nowrap">{clock(m.created_at)}</td>
                  <td className="nowrap">
                    <span className={`dir ${m.direction}`}>{m.direction === 'in' ? 'IN' : 'OUT'}</span>
                  </td>
                  <td className="nowrap">
                    {m.name ?? 'Unknown'} <span className="muted">{m.masked}</span>
                  </td>
                  <td className="body">{m.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
