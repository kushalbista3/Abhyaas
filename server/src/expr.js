// Tiny, safe arithmetic/algebra evaluator used only to compare answer values
// (never eval). Supports numbers, + - * / ^, parentheses, implicit
// multiplication (2x, 3ab, (x-1)(x+1)), single-letter variables and pi.
// parse('x^2-1') returns a function vars => number, or null if unparseable.

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|(pi)|([a-z])|([-+*/^()]))/gy;
  let m;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      return null;
    }
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'num', v: Math.PI });
    else if (m[3] !== undefined) tokens.push({ t: 'var', v: m[3] });
    else tokens.push({ t: 'op', v: m[4] });
    pos = re.lastIndex;
  }
  return tokens;
}

export function parse(src) {
  const tokens = tokenize(String(src).toLowerCase());
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;
  const startsAtom = () => peek() && (peek().t !== 'op' || peek().v === '(');

  function expr() {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = tokens[i++].v;
      const l = left, r = term();
      left = op === '+' ? (s) => l(s) + r(s) : (s) => l(s) - r(s);
    }
    return left;
  }
  function term() {
    let left = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = tokens[i++].v;
        const l = left, r = unary();
        left = op === '*' ? (s) => l(s) * r(s) : (s) => l(s) / r(s);
      } else if (startsAtom()) {
        const l = left, r = power();
        left = (s) => l(s) * r(s);
      } else return left;
    }
  }
  function unary() {
    if (isOp('-')) { i++; const u = unary(); return (s) => -u(s); }
    if (isOp('+')) { i++; return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (isOp('^')) { i++; const e = unary(); return (s) => base(s) ** e(s); }
    return base;
  }
  function atom() {
    const tok = tokens[i++];
    if (!tok) throw new Error('unexpected end');
    if (tok.t === 'num') return () => tok.v;
    if (tok.t === 'var') return (s) => s[tok.v];
    if (tok.v === '(') {
      const inner = expr();
      if (!isOp(')')) throw new Error('missing )');
      i++;
      return inner;
    }
    throw new Error(`unexpected ${tok.v}`);
  }

  try {
    const fn = expr();
    return i === tokens.length ? fn : null;
  } catch {
    return null;
  }
}

// Fixed pseudo-random sample points so results are deterministic.
const SAMPLE_POINTS = (() => {
  let seed = 20260;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 4 + 0.5;
  return Array.from({ length: 5 }, () => {
    const vars = {};
    for (const c of 'abcdefghijklmnopqrstuvwxyz') vars[c] = rnd();
    return vars;
  });
})();

export function sample(fn) {
  return SAMPLE_POINTS.map((vars) => fn(vars));
}

// Value of a plain arithmetic expression ('1200*0.9', '22/7*7^2'), or null
// if it does not parse or has a variable (then it is algebra, not a sum).
export function numericValue(src) {
  const tokens = tokenize(String(src).toLowerCase());
  if (!tokens || tokens.some((t) => t.t === 'var')) return null;
  const fn = parse(src);
  if (!fn) return null;
  const v = fn({});
  return Number.isFinite(v) ? v : null;
}
