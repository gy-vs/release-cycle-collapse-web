import {describe, expect, it} from 'vitest';
import {AnalysisResult, Impact, analyzeGraph, parseGraph} from '../src/server/graph';

function analyze(content: string): AnalysisResult {
  return analyzeGraph(parseGraph(content));
}

function impactNames(result: AnalysisResult): string[] {
  return result.impacts.map(impact => impact.name);
}

function impactOf(result: AnalysisResult, name: string): Impact {
  const impact = result.impacts.find(value => value.name === name);
  if (!impact) throw new Error(`no impact for ${name}`);
  return impact;
}

// Walks every reason chain with a visited set (chains inside a cycle revisit
// packages) and asserts each hop names a concrete edge between real packages
// and ends at a release.
function expectReasonChainsResolve(result: AnalysisResult) {
  const byName = new Map(result.impacts.map(impact => [impact.name, impact]));
  const packageNames = new Set(result.packages.map(pkg => pkg.name));
  const visit = (impact: Impact, seen: Set<string>) => {
    expect(impact.reasons.length).toBeGreaterThan(0);
    for (const reason of impact.reasons) {
      if (reason.type === 'release') continue;
      expect(reason.from).toBe(impact.name);
      expect(packageNames.has(reason.to)).toBe(true);
      const next = byName.get(reason.to);
      expect(next, `edge ${reason.from} -> ${reason.to} should lead to an impacted package`).toBeDefined();
      if (!seen.has(reason.to)) {
        seen.add(reason.to);
        visit(next!, seen);
      }
    }
  };
  for (const impact of result.impacts) visit(impact, new Set([impact.name]));
}

