import {describe,expect,it} from 'vitest';
import {
  parseGraph, analyzeImpact, computeSCCs, parseVersion, parseRange,
  intersectIntervals, formatInterval, isEmpty, MAX_PATHS,
} from '../src/shared/graph';

function analyze(content:string,root:string,version='1.0.0'){
  return analyzeImpact(parseGraph(content),root,version);
}

const impact=(r:ReturnType<typeof analyze>,id:string)=>r.packages.find(p=>p.packageId===id)!;
const eff=(r:ReturnType<typeof analyze>,id:string)=>{
  const e=impact(r,id).effective;
  return e===null?null:formatInterval(e);
};

describe('interval math',()=>{
  it('parses caret, tilde and comparators',()=>{
    expect(formatInterval(parseRange('^1.2.3')!.interval)).toBe('>=1.2.3 <2.0.0');
    expect(formatInterval(parseRange('^0.2.3')!.interval)).toBe('>=0.2.3 <0.3.0');
    expect(formatInterval(parseRange('^0.0.3')!.interval)).toBe('>=0.0.3 <0.0.4');
    expect(formatInterval(parseRange('~1.2.3')!.interval)).toBe('>=1.2.3 <1.3.0');
    expect(formatInterval(parseRange('>=1.0.0 <2.0.0')!.interval)).toBe('>=1.0.0 <2.0.0');
    expect(formatInterval(parseRange('1.2.3')!.interval)).toBe('>=1.2.3 <=1.2.3');
  });
  it('intersects and detects emptiness',()=>{
    expect(intersectIntervals(parseRange('^1.0.0')!.interval,parseRange('^2.0.0')!.interval)).toBeNull();
    const ok=intersectIntervals(parseRange('>=1.0.0 <3.0.0')!.interval,parseRange('^2.0.0')!.interval)!;
    expect(formatInterval(ok)).toBe('>=2.0.0 <3.0.0');
    expect(isEmpty(parseRange('>=2.0.0 <2.0.0')!.interval)).toBe(true);
  });
  it('rejects malformed ranges',()=>{
    expect(parseRange('banana')).toBeNull();
    const g=parseGraph('a -> b banana\n');
    expect(g.diagnostics.some(d=>d.level==='error')).toBe(true);
  });
  it('parses root versions',()=>{
    expect(parseVersion('v2.0.1')).toEqual({major:2,minor:0,patch:1});
    expect(parseVersion('nope')).toBeNull();
  });
});

describe('self loop',()=>{
  const content=`
a -> a ^1.0.0
a -> b ^1.0.0
`;
  it('is a cyclic singleton SCC and still exits via its outgoing edge',()=>{
    const r=analyze(content,'a','1.5.0');
    const comps=r.components.filter(c=>c.members.includes('a'));
    expect(comps).toHaveLength(1);
    expect(comps[0].cyclic).toBe(true);
    expect(comps[0].members).toEqual(['a']);
    expect(impact(r,'b').reached).toBe(true);
    // the self loop appears as a concrete edge in the reason chains
    const chains=impact(r,'a').reasonPaths.map(p=>p.edges.join('›'));
    expect(chains).toContain('a->a@2');
  });
});

describe('multiple connected cycles',()=>{
  // two interlocking cycles a<->b and b<->c collapse into one SCC, then
  // leave the cycle through two different members.
  const content=`
a -> b ^1.0.0
b -> a ^1.0.0
b -> c ^1.0.0
c -> b ^1.0.0
a -> x ^1.0.0
c -> y ^1.5.0
`;
  it('merges into one SCC and exits through every member edge',()=>{
    const r=analyze(content,'a','1.0.0');
    const scc=r.components.find(c=>c.cyclic)!;
    expect(scc.members).toEqual(['a','b','c']);
    expect(impact(r,'x').reached).toBe(true);
    expect(impact(r,'y').reached).toBe(true);
    // chains crossing the component land on the real edges
    const yChains=impact(r,'y').reasonPaths.flatMap(p=>p.edges);
    expect(yChains).toContain('c->y@7');
    // y receives ^1.5.0 specifically (not the max bump of the cycle)
    expect(eff(r,'y')).toBe('>=1.5.0 <2.0.0');
  });

  it('gives identical impact sets from every root inside the SCC',()=>{
    const summary=(root:string)=>{
      const r=analyze(content,root,'1.0.0');
      return r.packages
        .filter(p=>p.reached)
        .map(p=>[p.packageId,p.effective?formatInterval(p.effective):null] as const)
        .sort();
    };
    expect(summary('b')).toEqual(summary('a'));
    expect(summary('c')).toEqual(summary('a'));
  });
});

