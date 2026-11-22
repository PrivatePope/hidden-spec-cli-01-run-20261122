// mend: one CLI that applies AI-written edits, in four formats, to a tree of text files.
//
// The patch is read as SPEC.md says (unified diff, SEARCH/REPLACE, V4A, JSON tool
// calls); every edit either applies cleanly or is reported, and when any edit
// fails nothing is written. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this
// file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** Shared state for one run: strict matching, and the moves that succeeded. */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` off each, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** UTF-8 byte order, for sorting output rows. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file as lines: its break, its lines, and whether it ends with a break. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function splitDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Section 4: which format an auto patch is, or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

/** Lines equal at a tier: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Occurrences of O in the file's lines, at the first tier where one exists. */
function findOccurrences(fileLines: string[], oldLines: string[], strict: boolean): { tier: number; positions: number[] } {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos: number[] = [];
    for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
      let ok = true;
      for (let k = 0; k < oldLines.length; k++) {
        if (!tierEq(fileLines[i + k]!, oldLines[k]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return { tier: -1, positions: [] };
}

/** One line of a replacement: its text, and whether it is a context line (with its index in O). */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * The lines that replace a matched run: context lines are the file's own matched
 * lines; at tier 2 the other lines are re-indented from O's first line to the
 * file's first matched line; otherwise they are written as they are.
 */
function buildReplacement(fileLines: string[], at: number, oldLines: string[], newLines: NewLine[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2) {
    const f = leadWs(fileLines[at] ?? '');
    const p = leadWs(oldLines[0] ?? '');
    for (const nl of newLines) {
      if (nl.ctx) {
        out.push(fileLines[at + nl.oIdx]!);
      } else if (nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) {
        out.push(f + nl.text.slice(p.length));
      } else {
        out.push(nl.text);
      }
    }
  } else {
    for (const nl of newLines) {
      out.push(nl.ctx ? fileLines[at + nl.oIdx]! : nl.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const doc = splitDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines.slice(0, line), ...add, ...doc.lines.slice(line)];
      tree.now.set(p, joinDoc({ lines, br: doc.br, final: doc.final }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

/** One body line of a hunk or chunk: context, old, new, or a `\` line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
}

function classifyBodyLine(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'old', text: line.slice(1) };
  if (c === '+') return { kind: 'new', text: line.slice(1) };
  return { kind: 'back', text: line.slice(1) };
}

/** One hunk: its old start, and its old and new lines. */
interface Hunk {
  a: number;
  oldLines: string[];
  newLines: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLastOut: boolean;
  /** A `\` line follows the hunk's last `+` line; false when it has no `+` line. */
  backslashAfterLastPlus: boolean;
}

function buildHunk(a: number, body: BodyLine[]): Hunk {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      oldLines.push(b.text);
      newLines.push({ text: b.text, ctx: true, oIdx: oldLines.length - 1 });
    } else if (b.kind === 'old') {
      oldLines.push(b.text);
    } else if (b.kind === 'new') {
      newLines.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  // Whether a `\` line follows the body's last line of one of these kinds.
  const followedByBackslash = (kinds: Array<'ctx' | 'new'>): boolean => {
    for (let i = body.length - 1; i >= 0; i--) {
      if (kinds.includes(body[i]!.kind)) return i + 1 < body.length && body[i + 1]!.kind === 'back';
    }
    return false;
  };
  return { a, oldLines, newLines, backslashAfterLastOut: followedByBackslash(['ctx', 'new']), backslashAfterLastPlus: followedByBackslash(['new']) };
}

/** Apply one hunk to a document, d being the drift from hunks applied so far. */
function applyHunk(doc: Doc, h: Hunk, d: number, strict: boolean, path: string): Doc {
  if (h.oldLines.length === 0) {
    const at = Math.min(h.a + d, doc.lines.length);
    const lines = [...doc.lines.slice(0, at), ...h.newLines.map((n) => n.text), ...doc.lines.slice(at)];
    const final = at === doc.lines.length ? !h.backslashAfterLastOut : doc.final;
    return { lines, br: doc.br, final };
  }
  const found = findOccurrences(doc.lines, h.oldLines, strict);
  if (found.positions.length === 0) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.positions[0]!;
  for (const pos of found.positions) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const repl = buildReplacement(doc.lines, best, h.oldLines, h.newLines, found.tier);
  const lines = [...doc.lines.slice(0, best), ...repl, ...doc.lines.slice(best + h.oldLines.length)];
  const final = best + h.oldLines.length === doc.lines.length ? !h.backslashAfterLastOut : doc.final;
  return { lines, br: doc.br, final };
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, spaces off. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return trimBoth(tab >= 0 ? rest.slice(0, tab) : rest);
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** `diff --git a/<X> b/<Y>`, or null when the line is not of that form. */
function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) return null;
  const x = rest.slice(2, idx);
  const y = trimTrail(rest.slice(idx + 3));
  if (x === '' || y === '') return null;
  return [x, y];
}

interface SectionEdit {
  edit: Edit;
  next: number;
}

/** Parse one unified section starting at `start`; returns its edit and where it ended. */
function parseUnifiedSection(lines: string[], start: number, ctx: Ctx): SectionEdit {
  let i = start;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renOld: string | null = null;
  let renNew: string | null = null;
  let isCreate = false;
  let isDelete = false;
  if (lines[i]!.startsWith('diff --git ')) {
    const parsed = parseDiffGit(lines[i]!);
    if (parsed === null) throw new Exit2(`error: parse ${i + 1}`);
    diffOld = parsed[0];
    diffNew = parsed[1];
    i += 1;
  } else {
    pairOld = stripAB(headerPath(lines[i]!));
    pairNew = stripAB(headerPath(lines[i + 1]!));
    i += 2;
  }
  // The header: lines before the first hunk.
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
      if (pairOld !== null) break;
      pairOld = stripAB(headerPath(l));
      pairNew = stripAB(headerPath(lines[j + 1]!));
      j += 2;
      continue;
    }
    if (l.startsWith('--- ')) throw new Exit2(`error: parse ${j + 2}`);
    if (l.startsWith('rename from ')) {
      renOld = trimBoth(l.slice('rename from '.length));
      j += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renNew = trimBoth(l.slice('rename to '.length));
      j += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      isCreate = true;
      j += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      isDelete = true;
      j += 1;
      continue;
    }
    j += 1;
  }
  // The hunks.
  const hunks: Hunk[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (!l.startsWith('@@')) {
      j += 1;
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m === null) throw new Exit2(`error: parse ${j + 1}`);
    const a = parseInt(m[1]!, 10);
    j += 1;
    const body: BodyLine[] = [];
    while (j < lines.length) {
      const bl = lines[j]!;
      if (bl.startsWith('diff --git ')) break;
      if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
        body.push(classifyBodyLine(bl));
        j += 1;
      } else {
        break;
      }
    }
    while (body.length > 0) {
      const lastB = body[body.length - 1]!;
      if (lastB.kind === 'ctx' && lastB.text === '') body.pop();
      else break;
    }
    hunks.push(buildHunk(a, body));
  }
  // What the section names.
  const oldRaw = pairOld !== null ? pairOld : renOld !== null ? renOld : diffOld;
  const newRaw = pairNew !== null ? pairNew : renNew !== null ? renNew : diffNew;
  const oldPath = oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === '/dev/null' ? null : newRaw;
  const create = isCreate || oldPath === null;
  const del = !create && (isDelete || newPath === null);
  const edit: Edit = (tree) => {
    if (oldPath !== null && !safePath(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && newPath !== oldPath && !safePath(newPath)) throw new Fail('unsafe', newPath);
    if (create) {
      if (newPath === null) throw new Fail('missing', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of hunks) {
        for (const b of h.newLines) {
          if (!b.ctx) plus.push(b.text);
        }
      }
      // A created file ends with a line break unless a `\` line follows its last `+` line.
      let noBreak = false;
      for (let hi = hunks.length - 1; hi >= 0; hi--) {
        if (hunks[hi]!.newLines.some((b) => !b.ctx)) {
          noBreak = hunks[hi]!.backslashAfterLastPlus;
          break;
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (del) {
      if (oldPath === null) throw new Fail('missing', '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const before = tree.get(oldPath!);
    if (before === null) throw new Fail('missing', oldPath!);
    if (newPath !== oldPath && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    let doc = splitDoc(before);
    let d = 0;
    for (const h of hunks) {
      doc = applyHunk(doc, h, d, ctx.strict, oldPath!);
      d += h.newLines.length - h.oldLines.length;
    }
    const out = joinDoc(doc);
    if (newPath !== oldPath) {
      tree.now.set(oldPath!, null);
      tree.now.set(newPath!, out);
      ctx.moves.push([oldPath!, newPath!]);
    } else {
      tree.now.set(oldPath!, out);
    }
  };
  return { edit, next: j };
}

function parseUnified(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      const r = parseUnifiedSection(lines, i, ctx);
      edits.push(r.edit);
      i = r.next;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function makeSrEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const nl: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = splitDoc(cur);
    const found = findOccurrences(doc.lines, oldLines, strict);
    if (found.positions.length === 0) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    const repl = buildReplacement(doc.lines, at, oldLines, nl, found.tier);
    const lines = [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinDoc({ lines, br: doc.br, final: doc.final }));
  };
}

function parseSearchReplace(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(makeSrEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), ctx.strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

/** One V4A chunk: its anchor (null: none), its lines, and whether it ends the file. */
interface Chunk {
  anchor: string | null;
  oldLines: string[];
  newLines: NewLine[];
  eof: boolean;
}

function buildChunk(anchor: string | null, body: BodyLine[], eof: boolean): Chunk {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      oldLines.push(b.text);
      newLines.push({ text: b.text, ctx: true, oIdx: oldLines.length - 1 });
    } else if (b.kind === 'old') {
      oldLines.push(b.text);
    } else if (b.kind === 'new') {
      newLines.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { anchor, oldLines, newLines, eof };
}

function isV4aHeader(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

/** First line at or after `from` equal to `anchor` at the first tier with one, else -1. */
function findAnchorLine(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = from; j < fileLines.length; j++) {
      if (tierEq(fileLines[j]!, anchor, t)) return j;
    }
  }
  return -1;
}

function applyV4aChunks(text: string, chunks: Chunk[], strict: boolean, path: string): string {
  let doc = splitDoc(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const at = findAnchorLine(doc.lines, ch.anchor, cursor, strict);
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    if (ch.oldLines.length === 0) {
      const at = ch.eof ? doc.lines.length : cursor;
      const lines = [...doc.lines.slice(0, at), ...ch.newLines.map((n) => n.text), ...doc.lines.slice(at)];
      doc = { lines, br: doc.br, final: doc.final };
      cursor = at + ch.newLines.length;
      continue;
    }
    const tiers = strict ? [0] : [0, 1, 2];
    let hit: { tier: number; pos: number } | null = null;
    for (const t of tiers) {
      for (let i = cursor; i + ch.oldLines.length <= doc.lines.length; i++) {
        if (ch.eof && i + ch.oldLines.length !== doc.lines.length) continue;
        let ok = true;
        for (let k = 0; k < ch.oldLines.length; k++) {
          if (!tierEq(doc.lines[i + k]!, ch.oldLines[k]!, t)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          hit = { tier: t, pos: i };
          break;
        }
      }
      if (hit !== null) break;
    }
    if (hit === null) throw new Fail('no-match', path);
    const repl = buildReplacement(doc.lines, hit.pos, ch.oldLines, ch.newLines, hit.tier);
    const lines = [...doc.lines.slice(0, hit.pos), ...repl, ...doc.lines.slice(hit.pos + ch.oldLines.length)];
    doc = { lines, br: doc.br, final: doc.final };
    cursor = hit.pos + repl.length;
  }
  return joinDoc(doc);
}

function parseV4a(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const end = last;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < end) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = trimBoth(l.slice('*** Add File: '.length));
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = trimBoth(l.slice('*** Delete File: '.length));
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = trimBoth(l.slice('*** Update File: '.length));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i;
    i += 1;
    if (kind === 'add') {
      const start = i;
      while (i < end && !isV4aHeader(lines[i]!)) i += 1;
      let stop = i;
      while (stop > start && blank(lines[stop - 1]!)) stop -= 1;
      const fileLines: string[] = [];
      for (let k = start; k < stop; k++) {
        const raw = lines[k]!;
        if (raw === '') fileLines.push('');
        else if (raw.startsWith('+')) fileLines.push(raw.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      const content = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!safePath(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content);
      });
      continue;
    }
    if (kind === 'delete') {
      while (i < end && blank(lines[i]!)) i += 1;
      if (i < end && !isV4aHeader(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safePath(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    // Update File.
    let moveTo: string | null = null;
    if (i < end && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = trimBoth(lines[i]!.slice('*** Move to: '.length));
      i += 1;
    }
    const secStart = i;
    while (i < end && !isV4aHeader(lines[i]!)) i += 1;
    let secEnd = i;
    while (secEnd > secStart && blank(lines[secEnd - 1]!)) secEnd -= 1;
    const chunks: Chunk[] = [];
    let k = secStart;
    let firstChunk = true;
    while (k < secEnd) {
      let anchor: string | null = null;
      const l2 = lines[k]!;
      if (l2.startsWith('@@')) {
        // The text after `@@` is the anchor; an empty text is no anchor.
        anchor = trimBoth(l2.slice(2)) || null;
        k += 1;
      } else if (!firstChunk) {
        throw new Exit2(`error: parse ${k + 1}`);
      }
      const body: BodyLine[] = [];
      while (k < secEnd) {
        const bl = lines[k]!;
        if (bl.startsWith('@@') || bl === '*** End of File') break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          body.push(classifyBodyLine(bl));
          k += 1;
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }
      let eof = false;
      if (k < secEnd && lines[k] === '*** End of File') {
        eof = true;
        k += 1;
      }
      chunks.push(buildChunk(anchor, body, eof));
      firstChunk = false;
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine + 1}`);
    edits.push((tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const out = applyV4aChunks(before, chunks, ctx.strict, path);
      if (moveTo !== null) {
        tree.now.set(path, null);
        tree.now.set(moveTo, out);
        ctx.moves.push([path, moveTo]);
      } else {
        tree.now.set(path, out);
      }
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1, 2, 10: the command line, the output, and the all-or-nothing write.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? parseJson(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, ctx)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, ctx)
            : parseV4a(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of ctx.moves) {
    if (tree.original(oldP) !== null && finalOf(oldP) === null && tree.original(newP) === null && finalOf(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    const changed = [...tree.now.keys()].sort(byteCompare).filter((p) => tree.original(p) !== tree.now.get(p));
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      try {
        if (statSync(p).isDirectory()) rmSync(p);
      } catch {
        // Not a directory, or not there: writing proceeds.
      }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
