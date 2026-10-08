import { useEffect, useRef, useState } from 'react';

// A keypad-phone SMS thread for the projector. Messages go through the same
// POST /api/sms/incoming the SMS gateway uses; the thread polls every 3s so
// pushed questions show up too. /api/health says whether the Android gateway
// phone is sending heartbeats.
const LETTERS = ['A', 'B', 'C', 'D'];
const COMMANDS = ['QUIZ', 'TOPICS', 'SUBJECT', 'ASK', 'SCORE', 'HELP'];
const NEW = 'new';
const POLL_MS = 3000;
const HEALTH_MS = 5000;

// SQLite UTC "YYYY-MM-DD HH:MM:SS" -> local "HH:MM"
const clock = (ts) =>
  new Date(`${ts.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function Phone() {
  const [students, setStudents] = useState([]);
  const [choice, setChoice] = useState('');
  const [newNumber, setNewNumber] = useState('');
  const [thread, setThread] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [gateway, setGateway] = useState(null);
  const inputRef = useRef(null);
  const endRef = useRef(null);

  // Same rule as the server's normalizePhone(): +977 98... -> 98...
  const typed = newNumber.replace(/\D/g, '');
  const phone = choice !== NEW ? choice : typed.length === 13 && typed.startsWith('977') ? typed.slice(3) : typed;

  function loadStudents(select) {
    return fetch('/api/sim/students')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((list) => {
        setStudents(list);
        setChoice((c) => select ?? (c || list[0]?.phone || NEW));
      })
      .catch((e) => setError(e.message));
  }

  useEffect(() => {
    loadStudents();
  }, []);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch('/api/health')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((h) => live && setGateway(h.gateway))
        .catch(() => live && setGateway(null));
    load();
    const id = setInterval(load, HEALTH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!phone) return setThread([]);
    let live = true;
    const load = () =>
      fetch(`/api/sim/thread?phone=${encodeURIComponent(phone)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((rows) => live && (setThread(rows), setError(null)))
        .catch((e) => live && setError(e.message));
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [phone, tick]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.length, phone]);

  async function send(body) {
    if (!phone || !body.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/sms/incoming', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, body }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setText('');
      setTick((t) => t + 1);
      // A new number that just joined moves into the dropdown.
      if (choice === NEW && /^\s*join\s/i.test(body)) {
        await loadStudents(phone);
        setNewNumber('');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function pressCommand(cmd) {
    if (cmd === 'ASK') {
      setText('ASK ');
      inputRef.current?.focus();
    } else send(cmd);
  }

  const current = students.find((s) => s.phone === choice);

  return (
    <div className="sim">
      <div className="sim-bar">
        <label>
          Student{' '}
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {students.map((s) => (
              <option key={s.phone} value={s.phone}>
                {s.name} ({s.masked})
              </option>
            ))}
            <option value={NEW}>New number...</option>
          </select>
        </label>
        {choice === NEW && (
          <input
            className="sim-number"
            inputMode="numeric"
            placeholder="98XXXXXXXX"
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
          />
        )}
        <span className={`gateway ${gateway?.mode === 'termux' ? 'on' : 'off'}`}>
          Phone gateway: {gateway?.mode === 'termux' ? 'connected' : 'not connected'}
        </span>
        <a href="/">Dashboard</a>
      </div>
      {error && <p className="error">Server: {error}</p>}

      <div className="handset">
        <div className="screen">
          <div className="screen-head">
            <span>Abhyaas</span>
            <span className="screen-who">{current ? current.name : phone ? 'New number' : ''}</span>
          </div>
          <div className="thread">
            {thread.length === 0 && (
              <p className="thread-empty">{phone ? 'No messages yet. Send JOIN <your name> to start.' : 'Type a phone number above.'}</p>
            )}
            {thread.map((m) => (
              <div key={m.id} className={`bubble ${m.direction === 'in' ? 'mine' : 'theirs'}`}>
                {m.body}
                <time>{clock(m.created_at)}</time>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <form
            className="compose"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type SMS" disabled={!phone} />
            <button type="submit" disabled={!phone || busy || !text.trim()}>
              Send
            </button>
          </form>
        </div>

        <div className="keys letters">
          {LETTERS.map((l) => (
            <button key={l} className="key letter" onClick={() => send(l)} disabled={!phone || busy}>
              {l}
            </button>
          ))}
        </div>
        <div className="keys commands">
          {COMMANDS.map((c) => (
            <button key={c} className="key" onClick={() => pressCommand(c)} disabled={!phone || busy}>
              {c}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