describe('cycle-aware impact analysis', () => {
  it('handles self-loops without losing outside dependents', () => {
    const result = analyze([
      'package self@1.0.0',
      'self -> self@^1.0.0',
      'package user@1.0.0',
      'user -> self@^1.0.0',
      'release self major',
    ].join('\n'));
    expect(result.components).toEqual([
      {id: 'c0', members: ['self'], cyclic: true},
      {id: 'c1', members: ['user'], cyclic: false},
    ]);
    expect(impactOf(result, 'self')).toMatchObject({level: 'major', from: '1.0.0', to: '2.0.0'});
    expect(impactOf(result, 'user')).toMatchObject({level: 'major', from: '1.0.0', to: '2.0.0'});
    expectReasonChainsResolve(result);
  });

  it('propagates across multiple connected cycles on the condensed DAG', () => {
    const result = analyze([
      'package a@1.0.0',
      'package b@1.0.0',
      'a -> b@^1.0.0',
      'b -> a@^1.0.0',
      'package c@1.0.0',
      'package d@1.0.0',
      'c -> d@^1.0.0',
      'd -> c@^1.0.0',
      'c -> a@^1.0.0',
      'release a major',
    ].join('\n'));
    expect(result.components).toEqual([
      {id: 'c0', members: ['a', 'b'], cyclic: true},
      {id: 'c1', members: ['c', 'd'], cyclic: true},
    ]);
    expect(impactNames(result)).toEqual(['a', 'b', 'c', 'd']);
    for (const name of ['a', 'b', 'c', 'd']) expect(impactOf(result, name).level).toBe('major');
    // The reason chain crosses the component boundary on the concrete edge c -> a.
    const crossing = impactOf(result, 'c').reasons.find(reason => reason.type === 'dependency' && reason.to === 'a');
    expect(crossing).toMatchObject({from: 'c', to: 'a', range: '^1.0.0', dependencyLevel: 'major'});
    expect(impactOf(result, 'c').component).not.toBe(impactOf(result, 'a').component);
    expectReasonChainsResolve(result);
  });

  it('reaches every package outside a cycle with multiple outgoing edges', () => {
    const result = analyze([
      'package a@1.0.0',
      'package b@1.0.0',
      'a -> b@^1.0.0',
      'b -> a@^1.0.0',
      'package x@1.0.0',
      'package y@1.0.0',
      'package z@1.0.0',
      'x -> a@^1.0.0',
      'y -> b@^1.0.0',
      'z -> b@^1.0.0',
      'release a major',
    ].join('\n'));
    expect(impactNames(result)).toEqual(['a', 'b', 'x', 'y', 'z']);
    for (const name of ['x', 'y', 'z']) expect(impactOf(result, name).level).toBe('major');
    expectReasonChainsResolve(result);
  });

  it('propagates into a cycle from several released dependencies at once', () => {
    const result = analyze([
      'package a@1.0.0',
      'package b@1.0.0',
      'a -> b@^1.0.0',
      'b -> a@^1.0.0',
      'package m@1.0.0',
      'package n@1.0.0',
      'a -> m@^1.0.0',
      'b -> n@^1.0.0',
      'release m major',
      'release n major',
    ].join('\n'));
    expect(impactNames(result)).toEqual(['a', 'b', 'm', 'n']);
    expect(impactOf(result, 'a').reasons.some(reason => reason.type === 'dependency' && reason.to === 'm')).toBe(true);
    expect(impactOf(result, 'b').reasons.some(reason => reason.type === 'dependency' && reason.to === 'n')).toBe(true);
    expectReasonChainsResolve(result);
  });

  it('caps impact through optional edges at patch and flags the reason', () => {
    const result = analyze([
      'package p@1.0.0',
      'package q@2.0.0',
      'p -> q@^2.0.0 optional',
      'release q major',
    ].join('\n'));
    expect(impactOf(result, 'p')).toMatchObject({level: 'patch', from: '1.0.0', to: '1.0.1'});
    expect(impactOf(result, 'p').reasons).toContainEqual(
      expect.objectContaining({type: 'dependency', from: 'p', to: 'q', optional: true, dependencyLevel: 'major', requiredLevel: 'patch'}),
    );
  });

  it('propagates the full level through required edges', () => {
    const result = analyze([
      'package p@1.0.0',
      'package q@2.0.0',
      'p -> q@^2.0.0',
      'release q major',
    ].join('\n'));
    expect(impactOf(result, 'p')).toMatchObject({level: 'major', to: '2.0.0'});
  });

  it('treats optional edges as cycle members but still caps their contribution', () => {
    const result = analyze([
      'package a@1.0.0',
      'package b@1.0.0',
      'a -> b@^1.0.0',
      'b -> a@^1.0.0 optional',
      'release a major',
    ].join('\n'));
    expect(result.components).toEqual([{id: 'c0', members: ['a', 'b'], cyclic: true}]);
    expect(impactOf(result, 'a').level).toBe('major');
    expect(impactOf(result, 'b').level).toBe('patch');
  });

  it('solves component levels jointly instead of taking the maximum', () => {
    // a is released as minor (1.1.0), which still satisfies b's range on a, so
    // b must not be bumped even though it shares a component with a.
    const result = analyze([
      'package a@1.0.0',
      'package b@1.0.0',
      'a -> b@^1.0.0',
      'b -> a@^1.0.0',
      'release a minor',
    ].join('\n'));
    expect(result.components).toEqual([{id: 'c0', members: ['a', 'b'], cyclic: true}]);
    expect(impactNames(result)).toEqual(['a']);
    expect(impactOf(result, 'a')).toMatchObject({level: 'minor', to: '1.1.0'});
  });

  it('iterates to a fixed point when constraints chain around a cycle', () => {
    const result = analyze([
      'package a@1.0.0',
      'package b@1.1.0',
      'package c@1.0.0',
      'a -> b@~1.1.0',
      'b -> c@^1.0.0',
      'c -> a@^1.0.0',
      'release a major',
    ].join('\n'));
    expect(impactNames(result)).toEqual(['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) expect(impactOf(result, name).level).toBe('major');
    expectReasonChainsResolve(result);
  });

  it('reports conflicting ranges between the same pair of packages', () => {
    const result = analyze([
      'package p@1.0.0',
      'package q@1.5.0',
      'p -> q@^1.0.0',
      'p -> q@^2.0.0',
    ].join('\n'));
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(
      expect.arrayContaining(['range_conflict', 'unsatisfied_range']),
    );
  });

  it('reports ranges that exclude the current version and conflicting declarations', () => {
    const result = analyze([
      'package a@1.0.0',
      'package a@2.0.0',
      'package b@1.0.0',
      'b -> a@^2.0.0',
    ].join('\n'));
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(
      expect.arrayContaining(['version_conflict', 'unsatisfied_range']),
    );
    expect(result.packages.find(pkg => pkg.name === 'a')?.version).toBe('1.0.0');
  });

  it('reports invalid ranges and keeps them out of propagation', () => {
    const result = analyze([
      'package a@1.0.0',
      'package b@1.0.0',
      'a -> b@not-a-range',
      'release b major',
    ].join('\n'));
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('invalid_range');
    expect(impactNames(result)).toEqual(['b']);
  });

  it('does not require a bump when the new version still satisfies the range', () => {
    const result = analyze([
      'package app@1.0.0',
      'package lib@1.2.0',
      'app -> lib@>=1.0.0',
      'release lib major',
    ].join('\n'));
    expect(impactNames(result)).toEqual(['lib']);
  });

  it('produces identical results regardless of declaration and release order', () => {
    const canonical = analyze([
      'package a@1.0.0',
      'package b@1.0.0',
      'package c@1.0.0',
      'package d@1.0.0',
      'a -> b@^1.0.0',
      'b -> a@^1.0.0',
      'c -> a@^1.0.0',
      'd -> c@^1.0.0',
      'release a major',
      'release d minor',
    ].join('\n'));
    const shuffled = analyze([
      'release d minor',
      'd -> c@^1.0.0',
      'package d@1.0.0',
      'b -> a@^1.0.0',
      'package c@1.0.0',
      'c -> a@^1.0.0',
      'release a major',
      'package b@1.0.0',
      'a -> b@^1.0.0',
      'package a@1.0.0',
    ].join('\n'));
    expect(shuffled).toEqual(canonical);
  });

  it('gives the same impact set no matter which cycle member is released first', () => {
    const graph = (release: string) => [
      'package a@1.0.0',
      'package b@1.0.0',
      'a -> b@^1.0.0',
      'b -> a@^1.0.0',
      'package out@1.0.0',
      'out -> a@^1.0.0',
      release,
    ].join('\n');
    const fromA = analyze(graph('release a major'));
    const fromB = analyze(graph('release b major'));
    expect(impactNames(fromA)).toEqual(['a', 'b', 'out']);
    expect(impactNames(fromB)).toEqual(['a', 'b', 'out']);
    for (const name of ['a', 'b', 'out']) {
      expect(impactOf(fromA, name).level).toBe('major');
      expect(impactOf(fromB, name).level).toBe('major');
    }
  });
});
