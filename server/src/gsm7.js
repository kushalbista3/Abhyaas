// GSM 03.38 7-bit default alphabet. One SMS = 160 septets.
// Extension-table characters are sent as ESC + char, so they cost 2.
const BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const EXTENDED = '^{}\\[~]|€\f';

const BASIC_SET = new Set(BASIC);
const EXTENDED_SET = new Set(EXTENDED);

export const SMS_LIMIT = 160;

// Length in GSM-7 septets, or null if the text has any character outside
// GSM-7 (Devanagari, emoji, smart quotes, etc.), which would force UCS-2.
export function gsmLength(text) {
  let n = 0;
  for (const ch of String(text)) {
    if (BASIC_SET.has(ch)) n += 1;
    else if (EXTENDED_SET.has(ch)) n += 2;
    else return null;
  }
  return n;
}

export function nonGsmChars(text) {
  return [...new Set([...String(text)].filter((ch) => !BASIC_SET.has(ch) && !EXTENDED_SET.has(ch)))];
}

export function fitsOneSms(text) {
  const n = gsmLength(text);
  return n !== null && n <= SMS_LIMIT;
}

// Common look-alikes that would otherwise force UCS-2 (or be dropped).
const REPLACEMENTS = Object.fromEntries(
  [
    [0x2018, "'"], [0x2019, "'"], [0x201a, "'"], [0x2032, "'"], // curly quotes, prime
    [0x201c, '"'], [0x201d, '"'], [0x201e, '"'], [0x2033, '"'],
    [0x2013, '-'], [0x2014, '-'], [0x2212, '-'], [0x2026, '...'], // dashes, minus, ellipsis
    [0xd7, '*'], [0xf7, '/'], [0xb2, '^2'], [0xb3, '^3'], [0x3c0, 'pi'], [0x221a, 'sqrt'],
    [0xa0, ' '], [0x09, ' '], // no-break space, tab
  ].map(([code, text]) => [String.fromCodePoint(code), text]),
);

// Every outgoing SMS passes through here: GSM-7 only, at most one SMS.
// Look-alikes are swapped, other non-GSM characters dropped, and text that is
// still longer than `limit` septets is cut with "...".
export function smsSafe(text, limit = SMS_LIMIT) {
  let s = [...String(text ?? '')]
    .map((ch) => (gsmLength(ch) !== null ? ch : REPLACEMENTS[ch] ?? ''))
    .join('')
    .replace(/ {2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
  if (gsmLength(s) <= limit) return s;
  let cut = '';
  let n = 0;
  for (const ch of s) {
    n += gsmLength(ch);
    if (n > limit - 3) break;
    cut += ch;
  }
  return cut.trimEnd() + '...';
}

// The first candidate that fits one SMS as is; otherwise the last one, cut.
export function firstFitting(...candidates) {
  for (const c of candidates) if (fitsOneSms(c)) return c;
  return smsSafe(candidates.at(-1));
}
