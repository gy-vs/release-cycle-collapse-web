import {useEffect,useMemo,useState} from 'react';
import {FlaskConical,GitBranch,Play,Save,ChevronDown,ChevronRight,AlertTriangle} from 'lucide-react';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

type ReasonPath={edges:string[];optional:boolean};
type Conflict={packageId:string;hard:boolean;edgeId:string;range:string;via:ReasonPath[]};
type Pkg={
  packageId:string;componentId:string;reached:boolean;
  effectiveLabel:string|null;requiredVersion:string|null;
  upgradeLevel:string|null;hardOnly:boolean;
  conflicts:Conflict[];constraintSources:{edgeId:string|null;range:string;hard:boolean}[];
  reasonPaths:ReasonPath[];reasonPathsTruncated:boolean;
};
type Component={id:string;members:string[];cyclic:boolean;index:number};
type Analysis={
  root:string;rootVersion:string;
  components:Component[];
  condensationEdges:{from:string;to:string;edgeIds:string[]}[];
  packages:Pkg[];conflicts:Conflict[];warnings:string[];
  diagnostics:{line:number;level:string;message:string}[];
};
type AnalyzeEnvelope={revision:number;analysis:Analysis}|{error:string;message?:string;current?:Row};

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [analysis,setAnalysis]=useState<Analysis|null>(null);
  const [analysisRevision,setAnalysisRevision]=useState<number|null>(null);
  const [status,setStatus]=useState('Ready');
  const [rootVersion,setRootVersion]=useState('1.0.0');
  // Client-only display state: collapsed component groups. It is never sent
  // to the server and cannot change node identities or propagation.
  const [collapsed,setCollapsed]=useState<Set<string>>(new Set());

  useEffect(()=>{fetch('/api/plans').then(r=>r.json()).then(setItems);},[]);

  useEffect(()=>{
    setStatus('Loading');setAnalysis(null);
    fetch('/api/plans/'+selected).then(r=>r.json()).then((value:Row)=>{
      setRow(value);setDraft(value.content);setStatus('Loaded');
    });
  },[selected]);

  const packageIds=useMemo(
    ()=>[...new Set([...draft.matchAll(/(?:^|\n)\s*package\s+([A-Za-z0-9_.-]+)/g),...draft.matchAll(/^([A-Za-z0-9_.-]+)\s*->/gm)].map(m=>m[1]))].sort(),
    [draft],
  );
  const root=analysis?.root ?? packageIds[0] ?? '';

  async function save(){
    if(!row)return;
    setStatus('Saving');
    const response=await fetch('/api/plans/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});
    const value=await response.json();
    if(!response.ok){setStatus(response.status===409?'Revision conflict — reloaded':'Save failed');return;}
    setRow(value);setStatus('Saved');
  }

  async function analyze(rootOverride?:string){
    if(!row)return;
    const chosen=rootOverride??root;
    if(!chosen)return;
    setStatus('Analyzing');
    const response=await fetch('/api/plans/'+row.id+'/analyze',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({content:draft,root:chosen,rootVersion,knownRevision:row.revision}),
    });
    const value=await response.json() as AnalyzeEnvelope;
    if(response.status===409){
      setStatus('Graph changed on the server — reloading latest revision');
      const fresh=await fetch('/api/plans/'+row.id).then(r=>r.json()) as Row;
      setRow(fresh);setDraft(fresh.content);
      setAnalysis(null);
      return;
    }
    if(!response.ok){
      const message=('message' in value&&value.message)?value.message:('error' in value?value.error:'request failed');
      setStatus('Analysis failed: '+message);
      return;
    }
    if('analysis' in value){
      setAnalysis(value.analysis);setAnalysisRevision(value.revision);
      setCollapsed(new Set(value.analysis.components.filter(c=>c.cyclic&&c.members.length>1).map(c=>c.id)));
      setStatus('Analyzed @ rev '+value.revision);
    }
  }

  const pkgById=useMemo(()=>new Map((analysis?.packages??[]).map(p=>[p.packageId,p])),[analysis]);

  function toggle(id:string){
    setCollapsed(prev=>{const next=new Set(prev);next.has(id)?next.delete(id):next.add(id);return next;});
  }

  const hardConflicts=analysis?.conflicts.filter(c=>c.hard)??[];
  const softConflicts=analysis?.conflicts.filter(c=>!c.hard)??[];
  const stale=analysis!==null&&analysisRevision!==row?.revision;

  return <main className="shell">
    <header className="topbar">
      <FlaskConical size={20}/><strong>Release Dependency Studio</strong><small>SCC-safe impact propagation</small>
    </header>
    <section className="workspace">
      <aside className="pane">
        <h2>Items</h2>
        <div className="list">
          {items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>
            {item.name}<br/><small>Revision {item.revision}</small>
          </button>)}
        </div>
      </aside>

      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/>Save</button>
          <button onClick={()=>analyze()}><Play size={15}/>Analyze impact</button>
          <label className="rootpick">root
            <select value={root} onChange={e=>analyze(e.target.value)}>
              {packageIds.map(id=><option key={id}>{id}</option>)}
            </select>
          </label>
          <label className="rootpick">version
            <input value={rootVersion} onChange={e=>setRootVersion(e.target.value)} aria-label="Root version"/>
          </label>
          <span className={stale?'status warn':'status'}>{status}{stale?' (draft newer than analysis)':''}</span>
        </div>
        <textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)} spellCheck={false}/>
        <p className="hint">Syntax: <code>package name</code>, <code>a -&gt; b ^1.0.0</code>, append <code>optional</code> for soft edges.</p>
      </section>

      <aside className="pane inspection">
        <h2>Impact</h2>
        {!analysis && <span className="pill">Run analysis</span>}
        {analysis && <>
          <div className="summary-row">
            <span className="pill"><GitBranch size={12}/> {analysis.root} @ {analysis.rootVersion}</span>
            <span className="pill">{analysis.components.filter(c=>c.cyclic).length} cyclic component(s)</span>
            <span className="pill">{analysis.packages.filter(p=>p.reached).length} impacted</span>
          </div>

          {analysis.diagnostics.length>0 && <div className="box diag">
            <strong>Parse diagnostics</strong>
            {analysis.diagnostics.map((d,i)=><div key={i} className={d.level}>line {d.line}: {d.message}</div>)}
          </div>}

          {hardConflicts.length>0 && <div className="box conflict">
            <strong><AlertTriangle size={13}/> Blocking range conflicts</strong>
            {hardConflicts.map((c,i)=><ConflictView key={i} c={c}/>)}
          </div>}
          {softConflicts.length>0 && <div className="box soft">
            <strong>Optional-only conflicts (warnings)</strong>
            {softConflicts.map((c,i)=><ConflictView key={i} c={c}/>)}
          </div>}
          {analysis.warnings.length>0 && <div className="box soft">{[...new Set(analysis.warnings)].map((w,i)=><div key={i}>{w}</div>)}</div>}

          <h3>Release train <small>(collapse is display-only)</small></h3>
          {analysis.components.map(comp=>{
            const impacted=comp.members.filter(m=>pkgById.get(m)?.reached);
            if(impacted.length===0)return null;
            const isCollapsed=collapsed.has(comp.id);
            return <div className={'scc '+(!comp.cyclic?'single':'')} key={comp.id}>
              <button className="scc-head" onClick={()=>comp.cyclic&&comp.members.length>1&&toggle(comp.id)}>
                {comp.cyclic&&comp.members.length>1?(isCollapsed?<ChevronRight size={14}/>:<ChevronDown size={14}/>):<span className="spacer"/>}
                <strong>{comp.cyclic?`Cycle group (${comp.members.length})`:'Package'}</strong>
                <code>{comp.cyclic?comp.id:comp.members[0]}</code>
              </button>
              {(!comp.cyclic||!isCollapsed) && impacted.map(id=>{
                const p=pkgById.get(id)!;
                return <div className="pkg" key={id}>
                  <div className="pkg-line">
                    <span className="pkg-name">{id}</span>
                    {p.requiredVersion && <span className="pill ver">{p.requiredVersion}</span>}
                    {p.upgradeLevel && p.upgradeLevel!=='none' && <span className={'bump '+p.upgradeLevel}>{p.upgradeLevel}</span>}
                    {!p.hardOnly && <span className="bump optional-tag">optional-only</span>}
                    {p.effectiveLabel && <code className="range">{p.effectiveLabel}</code>}
                  </div>
                  <ul className="causes">
                    {p.constraintSources.map((s,i)=><li key={i}>
                      <span className={s.hard?'edge hard':'edge soft'}>{s.edgeId??'(release pin)'}</span>
                      <code>{s.range}</code>
                    </li>)}
                  </ul>
                  {p.reasonPaths.length>0 && <details className="paths">
                    <summary>{p.reasonPaths.length} reason chain{p.reasonPaths.length===1?'':'s'}{p.reasonPathsTruncated?' (capped)':''}</summary>
                    {p.reasonPaths.map((rp,i)=> <div key={i} className={'chain '+(rp.optional?'opt':'')}>
                      {rp.edges.length===0?<em>release root</em>:rp.edges.map((e,j)=><span key={j} className="edge">{e}</span>)}
                    </div>)}
                  </details>}
                </div>;
              })}
            </div>;
          })}

          <h3>Condensation DAG</h3>
          <ul className="dag">
            {analysis.condensationEdges.map((e,i)=>
              <li key={i}><code>{e.from}</code> → <code>{e.to}</code>
                <small> {e.edgeIds.join(', ')}</small></li>)}
          </ul>
        </>}
      </aside>
    </section>
  </main>;
}

function ConflictView({c}:{c:Conflict}){
  return <div className="conflict-item">
    <div><span className="pkg-name">{c.packageId}</span>: <code>{c.range}</code> at <span className={c.hard?'edge hard':'edge soft'}>{c.edgeId}</span> incompatible with negotiated range{c.hard?'':' (optional path)'}</div>
    {c.via.slice(0,3).map((p,i)=> <div key={i} className="chain">{p.edges.length===0?<em>release root</em>:p.edges.map((e,j)=><span key={j} className="edge">{e}</span>)}</div>)}
  </div>;
}
