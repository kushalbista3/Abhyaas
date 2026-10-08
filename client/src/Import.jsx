import { useEffect, useState } from 'react';
import { SMS_LIMIT, gsmLength } from '../../server/src/gsm7.js';
import { checkCard } from '../../server/src/photo-import.js';
import { LETTERS, TOPICS, formatQuestionSms } from '../../server/src/sms.js';
import { getJson, sendJson } from './api.js';

// /import: a teacher photographs a SEE maths page; the cloud model drafts one
// card per sub-part; the same checks the server runs on approve show live
// here. The photo goes to the server in one request and is never stored.
const POLL_MS = 2000;
const opt = (l) => `option_${l.toLowerCase()}`;

// Notes only for the wrong letters, so changing the answer letter can't leave
// a note on the correct one.
function cleaned(card) {
  const misconceptions = {};
  for (const l of LETTERS) {
    const note = String(card.misconceptions?.[l] ?? '').trim();
    if (l !== card.correct_option && note) misconceptions[l] = note;
  }
  return { ...card, misconceptions };
}

export default function Import() {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [cards, setCards] = useState([]);

  async function upload(e) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/import/photo', {
        method: 'POST',
        headers: { 'content-type': file.type || 'image/jpeg' },
        body: file,
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
      setResult(data);
      setCards(data.cards.map((card, i) => ({ key: `${Date.now()}-${i}`, card, saved: null, serverErrors: [] })));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const update = (key, patch) => setCards((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const discard = (key) => setCards((cs) => cs.filter((c) => c.key !== key));

  return (
    <main className="dash import">
      <header className="dash-head">
        <div>
          <h1>Import questions</h1>
          <p className="sub">Maths only · photo of a SEE paper → SMS cards · nothing reaches students until you approve</p>
        </div>
        <a href="/">Dashboard</a>
      </header>

      <section className="card">
        <form className="field" onSubmit={upload}>
          <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="primary" type="submit" disabled={!file || busy}>
            {busy ? 'Reading the photo (1-2 minutes)...' : 'Read photo'}
          </button>
        </form>
        <p className="muted">The photo is sent to the cloud model once and is not saved anywhere.</p>
        {error && <p className="error">{error}</p>}
        {result && (
          <>
            <p className="summary">{result.summary}</p>
            {result.missing.length > 0 && <p className="error">No card for: {result.missing.join(', ')}</p>}
          </>
        )}
      </section>

      <div className="import-cards">
        {cards.map((c) => (
          <ImportCard key={c.key} entry={c} onChange={(patch) => update(c.key, patch)} onDiscard={() => discard(c.key)} />
        ))}
      </div>

      <Explanations />
    </main>
  );
}

function ImportCard({ entry, onChange, onDiscard }) {
  const { card, saved, serverErrors } = entry;
  const [saving, setSaving] = useState(false);

  if (card.unsuitable) {
    return (
      <section className="card import-card unsuitable">
        <h2>{card.source_ref || '?'} · not SMS-suitable</h2>
        {card.stem && <p>{card.stem}</p>}
        <p className="muted">{card.unsuitable}</p>
        <button onClick={onDiscard}>Discard</button>
      </section>
    );
  }

  const clean = cleaned(card);
  const { unsuitable, errors } = checkCard(clean);
  const problems = unsuitable ? [`Not SMS-suitable: ${unsuitable}`] : errors;
  const sms = formatQuestionSms(clean, 9999);
  const smsLen = gsmLength(sms);
  const set = (field) => (e) => onChange({ card: { ...card, [field]: e.target.value }, serverErrors: [] });
  const setNote = (l) => (e) =>
    onChange({ card: { ...card, misconceptions: { ...card.misconceptions, [l]: e.target.value } }, serverErrors: [] });

  async function approve() {
    setSaving(true);
    try {
      const { id } = await sendJson('POST', '/api/import/questions', clean);
      onChange({ saved: id, serverErrors: [] });
    } catch (err) {
      onChange({ serverErrors: [err.message] });
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <section className="card import-card done">
        <h2>
          {card.source_ref} · saved as #{saved}
        </h2>
        <pre className="sms">{formatQuestionSms(clean, saved)}</pre>
      </section>
    );
  }

  const bad = problems.length > 0 || serverErrors.length > 0;
  return (
    <section className={`card import-card ${bad ? 'invalid' : ''}`}>
      <div className="import-row">
        <label>
          Part <input value={card.source_ref} onChange={set('source_ref')} size={8} />
        </label>
        <label>
          Topic{' '}
          <select value={card.topic} onChange={set('topic')}>
            {Object.entries(TOPICS.MATH).map(([code, name]) => (
              <option key={code} value={code}>
                {code} {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Correct{' '}
          <select value={card.correct_option ?? ''} onChange={set('correct_option')}>
            {LETTERS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="import-field">
        Question
        <textarea rows={2} value={card.stem} onChange={set('stem')} />
      </label>
      {LETTERS.map((l) => (
        <div key={l} className="import-option">
          <label className={l === card.correct_option ? 'correct' : ''}>
            {l}) <input value={card[opt(l)] ?? ''} onChange={set(opt(l))} />
          </label>
          {l !== card.correct_option && (
            <input className="note" placeholder="Mistake behind this option" value={card.misconceptions?.[l] ?? ''} onChange={setNote(l)} />
          )}
        </div>
      ))}
      <label className="import-field">
        Solution (ends "= answer")
        <input value={card.solution} onChange={set('solution')} />
      </label>
      <details>
        <summary>
          SMS preview <span className={`counter ${smsLen === null || smsLen > SMS_LIMIT ? 'bad' : ''}`}>{smsLen ?? '?'}/{SMS_LIMIT}</span>
        </summary>
        <pre className="sms">{sms}</pre>
      </details>
      {bad && (
        <ul className="reasons">
          {[...problems, ...serverErrors].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="import-row">
        <button className="primary" onClick={approve} disabled={problems.length > 0 || saving}>
          {saving ? 'Saving...' : 'Approve'}
        </button>
        <button onClick={onDiscard}>Discard</button>
      </div>
    </section>
  );
}

// Local Gemma drafts wrong-option explanations for approved imports.
function Explanations() {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!job?.running) return;
    const id = setInterval(() => getJson('/api/import/explanations').then(setJob).catch((e) => setError(e.message)), POLL_MS);
    return () => clearInterval(id);
  }, [job?.running]);

  async function start() {
    setError(null);
    try {
      setJob(await sendJson('POST', '/api/import/explanations'));
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <section className="card">
      <h2>Explanations for approved imports</h2>
      <p className="muted">Local Gemma drafts a short hint for each wrong option. Drafts reach students only after review.</p>
      <button className="primary" onClick={start} disabled={job?.running}>
        {job?.running ? `Drafting... (${job.checked} options checked)` : 'Draft explanations'}
      </button>
      {job?.done && !job.error && (
        <p>
          {job.drafted} drafts saved, {job.failed} failed. Review: <code>npm run explain:review -- list</code>
        </p>
      )}
      {(job?.error || error) && <p className="error">{job?.error || error}</p>}
    </section>
  );
}
