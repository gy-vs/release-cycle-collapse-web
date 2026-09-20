// Minimal semver support for the impact solver: versions, bump levels and
// ranges represented as unions of [lo, hi) intervals so that ranges can be
// intersected (needed for conflict detection) and tested for membership.

export type BumpLevel = 'none' | 'patch' | 'minor' | 'major';

export const BUMP_RANK: Record<BumpLevel, number> = {none: 0, patch: 1, minor: 2, major: 3};

export function maxBump(a: BumpLevel, b: BumpLevel): BumpLevel {
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

export type Version = readonly [number, number, number];

export function parseVersion(text: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function formatVersion(version: Version): string {
  return version.join('.');
}

export function compareVersions(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function bumpVersion(version: Version, level: BumpLevel): Version {
  switch (level) {
    case 'major':
      return [version[0] + 1, 0, 0];
    case 'minor':
      return [version[0], version[1] + 1, 0];
    case 'patch':
      return [version[0], version[1], version[2] + 1];
    default:
      return version;
  }
}

// An interval over versions: lo is inclusive (null = unbounded below), hi is
// exclusive (null = unbounded above). A range is a union of intervals.
export interface Interval {
  lo: Version | null;
  hi: Version | null;
}

export type RangeSet = Interval[];

function intervalContains(interval: Interval, version: Version): boolean {
  if (interval.lo && compareVersions(version, interval.lo) < 0) return false;
  if (interval.hi && compareVersions(version, interval.hi) >= 0) return false;
  return true;
}

function intersectIntervals(a: Interval, b: Interval): Interval {
  let lo = a.lo;
  if (!lo || (b.lo && compareVersions(b.lo, lo) > 0)) lo = b.lo;
  let hi = a.hi;
  if (!hi || (b.hi && compareVersions(b.hi, hi) < 0)) hi = b.hi;
  return {lo, hi};
}

function isEmptyInterval(interval: Interval): boolean {
  return Boolean(interval.lo && interval.hi && compareVersions(interval.lo, interval.hi) >= 0);
}

// A partial version such as "1", "1.2" or "1.2.x": only the specified parts.
function parsePartial(text: string): number[] | null {
  const parts: number[] = [];
  for (const token of text.split('.')) {
    if (token === '*' || token.toLowerCase() === 'x') break;
    if (!/^\d+$/.test(token)) return null;
    parts.push(Number(token));
  }
  return parts.length > 0 ? parts : null;
}

function lowerBound(parts: number[]): Version {
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

// Smallest version above every version matched by the partial, e.g. "1.2" -> 1.3.0.
function upperBound(parts: number[]): Version {
  const bound = [...lowerBound(parts)] as [number, number, number];
  bound[parts.length - 1] += 1;
  for (let index = parts.length; index < 3; index += 1) bound[index] = 0;
  return bound;
}

function caretInterval(parts: number[]): Interval {
  const lo = lowerBound(parts);
  // Caret keeps the left-most non-zero specified component fixed.
  let pivot = parts.findIndex(part => part !== 0);
  if (pivot === -1) pivot = parts.length === 3 ? 2 : parts.length - 1;
  const hi = [...lo] as [number, number, number];
  hi[pivot] += 1;
  for (let index = pivot + 1; index < 3; index += 1) hi[index] = 0;
  return {lo, hi};
}

function tildeInterval(parts: number[]): Interval {
  const lo = lowerBound(parts);
  const hi = [...lo] as [number, number, number];
  if (parts.length >= 2) {
    hi[1] += 1;
    hi[2] = 0;
  } else {
    hi[0] += 1;
    hi[1] = 0;
    hi[2] = 0;
  }
  return {lo, hi};
}

function comparatorInterval(raw: string): Interval | null {
  const text = raw.trim();
  if (text === '' || text === '*' || text.toLowerCase() === 'x') return {lo: null, hi: null};
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(text);
  if (!match) return null;
  const operator = match[1] ?? '';
  const parts = parsePartial(match[2]);
  if (!parts) return null;
  switch (operator) {
    case '^':
      return caretInterval(parts);
    case '~':
      return tildeInterval(parts);
    case '>=':
      return {lo: lowerBound(parts), hi: null};
    case '>':
      return {lo: upperBound(parts), hi: null};
    case '<=':
      return {lo: null, hi: upperBound(parts)};
    case '<':
      return {lo: null, hi: lowerBound(parts)};
    default:
      // "=1.2.3", bare "1.2.3" or partials like "1.2" / "1.2.x".
      return {lo: lowerBound(parts), hi: upperBound(parts)};
  }
}

// Parses a range ("^1.2.0", ">=1.0.0 <2.0.0", "1.x", "1.2.3 || ^2.0.0") into a
// union of intervals. Returns null when the text is not a valid range. An
// empty union is valid but matches nothing (e.g. ">=2.0.0 <1.0.0").
export function parseRange(text: string): RangeSet | null {
  const intervals: Interval[] = [];
  for (const group of text.split('||')) {
    let interval: Interval = {lo: null, hi: null};
    for (const token of group.trim().split(/\s+/).filter(Boolean)) {
      const comparator = comparatorInterval(token);
      if (!comparator) return null;
      interval = intersectIntervals(interval, comparator);
    }
    if (!isEmptyInterval(interval)) intervals.push(interval);
  }
  return intervals;
}

export function satisfiesRange(version: Version, range: RangeSet): boolean {
  return range.some(interval => intervalContains(interval, version));
}

export function rangesIntersect(a: RangeSet, b: RangeSet): boolean {
  return a.some(first => b.some(second => !isEmptyInterval(intersectIntervals(first, second))));
}
