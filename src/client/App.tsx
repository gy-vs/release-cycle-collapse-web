import {useEffect,useState} from 'react';
import {ChevronDown,ChevronRight,FlaskConical,Play,Save} from 'lucide-react';
type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
type Diagnostic={code:string;message:string;line?:number};
type Reason={type:'release';level:string}|{type:'dependency';from:string;to:string;range:string;optional:boolean;dependencyLevel:string;dependencyVersion:string;requiredLevel:string};
type Impact={name:string;component:string;level:string;from:string;to:string;reasons:Reason[]};
type Component={id:string;members:string[];cyclic:boolean};
type Analysis={id:string;revision:number;packages:{name:string;version:string;component:string}[];components:Component[];releases:{name:string;level:string}[];impacts:Impact[];diagnostics:Diagnostic[]};
function ReasonView({reason}:{reason:Reason}){
  if(reason.type==='release')return <>released as <strong>{reason.level}</strong></>;
  return <>edge <code>{reason.from} → {reason.to}@{reason.range}</code>{reason.optional?' (optional)':''} violated by {reason.to}@{reason.dependencyVersion} ({reason.dependencyLevel}) → requires {reason.requiredLevel}</>;
}
export default function App(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [analysis,setAnalysis]=useState<Analysis|null>(null);const [status,setStatus]=useState('Ready');
  // Collapsing a component group is display-only: node identity and impact
  // results always come from the server analysis and never change here.
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({});
  useEffect(()=>{fetch('/api/plans').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{setStatus('Loading');setAnalysis(null);setCollapsed({});fetch('/api/plans/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/plans/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/plans/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  const impacts=new Map((analysis?.impacts??[]).map(impact=>[impact.name,impact]));
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Release Dependency Studio</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/><p className="hint">One statement per line: <code>package name@1.2.3</code>, <code>a -&gt; b@^1.0.0 [optional]</code>, <code>release a major</code>. <code>#</code> starts a comment.</p></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span>{analysis&&<>
    {analysis.diagnostics.length>0&&<div className="diagnostics"><h3>Diagnostics</h3><ul>{analysis.diagnostics.map((diagnostic,index)=><li key={index}><code>{diagnostic.code}</code>{diagnostic.line?` (line ${diagnostic.line})`:''} {diagnostic.message}</li>)}</ul></div>}
    <h3>Components</h3>
    {analysis.components.map(component=><section className="component" key={component.id}>
      <button className="component-header" onClick={()=>setCollapsed(value=>({...value,[component.id]:!value[component.id]}))}>
        {collapsed[component.id]?<ChevronRight size={14}/>:<ChevronDown size={14}/>}
        <strong>{component.id}</strong><span>{component.members.length} package{component.members.length===1?'':'s'}</span>{component.cyclic&&<span className="pill cycle">cycle</span>}
      </button>
      {!collapsed[component.id]&&<ul className="members">{component.members.map(member=>{const impact=impacts.get(member);return <li key={member}>
        <div className="member-head"><code>{member}</code>{impact?<><span className={'badge level-'+impact.level}>{impact.level}</span><small>{impact.from} → {impact.to}</small></>:<small>no change</small>}</div>
        {impact&&impact.reasons.length>0&&<ul className="reasons">{impact.reasons.map((reason,index)=><li key={index}><ReasonView reason={reason}/></li>)}</ul>}
      </li>})}</ul>}
    </section>)}
    <details><summary>Raw analysis</summary><pre>{JSON.stringify(analysis,null,2)}</pre></details>
  </>}</aside></section></main>;
}