describe('several outgoing edges from a cycle',()=>{
  const content=`
a -> b ^1.0.0
b -> a ^1.0.0
a -> x ^1.0.0
b -> x ^1.2.0
b -> y ^1.0.0
`;
  it('visits every outgoing edge even after the SCC is marked visited',()=>{
    const r=analyze(content,'a','1.0.0');
    expect(impact(r,'x').reached).toBe(true);
    expect(impact(r,'y').reached).toBe(true);
    // joint solve: ^1.0.0 ∩ ^1.2.0 -> >=1.2.0 <2.0.0 (intersection, not max)
    expect(eff(r,'x')).toBe('>=1.2.0 <2.0.0');
    // both manifest edges are named in the constraint sources
    const edgeIds=impact(r,'x').constraintSources.map(c=>c.edgeId).sort();
    expect(edgeIds).toEqual(['a->x@4','b->x@5']);
  });
});

describe('optional edges',()=>{
  it('propagates over optional edges but keeps their constraints soft',()=>{
    const r=analyze(`
a -> b ^1.0.0
b -> a ^1.0.0
a -> x ^1.0.0 optional
`,'a','1.0.0');
    const x=impact(r,'x');
    expect(x.reached).toBe(true);
    expect(x.reasonPaths[0].optional).toBe(true);
    // no hard requirement => no blocking version, constraint still listed
    expect(x.effective).toBeNull();
    expect(x.constraintSources).toHaveLength(1);
    expect(x.constraintSources[0].hard).toBe(false);
    expect(r.conflicts).toHaveLength(0);
  });

  it('optional-only incompatibility is a soft warning, hard paths still block',()=>{
    const soft=analyze(`
a -> x ^2.0.0 optional
`,'a','1.0.0');
    // ^2.0.0 alone (no other constraints): reached, soft constraint present,
    // no hard conflict.
    expect(impact(soft,'x').reached).toBe(true);
    expect(soft.conflicts.filter(c=>c.hard)).toHaveLength(0);

    const both=analyze(`
a -> b ^1.0.0
b -> x ^1.0.0
a -> x ^2.0.0 optional
`,'a','1.0.0');
    const x=impact(both,'x');
    // hard ^1.0.0 via b, soft ^2.0.0 via a: one hard effective interval and
    // one non-hard conflict carrying the optional edge
    expect(eff(both,'x')).toBe('>=1.0.0 <2.0.0');
    const softConflict=both.conflicts.find(c=>!c.hard);
    expect(softConflict?.edgeId).toBe('a->x?@4');
    expect(both.warnings.length).toBeGreaterThan(0);
  });
});

describe('conflicting ranges across a component',()=>{
  const content=`
a -> b ^1.0.0
b -> a ^1.0.0
a -> x ^1.0.0
b -> x ^2.0.0
`;
  it('reports a hard conflict with a reason chain through the cycle',()=>{
    const r=analyze(content,'a','1.0.0');
    const conflict=r.conflicts.find(c=>c.hard&&c.packageId==='x')!;
    expect(conflict).toBeTruthy();
    expect(formatInterval(conflict.incoming)).toBe('>=2.0.0 <3.0.0');
    // the chain a -> b -> x identifies the real manifest edge, not "the group"
    expect(conflict.via.some(p=>p.edges.join('›')==='a->b@2›b->x@5')).toBe(true);
    expect(conflict.edgeId).toBe('b->x@5');
  });
});

describe('joint solving inside a component is not max-level',()=>{
  it('narrows overlapping ranges by intersection',()=>{
    const r=analyze(`
a -> b ^1.0.0
b -> a ^1.0.0
a -> x >=1.2.0
b -> x <1.5.0
`,'a','1.0.0');
    expect(eff(r,'x')).toBe('>=1.2.0 <1.5.0');
    expect(r.conflicts).toHaveLength(0);
  });
});

