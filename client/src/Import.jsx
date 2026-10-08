import { useEffect, useState } from 'react';
import { SMS_LIMIT, gsmLength } from '../../server/src/gsm7.js';
import { checkCard } from '../../server/src/photo-import.js';
import { LETTERS, TOPICS, formatQuestionSms } from '../../server/src/sms.js';
import { getJson, sendJson } from './api.js';

// /import: 1. take a photo of a SEE maths page, 2. check the questions one at
// a time, 3. approve. The cloud model drafts the cards; the checks the server
// runs on approve show here live, in plain words. The photo goes to the
// server in one request and is never stored.
const POLL_MS = 2000;
const opt = (l) => `option_${l.toLowerCase()}`;
const NOT_SHOWN = "has a character a keypad phone can't show (like ², ×, π or Nepali letters)";

// Notes only for the wrong letters, so changing the correct answer can't
// leave a note on it.
function cleaned(card) {
  const misconceptions = {};
  for (const l of LETTERS) {
    const note = String(card.misconceptions?.[l] ?? '').trim();
    if (l !== card.correct_option && note) misconceptions[l] = note;
  }
  return { ...card, misconceptions };
}

// Validator and server messages -> words for a teacher. Unknown ones pass through.
const REASONS = [
  [/^question SMS is (\d+) chars/, (m) => `Too long for one SMS (${m[1]} of ${SMS_LIMIT} letters). Shorten the question or answers.`],
  [/^question SMS has non GSM-7/, () => `The question ${NOT_SHOWN}.`],
  [/^stem is empty/, () => 'The question is empty.'],
  [/^option ([A-D]) is empty/, (m) => `Answer ${m[1]} is empty.`],
  [/^option ([A-D]) has non GSM-7/, (m) => `Answer ${m[1]} ${NOT_SHOWN}.`],
  [/^options ([A-D]) and ([A-D]) have the same value/, (m) => `Answers ${m[1]} and ${m[2]} are the same.`],
  [/^correct_option must be/, () => 'Tick the correct answer.'],
  [/^topic for/, () => 'Choose a topic (in More details).'],
  [/^solution is empty/, () => 'Write the working (how to get the answer).'],
  [/^solution has non GSM-7/, () => `The working ${NOT_SHOWN}.`],
  [/^solution is (\d+) chars/, (m) => `The working is too long (${m[1]} of ${SMS_LIMIT} letters).`],
  [/^solution step "(.*)=(.*)" is wrong: .* = (.*)$/, (m) => `A sum in the working is wrong: ${m[1]} is ${m[3]}, not ${m[2]}.`],
  [/^solution ends at "(.*)", not the correct value "(.*)"$/, (m) => `The working ends at ${m[1] || 'nothing'}, but the correct answer says ${m[2]}.`],
  [/^missing misconception note for wrong option ([A-D])/, (m) => `Write the mistake behind answer ${m[1]} (in More details).`],
  [/^misconception ([A-D]) has non GSM-7/, (m) => `The mistake note for answer ${m[1]} ${NOT_SHOWN}.`],
  [/^misconceptions must be/, () => 'Write the mistake behind each wrong answer (in More details).'],
  [/^Asks to "(.+)"/, (m) => `This asks students to ${m[1]}. SMS answers can only be A, B, C or D.`],
  [/^Topic .* is not one of the SMS maths topics/, () => "This topic can't be practised by SMS."],
  [/^Marked not SMS-suitable by the model/, () => "This one can't be turned into an A/B/C/D question."],
];
function plainReason(text) {
  for (const [re, say] of REASONS) {
    const m = re.exec(text);
    if (m) return say(m);
  }
  return text;
}
const isNoteReason = (text) => /^(missing misconception|misconception)/.test(text);

