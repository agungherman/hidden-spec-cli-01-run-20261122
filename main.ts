// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// the V4A patch format, or JSON tool calls) and applies its edits to the tree
// rooted at the working directory, all or nothing. The contract is SPEC.md
// in this repository. Node 22, standard library only.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// PATCH is a path, or "-" / absent for standard input.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch that cannot be read at all: exit 2 with one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that cannot be applied: exit 1, one line per failure. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A patch's lines: split at \n, one trailing \r removed, no empty tail piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and
 *  none of its segments is empty, "." or "..". */
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file broken into lines, its line break, and whether it ends with one. */
interface FileParts {
  lines: string[];
  br: string;
  ends: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const body = ends ? text.slice(0, -br.length) : text;
  return { lines: body.split(br), br, ends };
}

function joinParts(parts: FileParts): string {
  if (parts.lines.length === 0) return '';
  return parts.lines.join(parts.br) + (parts.ends ? parts.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null means deleted),
 *  everything else read from disk and remembered in `orig`. */
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

/** Matching lines, SPEC section 5: three tiers, first tier that occurs wins. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every 0-based position where O occurs in lines at this tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in lines, or -1 when it occurs at none. */
function firstTier(lines: string[], o: string[], strict: boolean): number {
  for (const t of tiersToTry(strict)) {
    if (occurrences(lines, o, t).length > 0) return t;
  }
  return -1;
}

/** The replacement lines for a match at pos. Context lines (ctx maps a line of
 *  N to its line of O) are written as the file's own matched lines. At tier 2
 *  every other non-blank line of N is re-indented: the leading whitespace P of
 *  O's first line is replaced by F, the file's first matched line's own. */
function buildNew(
  fileLines: string[],
  pos: number,
  o: string[],
  n: string[],
  ctx: Map<number, number>,
  tier: number,
): string[] {
  const f = leadingWS(fileLines[pos] ?? '');
  const p = leadingWS(o[0] ?? '');
  return n.map((ln, i) => {
    const oi = ctx.get(i);
    if (oi !== undefined) return fileLines[pos + oi]!;
    if (tier === 2 && ln.trim() !== '' && ln.startsWith(p)) return f + ln.slice(p.length);
    return ln;
  });
}

/** One JSON edit object, SPEC section 9, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const crlf = fileParts(before).br === '\r\n';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const parts = fileParts(before);
      if (at < 0 || at > parts.lines.length) throw new Fail('no-match', p);
      parts.lines.splice(at, 0, ...add);
      tree.now.set(p, joinParts(parts));
    };
  }
  return null;
}

/** The JSON patch: one array of edit objects, or one edit object per line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
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

/** A unified hunk: O is its context and "-" lines, N its context and "+"
 *  lines, ctx maps each context line of N to its line of O, plus holds only
 *  the "+" lines (what a created file is made of). slashAfterLast says a "\"
 *  line follows the hunk's last context or "+" line; slashAfterPlus says one
 *  follows its last "+" line. */
interface Hunk {
  a: number;
  o: string[];
  n: string[];
  plus: string[];
  ctx: Map<number, number>;
  slashAfterLast: boolean;
  slashAfterPlus: boolean;
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: string[] = [];
  const plus: string[] = [];
  const ctx = new Map<number, number>();
  let lastCp = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCp = i;
    if (l.startsWith('+')) lastPlus = i;
  }
  const slashAfter = (at: number): boolean =>
    at >= 0 && at + 1 < body.length && body[at + 1]!.startsWith('\\');
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      ctx.set(n.length, o.length);
      o.push(l === '' ? '' : l.slice(1));
      n.push(l === '' ? '' : l.slice(1));
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push(l.slice(1));
      plus.push(l.slice(1));
    }
  }
  return {
    a,
    o,
    n,
    plus,
    ctx,
    slashAfterLast: slashAfter(lastCp),
    slashAfterPlus: slashAfter(lastPlus),
  };
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  pairSeen: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A path from a "--- "/"+++ " header line: text after the four characters,
 *  up to the first tab, spaces trimmed, a leading a/ or b/ removed. */
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

/** The two paths of a "diff --git a/<X> b/<Y>" line, or null when malformed. */
function diffPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

