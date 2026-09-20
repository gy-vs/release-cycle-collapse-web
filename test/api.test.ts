import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

describe('service',()=>{
  it('loads and conditionally updates a record',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/plans/alpha').expect(200);
    await request(app).put('/api/plans/alpha').send({content:'updated',revision:before.body.revision}).expect(200);
    await request(app).put('/api/plans/alpha').send({content:'stale',revision:before.body.revision}).expect(409);
  });
});

describe('impact analysis api',()=>{
  const graphText=[
    'a -> b ^1.0.0',
    'b -> a ^1.0.0',
    'a -> out ^1.0.0',
    'b -> out ^2.0.0',
    'a -> maybe ^1.0.0 optional',
  ].join('\n');

  it('analyzes the stored graph: SCC, outgoing edges and joint-solve conflict',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/plans/alpha').expect(200);
    const saved=await request(app).put('/api/plans/alpha')
      .send({content:graphText,revision:before.body.revision}).expect(200);
    const res=await request(app).post('/api/plans/alpha/analyze')
      .send({root:'a',rootVersion:'1.0.0'}).expect(200);
    const {analysis,revision}=res.body;
    expect(revision).toBe(saved.body.revision);

    const cyclic=analysis.components.filter((c:{cyclic:boolean})=>c.cyclic);
    expect(cyclic).toHaveLength(1);
    expect(cyclic[0].members.sort()).toEqual(['a','b']);

    const byId=new Map<string,{packageId:string;reached:boolean}>(analysis.packages.map((p:{packageId:string;reached:boolean})=>[p.packageId,p]));
    // both outgoing edges of the cycle propagate: out AND maybe are reached
    expect(byId.get('out')!.reached).toBe(true);
    expect(byId.get('maybe')!.reached).toBe(true);
    // joint solve conflict on out (^1 vs ^2), causes carry concrete edges
    const hard=analysis.conflicts.filter((c:{hard:boolean})=>c.hard);
    expect(hard.length).toBeGreaterThan(0);
    const outConflict=hard.find((c:{packageId:string})=>c.packageId==='out');
    expect(outConflict.edgeId).toContain('b->out');
    // node identity is the package name, never a collapsed group id
    for(const p of analysis.packages)expect(p.packageId).not.toMatch(/^scc\[/);
  });

  it('rejects an unknown root with 400',async()=>{
    const app=createApp();
    await request(app).post('/api/plans/alpha/analyze')
      .send({content:graphText,root:'ghost'}).expect(400);
  });

  it('returns parse diagnostics without crashing',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/plans/alpha/analyze')
      .send({content:'a -> b ??not-a-range\n',root:'a'}).expect(200);
    expect(res.body.analysis.diagnostics.some((d:{level:string})=>d.level==='error')).toBe(true);
  });

  it('guards analysis against a stale graph revision (revision change)',async()=>{
    const app=createApp();
    const current=await request(app).get('/api/plans/beta').expect(200);
    // someone else changes the graph
    await request(app).put('/api/plans/beta')
      .send({content:'a -> b ^1.0.0\n',revision:current.body.revision})
      .expect(200);
    // stale client analyzes with the revision it last saw
    const res=await request(app).post('/api/plans/beta/analyze')
      .send({content:graphText,root:'a',knownRevision:current.body.revision})
      .expect(409);
    expect(res.body.error).toBe('revision_conflict');
    expect(res.body.current.revision).toBe(current.body.revision+1);
    // fresh revision analyzes normally
    await request(app).post('/api/plans/beta/analyze')
      .send({root:'a',knownRevision:current.body.revision+1}).expect(200);
  });

  it('does not mutate server state when the draft content is analyzed',async()=>{
    const app=createApp();
    await request(app).post('/api/plans/alpha/analyze')
      .send({content:'only -> draft ^1.0.0\n',root:'only'}).expect(200);
    const stored=await request(app).get('/api/plans/alpha').expect(200);
    expect(stored.body.content).not.toContain('draft');
  });
});
