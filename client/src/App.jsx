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

const TAB_KEY = 'abhyaas.tab';
const TABS = [
  { id: 'class', label: 'Class' },
  { id: 'mistakes', label: 'Mistakes' },
  { id: 'doubts', label: 'Questions from students' },
  { id: 'send', label: 'Send SMS' },
  { id: 'messages', label: 'Messages' },
];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Up to 3 plain lines for the top of the page. Each points at a tab and the
// element to scroll to.
function todayLines(stats, doubts) {
  const lines = [];
  const weak = stats?.topics?.[0];
  if (weak) {
    lines.push({ text: `Weakest topic: ${weak.name} (${weak.pct}% right first time)`, tab: 'class', target: 'weak-topics' });
  }
  // wrongCount counts first tries, and a review can serve a student the same
  // question again, so it says "times", not "students".
  const mistake = (stats?.misconceptions ?? []).filter((m) => m.wrongOption).reduce((a, b) => (!a || b.wrongCount > a.wrongCount ? b : a), null);
  if (mistake) {
    lines.push({
      text: `Most common mistake: Q${mistake.id}, answer ${mistake.wrongOption} chosen ${plural(mistake.wrongCount, 'time', 'times')}`,
      tab: 'mistakes',
      target: `mistake-${mistake.id}`,
    });
  }
  if (doubts?.length) {
    lines.push({ text: `${plural(doubts.length, 'student question', 'student questions')} waiting`, tab: 'doubts', target: 'doubts' });
  }
  return lines;
}

export default function App() {
  const [subject, setSubjectState] = useState(() => {
    try {
      return localStorage.getItem(SUBJECT_KEY) === 'SCI' ? 'SCI' : 'MATH';
    } catch {
      return 'MATH';
    }
  });
  const [tab, setTabState] = useState(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return TABS.some((t) => t.id === saved) ? saved : 'class';
    } catch {
      return 'class';
    }
  });
  // { id, at }: the element to scroll to once its tab has rendered.
  const [focus, setFocus] = useState(null);
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

  function setTab(t) {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // private window: the tab just isn't remembered
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
  useEffect(() => {
    if (focus) document.getElementById(focus.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focus, tab]);

  const connected = live?.gateway?.mode === 'termux';
  const today = todayLines(stats, doubts);
  const go = (line) => {
    setTab(line.tab);
    setFocus({ id: line.target, at: Date.now() });
  };

  return (
    <main className="dash">
      <header className="dash-head">
        <div>
          <h1>Abhyaas</h1>
          <p className="sub">SEE practice by SMS · Teacher page</p>
        </div>
        <div className="switch" role="group" aria-label="Subject">
          {Object.entries(SUBJECT_NAMES).map(([code, name]) => (
            <button key={code} className={subject === code ? 'on' : ''} aria-pressed={subject === code} onClick={() => setSubject(code)}>
              {name}
            </button>
          ))}
        </div>
        <span className={`gateway ${connected ? 'on' : 'off'}`}>SMS phone: {connected ? 'connected' : 'not connected'}</span>
        <a href="/import">Add questions from a photo</a>
        <a href="/phone">Phone simulator</a>
      </header>
      {error && <p className="error">Cannot reach the laptop server: {error}</p>}

      <section className="today" aria-label="Today">
        <h2>Today · {SUBJECT_NAMES[subject]}</h2>
        {!stats ? (
          <Loading />
        ) : today.length ? (
          <ul>
            {today.map((line) => (
              <li key={line.target}>
                <button className="today-line" onClick={() => go(line)}>
                  {line.text} <span aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No answers yet. Students start by texting JOIN and their name.</p>
        )}
      </section>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'doubts' && doubts?.length > 0 && <span className="count">{doubts.length}</span>}
          </button>
        ))}
      </nav>

      <div className="grid" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'class' && (
          <>
            <Overview overview={stats?.overview} subject={subject} />
            <WeakTopics topics={stats?.topics} subject={subject} />
            <Students rows={stats?.students} subject={subject} />
          </>
        )}
        {tab === 'mistakes' && <Misconceptions rows={stats?.misconceptions} highlight={focus?.id} />}
        {tab === 'doubts' && <Doubts doubts={doubts} onSent={refresh} />}
        {tab === 'send' && (
          <>
            <Broadcast students={stats?.overview.students} onSent={refresh} />
            <DailyPush push={push} setPush={setPush} onSent={refresh} />
          </>
        )}
        {tab === 'messages' && <MessageLog messages={live?.messages} />}
      </div>
    </main>
  );
}

const Loading = () => <p className="empty">Loading...</p>;

