// Release impact engine.
//
// Edge pkg -> dep means "pkg depends on dep at range".  Releasing a package
// forces every package that (transitively) depends on it to re-cut a
// release, so impact propagates along the REVERSE edge direction:
// dependency -> dependent.
//
// Propagation always runs on the condensation DAG of the strongly connected
// components (Tarjan).  Every component is processed exactly once and every
// crossing edge of every member is enumerated, so collapsing a cycle into a
// display group can never hide its outgoing edges.  Component identity and
// condensation order come from the graph itself, which makes the result
// independent of the root package and of edge storage order.
//
// Version constraints are semver-style intervals combined by INTERSECTION
// ("joint solving"); an SCC never takes "the max bump level".  A range on an
// edge X -> P constrains P's version whenever X is part of the impacted
// release train.  Every cause keeps the concrete chain of edge ids that
// produced it, including simple paths used to cross cycles.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Version = {major:number;minor:number;patch:number};

/** Ordered bound; null means the side is open. */
export type Bound = {version:Version;inclusive:boolean} | null;

export type Interval = {min:Bound;max:Bound};

export type ParseDiagnostic = {
  line:number;
  level:'error'|'warning';
  code:'parse_error'|'duplicate_package'|'duplicate_edge';
  message:string;
};

export type PackageDesc = {id:string;line:number};

export type Edge = {
  id:string;
  from:string;
  to:string;
  range:string;                 // as written ("^1.2.0", ">=1.0.0 <2.0.0", ...)
  interval:Interval;
  optional:boolean;
  line:number;
};

export type ParsedGraph = {
  packages:PackageDesc[];       // sorted by id
  edges:Edge[];                 // sorted deterministically
  diagnostics:ParseDiagnostic[];
  adjacency:Map<string, Edge[]>; // depends-on edges leaving a package
  reverse:Map<string, Edge[]>;   // edges by which other packages depend on it
};

export type Component = {
  id:string;
  members:string[];             // sorted
  cyclic:boolean;               // >1 member, or a self loop
  index:number;                 // condensation topological order (0 = source)
};

export type ReasonPath = {
  edges:string[];               // concrete edge ids, root -> target
  optional:boolean;             // true iff at least one edge is optional
};

export type ConstraintInfo = {
  interval:Interval;
  hard:boolean;                 // false => carried only by optional paths
  range:string;
  edgeId:string|null;           // manifest edge imposing it (null = root pin)
  via:ReasonPath[];             // concrete chains carrying this constraint
};

export type Conflict = {
  kind:'conflicting_range';
  packageId:string;
  hard:boolean;                 // false => clash is on an optional-only path
  required:Interval;
  incoming:Interval;
  range:string;
  edgeId:string;
  via:ReasonPath[];
};

export type PackageImpact = {
  packageId:string;
  componentId:string;
  reached:boolean;
  effective:Interval|null;      // intersection of all HARD constraints
  hardOnly:boolean;
  requiredVersion:Version|null; // lowest satisfying version
  upgradeLevel:'none'|'patch'|'minor'|'major'|'downgrade'|null;
  conflicts:Conflict[];
  constraintSources:ConstraintInfo[];
  reasonPaths:ReasonPath[];     // concrete root -> this package chains
  reasonPathsTruncated:boolean;
};

export type AnalyzeGraphResponse = {
  root:string;
  rootVersion:Version;
  components:Component[];
  condensationEdges:{from:string;to:string;edgeIds:string[]}[];
  packages:PackageImpact[];
  conflicts:Conflict[];
  warnings:string[];
  diagnostics:ParseDiagnostic[];
};

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export function parseVersion(text:string):Version|null{
  const m=/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec((text??'').trim());
  if(!m)return null;
  return {major:+m[1],minor:+m[2],patch:+m[3]};
}