/** The unified patch, SPEC section 6: sections, headers, hunks. */
function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections: UniSection[] = [];
  const fresh = (): UniSection => ({
    diffOld: null,
    diffNew: null,
    headOld: null,
    headNew: null,
    pairSeen: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const d = diffPaths(line);
      if (d === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = d[0];
      cur.diffNew = d[1];
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          body.push(l);
          j++;
        } else break;
      }
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      cur.hunks.push(buildHunk(Number(m[1]), body));
      inHeader = false;
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nxt = lines[i + 1] ?? '';
      if (nxt.startsWith('+++ ')) {
        if (cur !== null && inHeader) {
          cur.headOld = headerPath(line.slice(4));
          cur.headNew = headerPath(nxt.slice(4));
          cur.pairSeen = true;
        } else {
          cur = fresh();
          cur.headOld = headerPath(line.slice(4));
          cur.headNew = headerPath(nxt.slice(4));
          cur.pairSeen = true;
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict, moves));
}

/** Apply a section's hunks in order to a file's text. d is the running total
 *  of (N length minus O length) of the hunks applied so far in the section. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = fileParts(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const tier = firstTier(parts.lines, h.o, strict);
      if (tier < 0) throw new Fail('no-match', path);
      const occ = occurrences(parts.lines, h.o, tier);
      const target = h.a - 1 + d;
      let best = occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + h.o.length === parts.lines.length;
      const nw = buildNew(parts.lines, best, h.o, h.n, h.ctx, tier);
      parts.lines.splice(best, h.o.length, ...nw);
      if (atEnd) parts.ends = !h.slashAfterLast;
    } else {
      const at = Math.min(h.a + d, parts.lines.length);
      const atEnd = at === parts.lines.length;
      parts.lines.splice(at, 0, ...h.n);
      if (atEnd) parts.ends = !h.slashAfterLast;
    }
    d += h.n.length - h.o.length;
  }
  return joinParts(parts);
}

/** One unified section is one edit: create, delete, move, or change. */
function unifiedEdit(s: UniSection, strict: boolean, moves: [string, string][]): Edit {
  const old = s.pairSeen ? s.headOld : (s.renameFrom ?? s.diffOld);
  const nw = s.pairSeen ? s.headNew : (s.renameTo ?? s.diffNew);
  if (old === null || s.newFile) {
    const np = nw ?? '';
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) plus.push(...h.plus);
      let slash = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        if (s.hunks[k]!.plus.length > 0) {
          slash = s.hunks[k]!.slashAfterPlus;
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (slash ? '' : '\n'));
    };
  }
  if (nw === null || s.deletedFile) {
    const op = old;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (old !== nw) {
    return (tree) => {
      if (!safe(old)) throw new Fail('unsafe', old);
      if (!safe(nw)) throw new Fail('unsafe', nw);
      const cur = tree.get(old);
      if (cur === null) throw new Fail('missing', old);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const out = applyHunks(cur, s.hunks, strict, old);
      tree.now.set(old, null);
      tree.now.set(nw, out);
      moves.push([old, nw]);
    };
  }
  return (tree) => {
    if (!safe(old)) throw new Fail('unsafe', old);
    const cur = tree.get(old);
    if (cur === null) throw new Fail('missing', old);
    tree.now.set(old, applyHunks(cur, s.hunks, strict, old));
  };
}

/** One SEARCH/REPLACE block, SPEC section 7. */
function srEdit(p: string, o: string[], n: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (o.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const parts = fileParts(cur);
    const tier = firstTier(parts.lines, o, strict);
    if (tier < 0) throw new Fail('no-match', p);
    const occ = occurrences(parts.lines, o, tier);
    if (occ.length > 1) throw new Fail('ambiguous', p);
    const pos = occ[0]!;
    const nw = buildNew(parts.lines, pos, o, n, new Map(), tier);
    parts.lines.splice(pos, o.length, ...nw);
    tree.now.set(p, joinParts(parts));
  };
}

/** The SEARCH/REPLACE patch: one edit per block, in order. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let after = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let p: string | null = null;
    for (let j = s - 1; j >= after; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      p = l.trim();
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') break;
      if (t === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(p, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = p;
    after = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** A V4A chunk: an anchor line (null when none), whether it is anchored to
 *  the end of the file, and its body lines as the patch wrote them. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aAdd(p: string, fl: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
  };
}

function v4aDelete(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

/** One V4A Update section: its chunks apply in order, the cursor starting at
 *  line 0 and moving to just after the lines each chunk wrote. */