function Card({ title, wide, id, children }) {
  return (
    <section id={id} className={`card ${wide ? 'wide' : ''}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Overview({ overview, subject }) {
  const tiles = overview
    ? [
        ['Students', overview.students],
        ['Answers this week', overview.answersWeek],
        ['Right on first try', pctText(overview.firstTryAccuracy), overview.firstTries ? `this week, out of ${overview.firstTries}` : 'no answers yet'],
      ]
    : [];
  return (
    <Card title={`Class · ${SUBJECT_NAMES[subject]}`} wide>
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
      {t.correct} of {t.tries} right on first try ({t.pct}%)
    </div>
  );
}

function WeakTopics({ topics, subject }) {
  return (
    <Card title="Weakest topics · right on first try" id="weak-topics">
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

const SHORT_STEM = 40;

// One row per question: how many got it right first time, the wrong answer
// chosen most, and the hint students get for it. The full question shows on tap.
function Misconceptions({ rows, highlight }) {
  return (
    <Card title="Common mistakes · hardest questions first" wide>
      {!rows ? (
        <Loading />
      ) : !rows.length ? (
        <p className="empty">No answers yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="misc stack">
            <thead>
              <tr>
                <th>Question</th>
                <th>Right first time</th>
                <th>Most common wrong answer</th>
                <th>Hint students get</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} id={`mistake-${r.id}`} className={highlight === `mistake-${r.id}` ? 'flash' : ''}>
                  <td data-label="Question">
                    {r.stem.length > SHORT_STEM ? (
                      <details className="stem-more">
                        <summary>
                          <strong>Q{r.id}</strong> {r.stem.slice(0, SHORT_STEM - 3).trimEnd()}...
                        </summary>
                        <p>{r.stem}</p>
                      </details>
                    ) : (
                      <>
                        <strong>Q{r.id}</strong> {r.stem}
                      </>
                    )}
                  </td>
                  <td data-label="Right first time" className="num">
                    {pctText(r.pct)} <span className="muted">(of {r.tries})</span>
                  </td>
                  <td data-label="Most common wrong answer">
                    {r.wrongOption ? (
                      <>
                        <strong>
                          {r.wrongOption}) {r.wrongText}
                        </strong>{' '}
                        <span className="muted">· {plural(r.wrongCount, 'time', 'times')}</span>
                      </>
                    ) : (
                      <span className="muted">Nobody got it wrong</span>
                    )}
                  </td>
                  <td data-label="Hint students get">
                    {r.wrongOption && (r.explanation ?? <span className="muted">No hint yet</span>)}
                  </td>
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
                <th>Right in a row</th>
                <th>Right on first try</th>
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
                  <td>{s.weakest ? TOPICS[subject][s.weakest] : <span className="muted">-</span>}</td>
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
    <Card title={`Questions from students${doubts ? ` (${doubts.length})` : ''}`} wide id="doubts">
      {!doubts && <Loading />}
      {doubts?.length === 0 && <p className="empty">No questions waiting. Students ask by texting ASK and their question.</p>}
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
                <span className="muted">Answered by the computer (Gemma):</span> {d.gemmaReply}
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
    <Card title="Message all students">
      <SmsBox
        label="Message to all students"
        placeholder="e.g. No class on Friday. Keep practising: send QUIZ."
        value={text}
        onChange={(t) => (setText(t), setDone(null))}
        button={students ? `Send to ${students} students` : 'Send to all'}
        onSend={async (t) => {
          if (!window.confirm(`Send this SMS to all ${students ?? ''} students?`)) return false;
          const { queued } = await sendJson('POST', '/api/broadcast', { text: t });
          setDone(`Sending to ${queued} students.`);
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
      setResult(`Sending ${plural(queued, 'question', 'questions')}${skipped ? `. ${skipped} skipped (no question ready for them)` : ''}.`);
      onSent();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Daily question for every student">
      {push && (
        <>
          <p>
            {push.time ? (
              <>
                Every day at <strong>{push.time}</strong>
                {push.lastPushDate && <span className="muted"> · last sent {push.lastPushDate}</span>}
              </>
            ) : (
              <span className="muted">Not switched on. Set DAILY_PUSH_TIME=HH:MM in .env and restart the server.</span>
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
                      {name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button className="primary" onClick={sendNow} disabled={busy}>
            {busy ? 'Sending...' : 'Send one question to everyone now'}
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
    <Card title="Latest messages" wide>
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
                    <span className={`dir ${m.direction}`}>{m.direction === 'in' ? 'From student' : 'To student'}</span>
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
