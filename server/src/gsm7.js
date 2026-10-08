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
