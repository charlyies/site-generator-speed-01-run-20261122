// Fast drop-in for makefun-site 1.0.0 — an original, dependency-free reimplementation
// of the reference program's exact behaviour (README.md of makefun-site 1.0.0), written
// for speed: a flat-op template VM (no per-node recursion, no per-element scope
// allocation), a single-pass Markdown renderer (no token array, range-based inline
// scanning, no per-character escaping), and cached slugs/dates. No dynamic code
// compilation, no vm module, no WebAssembly, no native addon: plain JavaScript only.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(text);
  if (m === null) return text;
  let out = '';
  let last = 0;
  do {
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  } while ((m = ESC_RE.exec(text)) !== null);
  out += text.slice(last);
  return out;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const NON_ASCII = /[^\x00-\x7F]/;
const TRAILING_DASHES = /-+$/;

/**
 * The slug of `text` (README.md, "Text"), cached per build in B.slugCache.
 * ASCII input skips NFKD normalisation and the combining-mark strip entirely.
 */
function slugify(text, B) {
  const cached = B.slugCache.get(text);
  if (cached !== undefined) return cached;
  let plain = text;
  if (NON_ASCII.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(TRAILING_DASHES, '');
  if (out === '') out = 'untitled';
  B.slugCache.set(text, out);
  return out;
}

/**
 * `slug` made unique against `taken` (and added to it): the first of slug, slug-2,
 * slug-3 ... not taken. `next` remembers where each base left off, so a crowded
 * base never rescans from 2; `taken` stays the authority, so the result is exactly
 * the reference's.
 */
function uniqueSlug(slug, taken, next) {
  if (!taken.has(slug)) {
    taken.add(slug);
    next.set(slug, 2);
    return slug;
  }
  let n = next.get(slug) ?? 2;
  let out;
  do {
    out = `${slug}-${n}`;
    n++;
  } while (taken.has(out));
  taken.add(out);
  next.set(slug, n);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone, cached per build. */
function longDate(date, B) {
  const cached = B.dateCache.get(date);
  if (cached !== undefined) return cached;
  const [y, m, d] = date.split('-');
  const out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  B.dateCache.set(date, out);
  return out;
}

const WS_TAB = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_TAB[c] = 1;

/** The words of a body: its runs of characters other than whitespace (a manual scan: no match array is built). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = WS_TAB[c] === 1;
    else ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. The lines are walked with indexOf, so neither the
 * front matter nor the body is split and rejoined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  const data = {};
  let i = 4;
  let lineNo = 2;
  for (;;) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: nl === -1 ? '' : text.slice(nl + 1) };
    }
    if (!FM_BLANK.test(line) && !line.startsWith('#')) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    i = nl + 1;
    lineNo++;
  }
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** Op kinds of the flat template program. */
const OP_TEXT = 0;
const OP_VAR = 1;
const OP_RAW = 2;
const OP_IF = 3;
const OP_ELSE = 4;
const OP_ENDIF = 5;
const OP_FOR = 6;
const OP_ENDFOR = 7;
const OP_INCLUDE = 8;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/**
 * `src` parsed into a flat program of parallel arrays ({ kind, A, B, C }): jumps
 * replace the reference's nested node tree, so rendering is one loop with an
 * explicit control stack instead of a recursive walk per node and per iteration.
 */
function parseTemplate(name, src) {
  const kind = [];
  const A = [];
  const B = [];
  const C = [];
  const emit = (k, a, b, c) => {
    kind.push(k);
    A.push(a);
    B.push(b);
    C.push(c);
    return kind.length - 1;
  };
  const stack = [];
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') emit(OP_TEXT, tok.text, 0, 0);
    else if (tok.t === 'var') emit(OP_VAR, tok.path, 0, 0);
    else if (tok.t === 'raw') emit(OP_RAW, tok.path, 0, 0);
    else {
      const tag = tok.tag;
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const op = emit(OP_FOR, m[1], pathOf(name, m[2]), 0);
        stack.push({ type: 'for', op });
      } else if ((m = IF.exec(tag)) !== null) {
        const op = emit(OP_IF, pathOf(name, m[2]), m[1] !== undefined ? 1 : 0, 0);
        stack.push({ type: 'if', op, elseOp: -1 });
      } else if (tag === 'else') {
        const top = stack[stack.length - 1];
        if (top === undefined || top.type !== 'if' || top.elseOp !== -1) throw new TemplateError(`template "${name}": an else outside an if`);
        const elseOp = emit(OP_ELSE, 0, 0, 0);
        C[top.op] = elseOp + 1;
        top.elseOp = elseOp;
      } else if (tag === 'endfor' || tag === 'endif') {
        const top = stack[stack.length - 1];
        const want = tag === 'endfor' ? 'for' : 'if';
        if (top === undefined || top.type !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        if (tag === 'endfor') {
          emit(OP_ENDFOR, 0, 0, 0);
          C[top.op] = kind.length;
        } else {
          emit(OP_ENDIF, 0, 0, 0);
          const after = kind.length;
          if (top.elseOp !== -1) C[top.elseOp] = after;
          else C[top.op] = after;
        }
      } else if ((m = INCLUDE.exec(tag)) !== null) emit(OP_INCLUDE, m[1], 0, 0);
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 0) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].type} is not closed`);
  return { kind, A, B, C };
}

/** The value at `path` in the scope stack: its first name from the nearest scope holding it, then own properties. */
function lookup(scopes, path) {
  let s = scopes.length - 1;
  const first = path[0];
  while (s >= 0 && !Object.hasOwn(scopes[s], first)) s--;
  if (s < 0) return undefined;
  let v = scopes[s][first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A compiled template rendered in `rootVars`. One loop over the flat program:
 * a call stack for includes, one loop frame per active `for` (its vars object and
 * `loop` mutated in place per element, never reallocated), scopes as a stack of
 * vars objects. Returns the rendered string.
 */
function renderTemplate(prog, rootVars, templates) {
  const out = [];
  const calls = [];
  const loops = [];
  const scopes = [rootVars];
  let kind = prog.kind;
  let A = prog.A;
  let B = prog.B;
  let C = prog.C;
  let pc = 0;
  let depth = 0;
  for (;;) {
    if (pc >= kind.length) {
      if (calls.length === 0) break;
      const fr = calls.pop();
      kind = fr.kind;
      A = fr.A;
      B = fr.B;
      C = fr.C;
      pc = fr.pc;
      depth = fr.depth;
      continue;
    }
    const op = kind[pc];
    if (op === OP_TEXT) {
      out.push(A[pc]);
      pc++;
    } else if (op === OP_VAR) {
      out.push(escapeHtml(textOf(lookup(scopes, A[pc]))));
      pc++;
    } else if (op === OP_RAW) {
      out.push(textOf(lookup(scopes, A[pc])));
      pc++;
    } else if (op === OP_IF) {
      const v = truthy(lookup(scopes, A[pc]));
      pc = v !== (B[pc] === 1) ? pc + 1 : C[pc];
    } else if (op === OP_ELSE) {
      pc = C[pc];
    } else if (op === OP_ENDIF) {
      pc++;
    } else if (op === OP_FOR) {
      const xs = lookup(scopes, B[pc]);
      if (!Array.isArray(xs) || xs.length === 0) {
        pc = C[pc];
      } else {
        const vars = {};
        vars[A[pc]] = xs[0];
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        vars.loop = loop;
        loops.push({ xs, i: 0, end: C[pc], body: pc + 1, name: A[pc], vars, loop });
        scopes.push(vars);
        pc++;
      }
    } else if (op === OP_ENDFOR) {
      const f = loops[loops.length - 1];
      f.i++;
      if (f.i < f.xs.length) {
        f.vars[f.name] = f.xs[f.i];
        f.loop.index = f.i + 1;
        f.loop.first = false;
        f.loop.last = f.i === f.xs.length - 1;
        pc = f.body;
      } else {
        loops.pop();
        scopes.pop();
        pc++;
      }
    } else {
      // OP_INCLUDE
      const t = templates.get(A[pc]);
      pc++;
      if (t !== undefined && depth < INCLUDE_DEPTH) {
        calls.push({ kind, A, B, C, pc, depth });
        kind = t.kind;
        A = t.A;
        B = t.B;
        C = t.C;
        pc = 0;
        depth = depth + 1;
      }
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HAS_WS = /\s/;

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (line === '' || c0 === 32 || c0 === 9) return BLANK.test(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * The first index from `from` (below `hi`) where `s` holds `what` outside a
 * backslash escape, or -1. With no backslash in range this is a plain indexOf.
 */
function findUnescaped(s, what, from, hi) {
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs >= hi) {
    const k = s.indexOf(what, from);
    return k === -1 || k + what.length > hi ? -1 : k;
  }
  let j = from;
  while (j + what.length <= hi) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j += 2;
      continue;
    }
    if (s[j] === what[0] && s.startsWith(what, j)) return j;
    j++;
  }
  return -1;
}

/** The first single * from `from` (below `hi`; one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs >= hi) {
    let j = s.indexOf('*', from);
    while (j !== -1 && j < hi) {
      if (j + 1 < hi && s[j + 1] === '*') {
        j = s.indexOf('*', j + 2);
        continue;
      }
      return j;
    }
    return -1;
  }
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[lo..hi)` rendered inline into `out` (pieces); `link(target)` is a link's
 * href. Literal runs are flushed through one escape per run instead of one
 * escape per character; strong/emphasis/link bodies recurse over ranges, so no
 * substring is taken for them.
 */
/** The inline characters that need handling: structural ones and HTML specials. */
const INLINE_RE = /[\\`*\[&<>"']/g;

/**
 * `s[lo..hi)` rendered inline into `out` (pieces); `link(target)` is a link's
 * href. One native regex scan jumps between interesting characters (structural
 * or HTML-special), so a literal run is already entity-clean when it is
 * flushed: no separate escape pass over it. Strong/emphasis/link bodies
 * recurse over ranges, so no substring is taken for them. (INLINE_RE's
 * lastIndex is set before every exec, so recursion through it is safe.)
 */
function inlineInto(s, lo, hi, link, out) {
  let i = lo;
  let lit = lo;
  while (i < hi) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    const j = m === null || m.index >= hi ? hi : m.index;
    if (j >= hi) {
      if (hi > lit) out.push(s.slice(lit, hi));
      return;
    }
    const c = s.charCodeAt(j);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      // an HTML special inside a literal run: flush up to it, push its entity
      if (j > lit) out.push(s.slice(lit, j));
      out.push(ESCAPES[s[j]]);
      i = j + 1;
      lit = i;
      continue;
    }
    i = j;
    if (c === 92) {
      // backslash
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        if (i > lit) out.push(s.slice(lit, i));
        const n = s[i + 1];
        out.push(n === '>' ? '&gt;' : n);
        i += 2;
        lit = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 96) {
      // backtick: a code span closed by the next backtick, at least one char between
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < hi && k > i + 1) {
        if (i > lit) out.push(s.slice(lit, i));
        out.push('<code>');
        out.push(escapeHtml(s.slice(i + 1, k)));
        out.push('</code>');
        i = k + 1;
        lit = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      // asterisk: strong, then emphasis
      if (i + 1 < hi && s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, hi);
        if (k !== -1 && k > i + 2) {
          if (i > lit) out.push(s.slice(lit, i));
          out.push('<strong>');
          inlineInto(s, i + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
          lit = i;
        } else {
          // a failed ** stays literal: keep it in the run
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1, hi);
        if (k !== -1 && k > i + 1) {
          if (i > lit) out.push(s.slice(lit, i));
          out.push('<em>');
          inlineInto(s, i + 1, k, link, out);
          out.push('</em>');
          i = k + 1;
          lit = i;
        } else {
          i++;
        }
      }
      continue;
    }
    // [text](target)
    const k = findUnescaped(s, ']', i + 1, hi);
    let m2 = -1;
    if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
      m2 = s.indexOf(')', k + 2);
      if (m2 >= hi) m2 = -1;
    }
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !HAS_WS.test(target)) {
      if (i > lit) out.push(s.slice(lit, i));
      out.push('<a href="');
      out.push(escapeHtml(link(target)));
      out.push('">');
      inlineInto(s, i + 1, k, link, out);
      out.push('</a>');
      i = m2 + 1;
      lit = i;
    } else {
      i++;
    }
  }
  if (hi > lit) out.push(s.slice(lit, hi));
}

/** Inline `text` rendered (a fresh pieces array, joined). */
function inline(text, link) {
  const out = [];
  inlineInto(text, 0, text.length, link, out);
  return out.join('');
}

/**
 * `src` rendered in one pass over its lines (no token array): its HTML (each block
 * on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, B) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const idNext = new Map();
  let i = 0;
  // A list starting at `start`, rendered; returns its HTML and the next line index.
  const listHtml = (start, isOrdered, firstNum) => {
    const marker = isOrdered ? ORDERED : BULLET;
    const items = [];
    let j = start;
    while (j < n) {
      const m = marker.exec(lines[j]);
      if (m !== null) {
        items.push([trimLine(isOrdered ? m[2] : m[1])]);
        j++;
      } else if (CONTINUED.test(lines[j])) {
        items[items.length - 1].push(trimLine(lines[j]));
        j++;
      } else break;
    }
    const tag = isOrdered ? 'ol' : 'ul';
    const open = isOrdered && firstNum !== 1 ? `<ol start="${firstNum}">` : `<${tag}>`;
    let itemsHtml = '';
    for (const parts of items) {
      const text = parts.length === 1 ? parts[0] : parts.join('\n');
      itemsHtml += `<li>${inline(text, link)}</li>\n`;
    }
    return { html: `${open}\n${itemsHtml}</${tag}>`, next: j };
  };
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // Dispatch on the first character: no block regex can match a line whose
    // first character its pattern does not start with.
    if (line === '' || c0 === 32 || c0 === 9) {
      if (BLANK.test(line)) {
        i++;
        continue;
      }
      // an indented, non-blank line can only start a paragraph
    } else if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !(lines[i].charCodeAt(0) === 96 && FENCE_CLOSE.test(lines[i]))) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        let code = '';
        for (let k = 0; k < body.length; k++) {
          code += escapeHtml(body[k]);
          code += '\n';
        }
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, B), ids, idNext);
        const html = inline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        const r = listHtml(i, false, 1);
        blocks.push(r.html);
        i = r.next;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(trimLine(lines[i++].replace(/^> ?/, '')));
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        const r = listHtml(i, true, Number(ordered[1]));
        blocks.push(r.html);
        i = r.next;
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.length === 1 ? body[0] : body.join('\n');
    const html = inline(text, link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A link target resolved for the source at `srcPath` in directory `dir`. */
function resolveLink(B, dir, srcPath, target) {
  if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null && B.bySource.has(path)) return `${B.bySource.get(path).url}${frag}`;
  if (path !== null && B.staticPaths.has(path)) return `${B.base}/${path}${frag}`;
  B.broken.add(`broken-link ${srcPath} -> ${target}`);
  return target;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const B = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    sources: [],
    statics: [],
    bySource: new Map(),
    staticPaths: null,
    broken: new Set(),
    report: [],
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache: new Map(),
    dateCache: new Map(),
  };

  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      B.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      B.report.push(err.message);
    }
  }

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) B.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else B.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of B.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      B.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      B.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      B.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!B.templates.has(layout)) {
      B.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      B.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  B.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let rec = taken.get(dir);
    if (rec === undefined) {
      rec = { set: new Set(dir === '' ? RESERVED : []), next: new Map() };
      taken.set(dir, rec);
    }
    return rec;
  };
  for (const s of B.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const rec = takenIn(dir);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, B), rec.set, rec.next);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${B.base}/${s.outDir}/`;
    B.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  B.staticPaths = new Set(B.statics.map((f) => f.path));
  for (const s of B.sources) {
    const dir = dirOf(s.path);
    const link = (target) => resolveLink(B, dir, s.path, target);
    const md = renderMarkdown(s.body, link, B);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = B.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  B.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, B);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${B.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of B.sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  B.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages as templates read them; each card computed once and reused.
  // A card's tags are the tag records themselves and a page's toc its heading
  // records: the generator's templates read only name/slug/url (tags) and
  // level/id/html (toc) from them, so no remapping is needed.
  const linkOf = (s) => (s === null ? null : s.link);
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, B),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs,
  });
  for (const s of B.sources) s.card = cardOf(s);
  B.cards = new Map(posts.map((p) => [p, p.card]));
  for (const p of posts) {
    p.link = { title: p.data.title, url: p.url, date: p.data.date ?? '', date_long: p.data.date === undefined ? '' : longDate(p.data.date, B) };
  }
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: B.base };
  const allTags = B.tags;
  for (const t of allTags) t.count = t.posts.length;
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const prog = B.templates.get(name);
    return prog === undefined ? null : renderTemplate(prog, { site, tags: allTags, recent, ...vars }, B.templates);
  };
  for (const s of B.sources) B.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${B.base}/` : `${B.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) B.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of B.tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) B.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) B.output['tags/index.html'] = tagsHtml;
  for (const f of B.statics) {
    if (Object.hasOwn(B.output, f.path)) B.report.push(`shadowed ${f.path}: a built page has its path`);
    else B.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...B.report, ...B.broken].sort(byCodeUnits);
  const pageCount = B.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${B.tags.length} tags and ${B.statics.length} static files`);
  B.output['build-report.txt'] = `${lines.join('\n')}\n`;
  return B.output;
}