describe('order independence',()=>{
  const content=`
a -> b ^1.0.0
b -> a ^1.0.0
a -> c ^1.0.0
b -> c ^1.2.0
c -> d ^1.0.0
d -> c ^1.0.0
c -> e ^1.0.0
d -> e ^1.1.0
`;
  // Compare semantically (line numbers make edge ids text-order dependent).
  function semantic(contentText:string,root:string,version:string){
    const r=analyze(contentText,root,version);
    return {
      sccs:r.components.map(c=>[...c.members].sort()).sort((x,y)=>x.join()<y.join()?-1:1),
      pkgs:r.packages.map(p=>({
        id:p.packageId,
        reached:p.reached,
        eff:p.effective?formatInterval(p.effective):null,
        lvl:p.upgradeLevel,
        conflicts:p.conflicts.map(c=>({hard:c.hard,edgeLine:edgeLine(c.edgeId)})),
        // reason chains expressed as ordered (from,to) pairs, not line ids;
        // the empty chain marks the chosen root package.
        chains:p.reasonPaths.map(path=>({
          optional:path.optional,
          pairs:path.edges.length===0
            ?[[root,root]]
            :path.edges.map(eid=>{const [pair]=eid.split('@');const [f,t]=pair.split('->');return [f,t.replace('?','')];}),
        })),
      })).sort((x,y)=>x.id<y.id?-1:1),
    };
  }
  function edgeLine(edgeId:string){return edgeId.split('@')[1];}

  it('does not depend on the order lines are stored',()=>{
    const lines=content.trim().split('\n');
    const reversed=[...lines].reverse().join('\n')+'\n';
    const forward=content+'\n';
    const a=semantic(forward,'a','1.4.0');
    const b=semantic(reversed,'a','1.4.0');
    expect(a).toEqual(b);
  });

  it('is identical for every starting package in the same SCC',()=>{
    const outcome=(root:string)=>{
      const s=semantic(content,root,'1.4.0');
      return {
        sccs:s.sccs,
        pkgs:s.pkgs.map(p=>({id:p.id,reached:p.reached,eff:p.eff,lvl:p.lvl,conflicts:p.conflicts})),
      };
    };
    // a and b are the same release component; c and d are another one.
    expect(outcome('b')).toEqual(outcome('a'));
    expect(outcome('d')).toEqual(outcome('c'));
    // the SCC partition never changes with the entry point
    expect(outcome('a').sccs).toEqual(outcome('c').sccs);
  });

  it('caps path enumeration deterministically for dense cycles',()=>{
    const members=['a','b','c','d','e'];
    let text='';
    for(const m of members)for(const n of members)text+=`${m} -> ${n} ^1.0.0\n`;
    const outcome=(root:string)=>{
      const r=analyze(text,root,'1.0.0');
      return r.packages.map(p=>({
        id:p.packageId,reached:p.reached,
        eff:p.effective?formatInterval(p.effective):null,
        lvl:p.upgradeLevel,
        edges:[...new Set(p.constraintSources.map(c=>c.edgeId))].sort(),
      })).sort((x,y)=>x.id<y.id?-1:1);
    };
    // all five packages form one SCC -> every starting package is equivalent
    for(const root of ['b','c','d','e']){
      expect(outcome(root)).toEqual(outcome('a'));
    }
    const raw=analyze(text,'a','1.0.0');
    for(const p of raw.packages)expect(p.reasonPaths.length).toBeLessThanOrEqual(MAX_PATHS);
    // result is stable across repeated runs
    expect(outcome('c')).toEqual(outcome('c'));
  });
});

describe('SCC structure',()=>{
  it('finds disjoint SCCs and a DAG between them',()=>{
    const {components,memberOf}=computeSCCs(parseGraph(`
a -> b ^1.0.0
b -> a ^1.0.0
b -> c ^1.0.0
c -> d ^1.0.0
d -> c ^1.0.0
`));
    const cyclic=components.filter(c=>c.cyclic).map(c=>c.members.join('+')).sort();
    expect(cyclic).toEqual(['a+b','c+d']);
    expect(memberOf.get('a')).not.toBe(memberOf.get('c'));
  });
});