function v4aUpdate(
  p: string,
  moveTo: string | null,
  chunks: VChunk[],
  strict: boolean,
  moves: [string, string][],
): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = fileParts(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiersToTry(strict)) {
          for (let k = cursor; k < parts.lines.length; k++) {
            if (lineEq(parts.lines[k]!, ch.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const o: string[] = [];
      const n: string[] = [];
      const ctx = new Map<number, number>();
      for (const l of ch.body) {
        if (l === '' || l.startsWith(' ')) {
          ctx.set(n.length, o.length);
          o.push(l === '' ? '' : l.slice(1));
          n.push(l === '' ? '' : l.slice(1));
        } else if (l.startsWith('-')) {
          o.push(l.slice(1));
        } else if (l.startsWith('+')) {
          n.push(l.slice(1));
        }
      }
      if (o.length > 0) {
        let tier = -1;
        let pos = -1;
        if (ch.eof) {
          const endPos = parts.lines.length - o.length;
          if (endPos >= cursor) {
            for (const t of tiersToTry(strict)) {
              let ok = true;
              for (let j = 0; j < o.length; j++) {
                if (!lineEq(parts.lines[endPos + j]!, o[j]!, t)) {
                  ok = false;
                  break;
                }
              }
              if (ok) {
                tier = t;
                pos = endPos;
                break;
              }
            }
          }
        } else {
          for (const t of tiersToTry(strict)) {
            const occ = occurrences(parts.lines, o, t).filter((x) => x >= cursor);
            if (occ.length > 0) {
              tier = t;
              pos = occ[0]!;
              break;
            }
          }
        }
        if (tier < 0) throw new Fail('no-match', p);
        const nw = buildNew(parts.lines, pos, o, n, ctx, tier);
        parts.lines.splice(pos, o.length, ...nw);
        cursor = pos + nw.length;
      } else {
        const at = ch.eof ? parts.lines.length : cursor;
        parts.lines.splice(at, 0, ...n);
        cursor = at + n.length;
      }
    }
    const out = joinParts(parts);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      moves.push([p, moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

/** The V4A patch, SPEC section 8: Begin/End Patch, then one edit per section. */
function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    if (kind === 'add') {
      const raw: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          raw.push(l);
          i++;
        } else if (l === '') {
          raw.push(l);
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      edits.push(v4aAdd(path, raw.map((r) => (r.startsWith('+') ? r.slice(1) : ''))));
      continue;
    }
    if (kind === 'delete') {
      edits.push(v4aDelete(path));
      continue;
    }
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    const chunks: VChunk[] = [];
    let curChunk: VChunk | null = null;
    let haveChunk = false;
    while (i < last) {
      const l = lines[i]!;
      if (isSectionStart(l)) break;
      if (l.startsWith('@@')) {
        const anchor = l.slice(2).trim();
        curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        chunks.push(curChunk);
        haveChunk = true;
        i++;
        continue;
      }
      if (l === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
        curChunk.eof = true;
        curChunk = null;
        i++;
        continue;
      }
      if (l === '' && curChunk === null && haveChunk) {
        // A blank line after a chunk closed by "*** End of File": a blank
        // line at the end of the section, not part of any chunk.
        i++;
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (curChunk === null) {
          if (haveChunk) throw new Exit2(`error: parse ${i + 1}`);
          curChunk = { anchor: null, eof: false, body: [] };
          chunks.push(curChunk);
          haveChunk = true;
        }
        curChunk.body.push(l);
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Blank lines at the end of the section are not part of it — but only
    // for a chunk still open when the section ends. A chunk closed by
    // "*** End of File" keeps its trailing blank body lines: they are part
    // of the old lines that must end at the file's last line.
    if (curChunk !== null && chunks.length > 0) {
      const b = chunks[chunks.length - 1]!.body;
      while (b.length > 0 && blank(b[b.length - 1]!)) b.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
    edits.push(v4aUpdate(path, moveTo, chunks, strict, moves));
  }
  return edits;
}

/** Detect the patch's format, SPEC section 4. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
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
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rowByKey = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowByKey.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [old, nw] of moves) {
    if (
      tree.original(old) !== null &&
      tree.get(old) === null &&
      tree.original(nw) === null &&
      tree.get(nw) !== null
    ) {
      rowByKey.delete(old);
      rowByKey.delete(nw);
      rowByKey.set(nw, `R ${old} -> ${nw}`);
    }
  }
  const keys = [...rowByKey.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows = keys.map((k) => rowByKey.get(k)!);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
