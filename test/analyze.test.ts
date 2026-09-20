import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {Impact, ImpactReasonDependency} from '../src/server/graph';

const CYCLE_GRAPH = [
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
  '',
].join('\n');

function fixture() {
  return [
    {id: 'cycles', name: 'Cycles', revision: 1, content: CYCLE_GRAPH, updatedAt: new Date(0).toISOString()},
    {id: 'plain', name: 'Plain', revision: 7, content: 'package solo@1.0.0\nrelease solo patch\n', updatedAt: new Date(0).toISOString()},
  ];
}

describe('analyze api', () => {
  it('propagates through a collapsed cycle to every outside dependent', async () => {
    const app = createApp(fixture());
    const response = await request(app).post('/api/plans/cycles/analyze').send({}).expect(200);
    expect(response.body.revision).toBe(1);
    const cyclic = response.body.components.find((component: {cyclic: boolean}) => component.cyclic);
    expect(cyclic.members).toEqual(['a', 'b']);
    const names = response.body.impacts.map((impact: {name: string}) => impact.name);
    // The collapsed group must not swallow the outgoing edges: x, y and z all
    // sit outside the cycle and all of them are impacted.
    expect(names).toEqual(['a', 'b', 'x', 'y', 'z']);
    for (const impact of response.body.impacts) expect(impact.level).toBe('major');
  });

  it('returns the same analysis regardless of statement order in the graph', async () => {
    const app = createApp(fixture());
    const canonical = await request(app).post('/api/plans/cycles/analyze').send({}).expect(200);
    const shuffled = [
      'release a major',
      'z -> b@^1.0.0',
      'package z@1.0.0',
      'b -> a@^1.0.0',
      'package y@1.0.0',
      'y -> b@^1.0.0',
      'package b@1.0.0',
      'x -> a@^1.0.0',
      'package x@1.0.0',
      'a -> b@^1.0.0',
      'package a@1.0.0',
      '',
    ].join('\n');
    const reordered = await request(app).post('/api/plans/cycles/analyze').send({content: shuffled}).expect(200);
    expect(reordered.body).toEqual(canonical.body);
  });

  it('recomputes when the graph revision changes and never serves stale results', async () => {
    const app = createApp(fixture());
    const before = await request(app).post('/api/plans/cycles/analyze').send({}).expect(200);
    expect(before.body.impacts.map((impact: {name: string}) => impact.name)).not.toContain('w');

    const updated = CYCLE_GRAPH.replace('release a major', 'w -> a@^1.0.0\npackage w@1.0.0\nrelease a major');
    const put = await request(app).put('/api/plans/cycles').send({content: updated, revision: 1}).expect(200);
    expect(put.body.revision).toBe(2);

    const after = await request(app).post('/api/plans/cycles/analyze').send({}).expect(200);
    expect(after.body.revision).toBe(2);
    expect(after.body.impacts.map((impact: {name: string}) => impact.name)).toEqual(['a', 'b', 'w', 'x', 'y', 'z']);

    // A stale revision is rejected instead of silently analyzing the new graph.
    await request(app).post('/api/plans/cycles/analyze').send({revision: 1}).expect(409);
  });

  it('analyzes an unsaved draft without changing the stored revision', async () => {
    const app = createApp(fixture());
    const draft = 'package solo@1.0.0\npackage dep@2.0.0\nsolo -> dep@^2.0.0\nrelease dep major\n';
    const response = await request(app).post('/api/plans/plain/analyze').send({content: draft}).expect(200);
    expect(response.body.revision).toBe(7);
    expect(response.body.impacts.map((impact: {name: string}) => impact.name)).toEqual(['dep', 'solo']);
    const row = await request(app).get('/api/plans/plain').expect(200);
    expect(row.body.revision).toBe(7);
  });

  it('keeps reason chains on concrete edges when they cross components', async () => {
    const app = createApp(fixture());
    const response = await request(app).post('/api/plans/cycles/analyze').send({}).expect(200);
    const impacts = new Map<string, Impact>(response.body.impacts.map((impact: Impact) => [impact.name, impact]));
    const componentOf = new Map<string, string>(response.body.packages.map((pkg: {name: string; component: string}) => [pkg.name, pkg.component]));
    const dependencyHop = (impact: Impact) =>
      impact.reasons.find((reason): reason is ImpactReasonDependency => reason.type === 'dependency');

    // Walk from an outside dependent back towards the release: every hop must
    // name a concrete edge between two real packages. Reason chains inside a
    // cycle refer to each other, so the walk stops when it closes a loop.
    const walk = (start: string) => {
      const seen = new Set<string>();
      const chain: string[] = [];
      let current = impacts.get(start);
      while (current && !seen.has(current.name)) {
        seen.add(current.name);
        chain.push(current.name);
        const hop = dependencyHop(current);
        if (!hop) break;
        expect(hop.from).toBe(current.name);
        expect(impacts.has(hop.to)).toBe(true);
        current = impacts.get(hop.to);
      }
      return chain;
    };

    const chain = walk('z');
    expect(chain).toEqual(['z', 'b', 'a']);
    expect(impacts.get('a')!.reasons).toContainEqual({type: 'release', level: 'major'});

    // The hop out of the cycle names the concrete cross-component edge.
    const crossing = dependencyHop(impacts.get('x')!);
    expect(crossing).toMatchObject({from: 'x', to: 'a', range: '^1.0.0'});
    expect(componentOf.get('x')).not.toBe(componentOf.get('a'));
  });
});
