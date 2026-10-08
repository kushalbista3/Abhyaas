import { useState } from 'react';
// The server's own GSM-7 code, so the counter matches what it will accept.
import { SMS_LIMIT, gsmLength, smsSafe, unsafeChars } from '../../server/src/gsm7.js';

// What the server will send for `text` (look-alikes like smart quotes swapped),
// and whether it can go as one SMS.
export function checkSms(text) {
  const bad = unsafeChars(text);
  const body = smsSafe(text, Infinity);
  const length = gsmLength(body) ?? 0;
  const ok = !bad.length && body.length > 0 && length <= SMS_LIMIT;
  return { ok, length, bad };
}

// A textarea with a live GSM-7 counter. onSend(text) returns a promise; the
// box clears when it resolves (unless it resolves to false, e.g. the teacher
// cancelled) and shows the error when it rejects.
export default function SmsBox({ value, onChange, onSend, label, button = 'Send', placeholder }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { ok, length, bad } = checkSms(value);
  const over = length > SMS_LIMIT;

  async function submit(e) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      if ((await onSend(value)) !== false) onChange('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="smsbox" onSubmit={submit}>
      <textarea aria-label={label} value={value} placeholder={placeholder} rows={3} onChange={(e) => onChange(e.target.value)} />
      <div className="smsbox-row">
        <span className={`counter ${over || bad.length ? 'bad' : ''}`} aria-live="polite">
          {length}/{SMS_LIMIT}
          {bad.length > 0 && <> · can't send: {bad.join(' ')}</>}
        </span>
        <button type="submit" disabled={!ok || busy}>
          {busy ? 'Sending...' : button}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