export function formatVersion(v:Version):string{
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function compareVersions(a:Version,b:Version):number{
  return (a.major-b.major)||(a.minor-b.minor)||(a.patch-b.patch);
}

function bumpLevel(from:Version,to:Version):'patch'|'minor'|'major'{
  if(to.major!==from.major)return 'major';
  if(to.minor!==from.minor)return 'minor';
  return 'patch';
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

const ANY:Interval={min:null,max:null};

// EMPTY is a unique sentinel; emptiness is checked by identity.
const EMPTY:Interval=Object.freeze({
  min:{version:{major:0,minor:0,patch:0},inclusive:false},
  max:{version:{major:0,minor:0,patch:0},inclusive:false},
}) as Interval;

export function isEmpty(i:Interval):boolean{return i===EMPTY;}
export function anyInterval():Interval{return ANY;}

function exact(v:Version):Interval{
  return {min:{version:{...v},inclusive:true},max:{version:{...v},inclusive:true}};
}

function tilde(v:Version):Interval{
  return {min:{version:v,inclusive:true},max:{version:{major:v.major,minor:v.minor+1,patch:0},inclusive:false}};
}

function caret(v:Version):Interval{
  // ^1.2.3 -> <2.0.0 ; ^0.2.3 -> <0.3.0 ; ^0.0.3 -> <0.0.4
  let next:Version;
  if(v.major>0)next={major:v.major+1,minor:0,patch:0};
  else if(v.minor>0)next={major:0,minor:v.minor+1,patch:0};
  else next={major:0,minor:0,patch:v.patch+1};
  return {min:{version:v,inclusive:true},max:{version:next,inclusive:false}};
}

function parseComparator(token:string):Interval|null{
  const m=/^(>=|<=|>|<|=|\^|~)?\s*v?(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(token.trim());
  if(!m)return null;
  const op=(m[1]??'=') as '='|'>'|'>='|'<'|'<='|'^'|'~';
  const v=parseVersion(m[2]);
  if(!v)return null;
  switch(op){
    case '^':return caret(v);
    case '~':return tilde(v);
    case '=':return exact(v);
    case '>':return {min:{version:v,inclusive:false},max:null};
    case '>=':return {min:{version:v,inclusive:true},max:null};
    case '<':return {min:null,max:{version:v,inclusive:false}};
    case '<=':return {min:null,max:{version:v,inclusive:true}};
  }
}

export function parseRange(raw:string):{interval:Interval;range:string}|null{
  const text=(raw??'').trim();
  if(text===''||text==='*'||text==='x')return {interval:ANY,range:raw??''};
  let acc:Interval=ANY;
  // Whitespace separated comparators intersect. "||" unions are unsupported.
  for(const token of text.split(/\s+/).filter(Boolean)){
    const part=parseComparator(token);
    if(!part)return null;
    const merged=intersectIntervals(acc,part);
    acc=merged===null?EMPTY:merged;
  }
  return {interval:acc,range:text};
}

/** Intersection; null when no version can satisfy. */
export function intersectIntervals(a:Interval,b:Interval):Interval|null{
  if(isEmpty(a)||isEmpty(b))return EMPTY;
  let min:Bound;
  if(a.min===null)min=b.min?{...b.min}:null;
  else if(b.min===null)min={...a.min};
  else{
    const c=compareVersions(a.min.version,b.min.version);
    if(c>0)min={...a.min};
    else if(c<0)min={...b.min};
    else min={version:{...a.min.version},inclusive:a.min.inclusive&&b.min.inclusive};
  }
  let max:Bound;
  if(a.max===null)max=b.max?{...b.max}:null;
  else if(b.max===null)max={...a.max};
  else{
    const c=compareVersions(a.max.version,b.max.version);
    if(c<0)max={...a.max};
    else if(c>0)max={...b.max};
    else max={version:{...a.max.version},inclusive:a.max.inclusive&&b.max.inclusive};
  }
  if(min!==null&&max!==null){
    const c=compareVersions(min.version,max.version);
    if(c>0)return null;
    if(c===0&&!(min.inclusive&&max.inclusive))return null;
  }
  return {min,max};
}

function lowestSatisfying(i:Interval):Version|null{
  if(isEmpty(i))return null;
  if(i.min)return i.min.inclusive?{...i.min.version}:{...i.min.version,patch:i.min.version.patch+1};
  return {major:0,minor:0,patch:0};
}

export function formatInterval(i:Interval):string{
  if(isEmpty(i))return '<empty>';
  if(i.min===null&&i.max===null)return '*';
  const parts:string[]=[];
  if(i.min)parts.push(`${i.min.inclusive?'>=':'>'}${formatVersion(i.min.version)}`);
  if(i.max)parts.push(`${i.max.inclusive?'<=':'<'}${formatVersion(i.max.version)}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Graph text format
//
//   package root
//   root -> lib ^1.0.0
//   root -> logger ^2.0.0 optional
//   lib -> root ^1.0.0          (edge back into the cycle)
// ---------------------------------------------------------------------------

export function parseGraph(content:string):ParsedGraph{
  const lines=content.split(/\r?\n/);
  const packageMap=new Map<string,PackageDesc>();
  const edges:Edge[]=[];
  const diagnostics:ParseDiagnostic[]=[];
  const declared=new Set<string>();
  const seenEdges=new Set<string>();

  for(let i=0;i<lines.length;i++){
    const text=lines[i].trim();
    const line=i+1;
    if(text===''||text.startsWith('#'))continue;

    const edgeM=/^([A-Za-z0-9_.-]+)\s*->\s*([A-Za-z0-9_.-]+)(?:\s+(.*))?$/.exec(text);
    if(edgeM){
      const from=edgeM[1],to=edgeM[2];
      const rest=(edgeM[3]??'').trim();
      const optional=/\boptional\b/.test(rest);
      const rangeText=rest.replace(/\boptional\b/g,'').trim();
      const parsed=parseRange(rangeText);
      if(!parsed){
        diagnostics.push({line,level:'error',code:'parse_error',message:`Cannot parse version range "${rangeText}" on edge ${from} -> ${to}`});
        continue;
      }
      if(!packageMap.has(from))packageMap.set(from,{id:from,line});
      if(!packageMap.has(to))packageMap.set(to,{id:to,line});
      const dedupeKey=`${from}->${to}${optional?'?':''}:${rangeText}`;
      if(seenEdges.has(dedupeKey)){
        diagnostics.push({line,level:'warning',code:'duplicate_edge',message:`Duplicate edge ${from} -> ${to} ignored`});
        continue;
      }
      seenEdges.add(dedupeKey);
      edges.push({id:`${from}->${to}${optional?'?':''}@${line}`,from,to,range:parsed.range||'*',interval:parsed.interval,optional,line});
      continue;
    }

    const pkgM=/^package\s+([A-Za-z0-9_.-]+)\s*$/.exec(text);
    if(pkgM){
      const id=pkgM[1];
      if(declared.has(id)){
        diagnostics.push({line,level:'warning',code:'duplicate_package',message:`Package "${id}" declared more than once`});
        continue;
      }
      declared.add(id);
      if(!packageMap.has(id))packageMap.set(id,{id,line});
    }
  }

  const packages=[...packageMap.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  edges.sort((a,b)=>a.line-b.line||(a.id<b.id?-1:a.id>b.id?1:0));
  diagnostics.sort((a,b)=>a.line-b.line||(a.code<b.code?-1:1));

  const adjacency=new Map<string,Edge[]>();
  const reverse=new Map<string,Edge[]>();
  for(const p of packages){adjacency.set(p.id,[]);reverse.set(p.id,[]);}
  for(const e of edges){adjacency.get(e.from)!.push(e);reverse.get(e.to)!.push(e);}
  for(const list of adjacency.values())list.sort((a,b)=>a.id<b.id?-1:1);
  for(const list of reverse.values())list.sort((a,b)=>a.id<b.id?-1:1);

  return {packages,edges,diagnostics,adjacency,reverse};
}

// ---------------------------------------------------------------------------
// SCC (Tarjan, iterative, neighbours in sorted order)
// ---------------------------------------------------------------------------

export function computeSCCs(graph:ParsedGraph):{components:Component[];memberOf:Map<string,string>}{
  const indexOf=new Map<string,number>();
  const low=new Map<string,number>();
  const onStack=new Set<string>();
  const stack:string[]=[];
  let counter=0;
  const emitted:string[][]=[];

  for(const root of graph.packages.map(p=>p.id)){
    if(indexOf.has(root))continue;
    type Frame={node:string;neighbours:string[];cursor:number};
    const frames:Frame[]=[{node:root,neighbours:graph.adjacency.get(root)!.map(e=>e.to),cursor:0}];
    indexOf.set(root,counter);low.set(root,counter);counter++;stack.push(root);onStack.add(root);
    while(frames.length){
      const frame=frames[frames.length-1];
      const v=frame.node;
      if(frame.cursor<frame.neighbours.length){
        const w=frame.neighbours[frame.cursor++];
        if(!indexOf.has(w)){
          indexOf.set(w,counter);low.set(w,counter);counter++;stack.push(w);onStack.add(w);
          frames.push({node:w,neighbours:graph.adjacency.get(w)!.map(e=>e.to),cursor:0});
        }else if(onStack.has(w)){
          low.set(v,Math.min(low.get(v)!,indexOf.get(w)!));
        }
      }else{
        if(low.get(v)===indexOf.get(v)){
          const members:string[]=[];
          for(;;){
            const w=stack.pop()!;
            onStack.delete(w);
            members.push(w);
            if(w===v)break;
          }
          emitted.push(members);
        }
        frames.pop();
        if(frames.length){
          const parent=frames[frames.length-1].node;
          low.set(parent,Math.min(low.get(parent)!,low.get(v)!));
        }
      }
    }
  }

  // Tarjan emits SCCs in reverse topological (depends-on) order.
  const components:Component[]=emitted.map((members,emittedIndex)=>{
    const sorted=[...members].sort();
    const only=members[0];
    const cyclic=members.length>1||graph.adjacency.get(only)!.some(e=>e.to===only);
    return {id:'scc['+sorted.join(',')+']',members:sorted,cyclic,index:emitted.length-1-emittedIndex};
  });
  components.sort((a,b)=>a.index-b.index);

  const memberOf=new Map<string,string>();
  for(const c of components)for(const m of c.members)memberOf.set(m,c.id);
  return {components,memberOf};
}

// ---------------------------------------------------------------------------
// Simple paths inside a component (concrete reason chains crossing cycles)
// ---------------------------------------------------------------------------

export const MAX_PATHS=50;
const MAX_PATH_EDGES=24;

function compareReason(a:ReasonPath,b:ReasonPath):number{
  const ka=a.edges.join('›')+'|'+(a.optional?'o':'h');
  const kb=b.edges.join('›')+'|'+(b.optional?'o':'h');
  return ka<kb?-1:ka>kb?1:0;
}

function dedupePaths(list:ReasonPath[]){
  const seen=new Set<string>();
  for(let i=list.length-1;i>=0;i--){
    const key=list[i].edges.join('›')+'|'+(list[i].optional?'o':'h');
    if(seen.has(key))list.splice(i,1);else seen.add(key);
  }
}

/**
 * Simple edge chains from `enter` to every reachable member of the given
 * component.  `dir` selects the walking direction:
 *   - 'impact' walks reverse edges (dependency -> dependent); used for
 *     propagation and reason chains;
 *   - 'dep' walks depends-on edges.
 * The empty chain always reaches `enter` itself; a self loop is additionally
 * returned as a one-edge chain.  Results are sorted, de-duplicated, capped.
 */
export function internalChains(
  graph:ParsedGraph,
  members:Set<string>,
  enter:string,
  dir:'impact'|'dep'='impact',
):Map<string,ReasonPath[]>{
  const result=new Map<string,ReasonPath[]>();
  result.set(enter,[{edges:[],optional:false}]);
  const edgesAt=(id:string)=>dir==='impact'?graph.reverse.get(id)!:graph.adjacency.get(id)!;

  type State={node:string;edges:string[];optional:boolean;visited:Set<string>};
  const dfs:State[]=[{node:enter,edges:[],optional:false,visited:new Set([enter])}];
  while(dfs.length){
    const state=dfs.pop()!;
    for(const edge of edgesAt(state.node)){
      const other=dir==='impact'?edge.from:edge.to;
      if(!members.has(other))continue;
      const nextEdges=[...state.edges,edge.id];
      const nextOptional=state.optional||edge.optional;
      if(other===state.node){ // self loop
        add(result,state.node,{edges:nextEdges,optional:nextOptional});
        continue;
      }
      if(state.visited.has(other))continue;
      if(nextEdges.length>MAX_PATH_EDGES)continue;
      add(result,other,{edges:nextEdges,optional:nextOptional});
      const visited=new Set(state.visited);visited.add(other);
      dfs.push({node:other,edges:nextEdges,optional:nextOptional,visited});
    }
  }
  for(const list of result.values()){
    dedupePaths(list);list.sort(compareReason);
    if(list.length>MAX_PATHS)list.length=MAX_PATHS;
  }
  return result;
}

function add(map:Map<string,ReasonPath[]>,node:string,path:ReasonPath){
  let list=map.get(node);
  if(!list){list=[];map.set(node,list);}
  if(list.length<MAX_PATHS)list.push(path);
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

export class GraphError extends Error{
  constructor(public code:string,message:string){super(message);this.name='GraphError';}
}

type PropEdge={source:string;target:string;edge:Edge};
type Entry={member:string;path:ReasonPath};

export function analyzeImpact(graph:ParsedGraph,root:string,rootVersionInput?:string):AnalyzeGraphResponse{
  const rootVersion=parseVersion(rootVersionInput??'1.0.0');
  if(!rootVersion)throw new GraphError('bad_root_version',`Cannot parse root version "${rootVersionInput}"`);
  if(graph.diagnostics.some(d=>d.level==='error')){
    return {
      root,rootVersion,components:computeSCCs(graph).components,
      condensationEdges:[],packages:[],conflicts:[],warnings:[],diagnostics:graph.diagnostics,
    };
  }
  if(!graph.adjacency.has(root))throw new GraphError('unknown_root',`Unknown root package "${root}"`);

  const {components,memberOf}=computeSCCs(graph);
  const componentById=new Map(components.map(c=>[c.id,c]));

  // Condensation edges in depends-on direction (metadata / display only).
  const cond=new Map<string,Map<string,Set<string>>>();
  for(const c of components)cond.set(c.id,new Map());
  for(const e of graph.edges){
    const cf=memberOf.get(e.from)!,ct=memberOf.get(e.to)!;
    if(cf===ct)continue;
    if(!cond.get(cf)!.has(ct))cond.get(cf)!.set(ct,new Set());
    cond.get(cf)!.get(ct)!.add(e.id);
  }
  const condensationEdges=[...cond].flatMap(([from,inner])=>
    [...inner].map(([to,ids])=>({from,to,edgeIds:[...ids].sort()})))
    .sort((a,b)=>a.from<b.from?-1:a.from>b.from?1:a.to<b.to?-1:1);

  // Propagation edges: releasing a package drags everything it (transitively)
  // depends on into the release train, so for manifest edge X->Y the
  // condensation propagation edge runs comp(X) -> comp(Y).  Stored once per
  // actual edge: parallel / multiple outgoing edges are all enumerated.
  const propOut=new Map<string,PropEdge[]>();
  const propIn=new Map<string,PropEdge[]>();
  for(const c of components){propOut.set(c.id,[]);propIn.set(c.id,[]);}
  for(const e of graph.edges){
    const cf=memberOf.get(e.from)!,ct=memberOf.get(e.to)!;
    if(cf===ct)continue;
    const pe:PropEdge={source:cf,target:ct,edge:e};
    propOut.get(cf)!.push(pe);
    propIn.get(ct)!.push(pe);
  }
  const peSort=(a:PropEdge,b:PropEdge)=>
    a.target<b.target?-1:a.target>b.target?1:a.source<b.source?-1:a.source>b.source?1:a.edge.id<b.edge.id?-1:1;
  for(const list of propOut.values())list.sort(peSort);
  for(const list of propIn.values())list.sort(peSort);

  // Reachability from the root component over the propagation DAG.  The
  // request names one package, but the release unit is its whole component:
  // the pinned new version applies to every member of the root component
  // during joint solving, so the analysis is invariant under picking any
  // member of the same SCC as the starting package.
  const rootComp=memberOf.get(root)!;
  const reachable=new Set<string>([rootComp]);
  {
    const queue=[rootComp];
    while(queue.length){
      const cid=queue.shift()!;
      for(const pe of propOut.get(cid)!){
        if(!reachable.has(pe.target)){reachable.add(pe.target);queue.push(pe.target);}
      }
    }
  }

  // Kahn topological order of the reachable slice in PROPAGATION direction:
  // source component (depended upon) is emitted before target (dependent).
  const preds=new Map<string,Set<string>>();
  for(const cid of reachable)preds.set(cid,new Set());
  for(const cid of reachable)for(const pe of propOut.get(cid)!){
    if(reachable.has(pe.target))preds.get(pe.target)!.add(cid);
  }
  const order:string[]=[];
  {
    const ready=[...reachable].filter(cid=>preds.get(cid)!.size===0).sort();
    while(ready.length){
      const cid=ready.shift()!;
      order.push(cid);
      for(const pe of propOut.get(cid)!){
        if(!reachable.has(pe.target))continue;
        if(preds.get(pe.target)!.delete(cid)&&preds.get(pe.target)!.size===0)ready.push(pe.target);
      }
      ready.sort();
    }
  }

  // -- Stage 1: entry paths per component -------------------------------
  // pe.edge = X -> Y with X (edge.from) in the source component and
  // Y (edge.to) in the target component.  Walk dependency edges inside the
  // source component to X, cross the concrete edge, land on Y.
  const entriesByComp=new Map<string,Entry[]>();
  for(const cid of order){
    if(cid===rootComp){
      entriesByComp.set(cid,[{member:root,path:{edges:[],optional:false}}]);
      continue;
    }
    const entries:Entry[]=[];
    for(const pe of propIn.get(cid)!){
      const sourceEntries=entriesByComp.get(pe.source);
      if(!sourceEntries)continue;
      const sourceMembers=new Set(componentById.get(pe.source)!.members);
      for(const se of sourceEntries){
        const chains=internalChains(graph,sourceMembers,se.member,'dep');
        const toExit=chains.get(pe.edge.from)??[];
        for(const chain of toExit){
          entries.push({
            member:pe.edge.to,
            path:{
              edges:[...se.path.edges,...chain.edges,pe.edge.id],
              optional:se.path.optional||chain.optional||pe.edge.optional,
            },
          });
        }
      }
    }
    dedupeEntries(entries);
    entries.sort((a,b)=>a.member<b.member?-1:a.member>b.member?1:compareReason(a.path,b.path));
    entriesByComp.set(cid,entries.slice(0,MAX_PATHS));
  }

  // -- Stage 2: per-member reason chains + active set -------------------
  const reasonsByComp=new Map<string,Map<string,ReasonPath[]>>();
  const activeByComp=new Map<string,Set<string>>();
  const truncatedReasons=new Set<string>();

  for(const cid of order){
    const members=new Set(componentById.get(cid)!.members);
    const entries=entriesByComp.get(cid)!;
    const reasonsFor=new Map<string,ReasonPath[]>();
    for(const m of members)reasonsFor.set(m,[]);
    for(const entry of entries){
      const chains=internalChains(graph,members,entry.member,'dep');
      for(const [m,list] of chains){
        for(const chain of list){
          reasonsFor.get(m)!.push({
            edges:[...entry.path.edges,...chain.edges],
            optional:entry.path.optional||chain.optional,
          });
        }
      }
    }
    for(const [m,list] of reasonsFor){
      dedupePaths(list);list.sort(compareReason);
      if(list.length>MAX_PATHS){truncatedReasons.add(m);list.length=MAX_PATHS;}
    }
    reasonsByComp.set(cid,reasonsFor);

    // Active = reachable from any entry over dependency edges; optional edges
    // ARE followed (optional dependencies still join the train, their
    // constraints just stay soft).  Every outgoing side edge of a cycle is
    // reached through this flood.
    const active=new Set<string>(entries.map(e=>e.member));
    if(cid===rootComp)active.add(root);
    let grew=true;
    while(grew){
      grew=false;
      for(const m of [...active].sort()){
        for(const e of graph.adjacency.get(m)!){
          if(members.has(e.to)&&!active.has(e.to)){active.add(e.to);grew=true;}
        }
      }
    }
    activeByComp.set(cid,active);
  }

  const isImpacted=(id:string):boolean=>{
    const cid=memberOf.get(id)!;
    return activeByComp.get(cid)?.has(id)??false;
  };
  const reasonsOf=(id:string):ReasonPath[]=>reasonsByComp.get(memberOf.get(id)!)!.get(id)!;

  // -- Stage 3: joint constraint solving --------------------------------
  // Uniform rule: manifest edge X -> P constrains P iff X is impacted;
  // evidence = a concrete reason chain to X followed by that edge.
  // The root additionally carries the pinned new version.
  const impacts=new Map<string,PackageImpact>();
  const allConflicts:Conflict[]=[];
  const warnings:string[]=[];

  for(const cid of order){
    const component=componentById.get(cid)!;
    for(const m of component.members){
      if(!isImpacted(m)){
        impacts.set(m,blankImpact(m,cid));
        continue;
      }
      const sources:ConstraintInfo[]=[];
      for(const e of graph.reverse.get(m)!){ // e: X -> m
        if(!isImpacted(e.from))continue;
        const via:ReasonPath[]=[];
        for(const r of reasonsOf(e.from)){
          // The crossing edge may already close the chain to X.
          const last=r.edges[r.edges.length-1];
          via.push(last===e.id?{...r}:{edges:[...r.edges,e.id],optional:r.optional||e.optional});
        }
        if(via.length===0)continue;
        dedupePaths(via);via.sort(compareReason);
        sources.push({
          interval:e.interval,
          hard:!e.optional&&via.some(v=>!v.optional),
          range:e.range,edgeId:e.id,via:via.slice(0,MAX_PATHS),
        });
      }
      const merged=mergeConstraints(sources);

      // Intersect HARD constraints: an empty intersection is a
      // release-blocking conflict.  Optional-only constraints are checked
      // against the hard solution afterwards: clashes are soft warnings.
      const memberConflicts:Conflict[]=[];
      let hardAcc:Interval|null=null;
      for(const c of merged){
        if(!c.hard)continue;
        if(hardAcc===null){hardAcc=c.interval;continue;}
        if(intersectIntervals(hardAcc,c.interval)===null){
          const conflict:Conflict={kind:'conflicting_range',packageId:m,hard:true,required:hardAcc,incoming:c.interval,range:c.range,edgeId:c.edgeId??'(root)',via:c.via};
          memberConflicts.push(conflict);allConflicts.push(conflict);
          break;
        }
        hardAcc=intersectIntervals(hardAcc,c.interval)!;
      }
      const base=hardAcc??ANY;
      for(const c of merged){
        if(c.hard)continue;
        if(intersectIntervals(base,c.interval)===null){
          const conflict:Conflict={kind:'conflicting_range',packageId:m,hard:false,required:base,incoming:c.interval,range:c.range,edgeId:c.edgeId??'(root)',via:c.via};
          memberConflicts.push(conflict);allConflicts.push(conflict);
          warnings.push(`Optional path into ${m} asks for ${formatInterval(c.interval)} (${c.range}), incompatible with ${formatInterval(base)}`);
        }
      }

      // The release train pins the root component to ONE new version.  Every
      // member of the root component is released at that version, so the pin
      // is checked against each member's negotiated interval — this keeps
      // the answer independent of which cycle member was picked as root.
      let effective:Interval|null=hardAcc;
      let requiredVersion:Version|null=null;
      let upgradeLevel:PackageImpact['upgradeLevel']=null;
      if(cid===rootComp){
        if(hardAcc===null||!isEmpty(hardAcc)){
          if(hardAcc!==null&&intersectIntervals(hardAcc,exact(rootVersion))===null){
            const conflict:Conflict={
              kind:'conflicting_range',packageId:m,hard:true,required:hardAcc,
              incoming:exact(rootVersion),range:formatVersion(rootVersion),
              edgeId:'(release-pin)',via:[{edges:[],optional:false}],
            };
            memberConflicts.push(conflict);allConflicts.push(conflict);
          }else{
            effective=exact(rootVersion);
          }
        }
      }
      if(effective!==null&&!isEmpty(effective)){
        requiredVersion=cid===rootComp?{...rootVersion}:lowestSatisfying(effective);
        if(requiredVersion){
          const cmp=compareVersions(requiredVersion,rootVersion);
          upgradeLevel=cmp<0?'downgrade':cmp===0?'none':bumpLevel(rootVersion,requiredVersion);
        }
      }

      const reasons=reasonsOf(m);
      impacts.set(m,{
        packageId:m,componentId:cid,reached:true,
        effective,
        hardOnly:cid===rootComp||merged.some(c=>c.hard),
        requiredVersion,upgradeLevel,
        conflicts:memberConflicts,
        constraintSources:merged,
        reasonPaths:reasons,
        reasonPathsTruncated:truncatedReasons.has(m),
      });
    }
  }

  for(const pkg of graph.packages){
    if(!impacts.has(pkg.id))impacts.set(pkg.id,blankImpact(pkg.id,memberOf.get(pkg.id)!));
  }

  dedupeConflicts(allConflicts);
  allConflicts.sort((a,b)=>a.packageId<b.packageId?-1:a.packageId>b.packageId?1:a.edgeId<b.edgeId?-1:a.edgeId>b.edgeId?1:0);

  return {
    root,rootVersion,components,condensationEdges,
    packages:graph.packages.map(p=>impacts.get(p.id)!),
    conflicts:allConflicts,
    warnings:[...new Set(warnings)].sort(),
    diagnostics:graph.diagnostics,
  };
}

function blankImpact(packageId:string,componentId:string):PackageImpact{
  return {packageId,componentId,reached:false,effective:null,hardOnly:false,requiredVersion:null,upgradeLevel:null,conflicts:[],constraintSources:[],reasonPaths:[],reasonPathsTruncated:false};
}

function mergeConstraints(list:ConstraintInfo[]):ConstraintInfo[]{
  const map=new Map<string,ConstraintInfo>();
  for(const c of list){
    const key=`${c.edgeId??'(root)'}|${c.hard?'h':'o'}|${formatInterval(c.interval)}`;
    const existing=map.get(key);
    if(existing){
      existing.via.push(...c.via);
      dedupePaths(existing.via);existing.via.sort(compareReason);
      if(existing.via.length>MAX_PATHS)existing.via.length=MAX_PATHS;
    }else{
      map.set(key,{...c,via:[...c.via]});
    }
  }
  return [...map.values()].sort((a,b)=>(a.edgeId??'')<(b.edgeId??'')?-1:(a.edgeId??'')>(b.edgeId??'')?1:0);
}

function dedupeEntries(list:Entry[]){
  const seen=new Set<string>();
  for(let i=list.length-1;i>=0;i--){
    const key=list[i].member+'|'+list[i].path.edges.join('›')+'|'+(list[i].path.optional?'o':'h');
    if(seen.has(key))list.splice(i,1);else seen.add(key);
  }
}

function dedupeConflicts(list:Conflict[]){
  const seen=new Set<string>();
  for(let i=list.length-1;i>=0;i--){
    const c=list[i];
    const key=[c.packageId,c.hard,c.edgeId,formatInterval(c.required),formatInterval(c.incoming)].join('|');
    if(seen.has(key))list.splice(i,1);else seen.add(key);
  }
}