export default function Import() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  // [{ key, card, status: 'open'|'approved'|'skipped', id, serverErrors }]
  const [cards, setCards] = useState([]);
  const [index, setIndex] = useState(0);

  async function upload(file) {
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
      setCards(data.cards.map((card, i) => ({ key: `${Date.now()}-${i}`, card, status: 'open', id: null, serverErrors: [] })));
      setIndex(0);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function startAgain() {
    setResult(null);
    setCards([]);
    setIndex(0);
    setError(null);
  }

  const update = (i, patch) => setCards((cs) => cs.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const approved = cards.filter((c) => c.status === 'approved').length;
  const skipped = cards.filter((c) => c.status === 'skipped').length;
  const allDone = cards.length > 0 && approved + skipped === cards.length;
  const step = !result ? 1 : allDone ? 3 : 2;

  // After approve or skip: the next card still open, else simply the next one.
  function moveOn(from, list) {
    const next = list.findIndex((c, k) => k > from && c.status === 'open');
    setIndex(next >= 0 ? next : Math.min(from + 1, list.length - 1));
  }

  async function approve(i) {
    const clean = cleaned(cards[i].card);
    try {
      const { id } = await sendJson('POST', '/api/import/questions', clean);
      const list = cards.map((c, k) => (k === i ? { ...c, status: 'approved', id, serverErrors: [] } : c));
      setCards(list);
      moveOn(i, list);
    } catch (err) {
      update(i, { serverErrors: [err.message] });
    }
  }

  function skip(i) {
    const list = cards.map((c, k) => (k === i ? { ...c, status: 'skipped' } : c));
    setCards(list);
    moveOn(i, list);
  }

  const entry = cards[index];
  return (
    <main className="dash import">
      <header className="dash-head">
        <div>
          <h1>Add questions from a photo</h1>
          <p className="sub">Maths only · nothing reaches students until you approve it</p>
        </div>
        <a href="/">Back to the teacher page</a>
      </header>

      <ol className="steps">
        {['Take a photo', 'Check the questions', 'Approve'].map((label, i) => (
          <li key={label} className={step === i + 1 ? 'on' : step > i + 1 ? 'past' : ''} aria-current={step === i + 1 ? 'step' : undefined}>
            <span className="step-n">{i + 1}</span> {label}
          </li>
        ))}
      </ol>

      {!result && (
        <section className="card photo-step">
          <label className={`big-button ${busy ? 'busy' : ''}`}>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              disabled={busy}
              onChange={(e) => {
                upload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            {busy ? 'Reading the photo... (1-2 minutes)' : 'Take a photo of the question paper'}
          </label>
          <p className="muted">One page at a time, flat and in good light. The photo is read by a cloud model once and is not saved.</p>
          {error && <p className="error">{error}</p>}
        </section>
      )}

      {result && (
        <section className="card">
          <p className="summary">{result.summary}</p>
          {result.missing.length > 0 && <p className="error">No question made for: {result.missing.join(', ')}</p>}
          {cards.length > 0 && (
            <p>
              {approved} approved · {skipped} skipped · {cards.length - approved - skipped} left
            </p>
          )}
          {allDone && <p className="ok">Done. {approved ? `${approved} new question${approved === 1 ? '' : 's'} can now go to students.` : 'Nothing was approved.'}</p>}
          <button className="secondary" onClick={startAgain}>
            Take another photo
          </button>
        </section>
      )}

      {entry && (
        <>
          <nav className="card-nav" aria-label="Questions">
            <button className="secondary" onClick={() => setIndex(index - 1)} disabled={index === 0}>
              ‹ Previous
            </button>
            <strong>
              Question {index + 1} of {cards.length}
            </strong>
            <button className="secondary" onClick={() => setIndex(index + 1)} disabled={index === cards.length - 1}>
              Next ›
            </button>
          </nav>
          <ImportCard
            key={entry.key}
            entry={entry}
            onChange={(patch) => update(index, patch)}
            onApprove={() => approve(index)}
            onSkip={() => skip(index)}
          />
        </>
      )}

      <Explanations />
    </main>
  );
}

function ImportCard({ entry, onChange, onApprove, onSkip }) {
  const { card, status, id, serverErrors } = entry;
  const [saving, setSaving] = useState(false);
  const [more, setMore] = useState(false);
  const topicName = TOPICS.MATH[card.topic];

  if (card.unsuitable) {
    return (
      <section className="card import-card unsuitable">
        <h2>Part {card.source_ref || '?'} · can't be sent by SMS</h2>
        {card.stem && <p>{card.stem}</p>}
        <p>{plainReason(card.unsuitable)}</p>
        <div className="big-actions">
          <button className="big secondary" onClick={onSkip} disabled={status === 'skipped'}>
            {status === 'skipped' ? 'Skipped' : 'Skip'}
          </button>
        </div>
      </section>
    );
  }

  const clean = cleaned(card);
  if (status === 'approved') {
    return (
      <section className="card import-card done">
        <h2>
          Part {card.source_ref} · approved (Q{id})
        </h2>
        <p className="ok">Saved. Students can now get this question.</p>
        <pre className="sms">{formatQuestionSms(clean, id)}</pre>
      </section>
    );
  }

  const { unsuitable, errors } = checkCard(clean);
  const problems = unsuitable ? [unsuitable] : errors;
  const reasons = [...problems, ...serverErrors].map(plainReason);
  const showMore = more || problems.some(isNoteReason);
  const sms = formatQuestionSms(clean, 9999);
  const smsLen = gsmLength(sms);
  const set = (field) => (e) => onChange({ card: { ...card, [field]: e.target.value }, serverErrors: [] });
  const setNote = (l) => (e) =>
    onChange({ card: { ...card, misconceptions: { ...card.misconceptions, [l]: e.target.value } }, serverErrors: [] });

  async function approve() {
    setSaving(true);
    await onApprove();
    setSaving(false);
  }

  return (
    <section className={`card import-card ${reasons.length ? 'invalid' : ''}`}>
      <h2>
        Part {card.source_ref || '?'} · {topicName ?? 'no topic'}
        {status === 'skipped' && <span className="muted"> · skipped</span>}
      </h2>
      <label className="import-field">
        Question
        <textarea rows={3} value={card.stem} onChange={set('stem')} />
      </label>
      <fieldset className="answers">
        <legend>Answers · tick the correct one</legend>
        {LETTERS.map((l) => (
          <div key={l} className={`answer ${l === card.correct_option ? 'correct' : ''}`}>
            <input
              type="radio"
              name={`correct-${entry.key}`}
              aria-label={`${l} is correct`}
              checked={l === card.correct_option}
              onChange={() => onChange({ card: { ...card, correct_option: l }, serverErrors: [] })}
            />
            <span className="letter">{l})</span>
            <input aria-label={`Answer ${l}`} value={card[opt(l)] ?? ''} onChange={set(opt(l))} />
          </div>
        ))}
      </fieldset>
      <label className="import-field">
        Working (ends with "= answer")
        <input value={card.solution} onChange={set('solution')} />
      </label>

      {reasons.length > 0 && (
        <div className="reasons">
          <strong>Fix before approving:</strong>
          <ul>
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <button className="link" onClick={() => setMore(!showMore)} aria-expanded={showMore}>
        {showMore ? '▾' : '▸'} More details
      </button>
      {showMore && (
        <div className="more">
          <div className="import-row">
            <label>
              Part <input value={card.source_ref} onChange={set('source_ref')} size={8} />
            </label>
            <label>
              Topic{' '}
              <select value={card.topic} onChange={set('topic')}>
                {Object.entries(TOPICS.MATH).map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">The mistake a student makes to get each wrong answer:</p>
          {LETTERS.filter((l) => l !== card.correct_option).map((l) => (
            <label key={l} className="note-row">
              <span className="letter">{l})</span>
              <input value={card.misconceptions?.[l] ?? ''} onChange={setNote(l)} placeholder={`Why a student picks ${l}`} />
            </label>
          ))}
          <p className="muted">
            The SMS students get:{' '}
            <span className={`counter ${smsLen === null || smsLen > SMS_LIMIT ? 'bad' : ''}`}>
              {smsLen ?? '?'}/{SMS_LIMIT} letters
            </span>
          </p>
          <pre className="sms">{sms}</pre>
        </div>
      )}

      <div className="big-actions">
        <button className="big primary" onClick={approve} disabled={problems.length > 0 || saving}>
          {saving ? 'Saving...' : 'Approve'}
        </button>
        <button className="big secondary" onClick={onSkip}>
          Skip
        </button>
      </div>
    </section>
  );
}

// Local Gemma drafts a hint for each wrong answer of approved imports.
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
      <h2>Hints for wrong answers (optional)</h2>
      <p className="muted">
        Gemma, on this laptop, writes a short hint for each wrong answer of the questions you approved. Students see a
        hint only after a teacher checks it.
      </p>
      <button className="secondary" onClick={start} disabled={job?.running}>
        {job?.running ? `Writing hints... (${job.checked} done)` : 'Write hints'}
      </button>
      {job?.done && !job.error && (
        <p>
          {job.drafted} hints written{job.failed ? `, ${job.failed} could not be written` : ''}. Check them with{' '}
          <code>npm run explain:review -- list</code>
        </p>
      )}
      {(job?.error || error) && <p className="error">{job?.error || error}</p>}
    </section>
  );
}
