import express from 'express';
import {fileURLToPath} from 'node:url';
import {parseGraph,analyzeImpact,GraphError,formatInterval,type AnalyzeGraphResponse} from '../shared/graph';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};

const rows: RecordRow[] = [
  {
    id:'alpha',name:'Primary package graphs',revision:3,updatedAt:new Date(0).toISOString(),
    content:[
      '# release train around "web"',
      'package web',
      'web -> core ^1.0.0',
      'core -> web ^1.0.0',
      'core -> util >=1.2.0',
      'web -> util <1.5.0',
      'util -> util ^1.0.0',
      'util -> json ^2.0.0',
      'web -> trace ^3.0.0 optional',
    ].join('\n'),
  },
  {
    id:'beta',name:'Secondary package graphs',revision:5,updatedAt:new Date(1000).toISOString(),
    content:[
      'package app',
      'app -> lib ^1.0.0',
      'lib -> app ^1.0.0',
      'lib -> zed ^1.0.0',
      'app -> zed ^2.0.0',
    ].join('\n'),
  },
];

function publicRow(row:RecordRow){
  const {content,...rest}=row;
  return rest;
}

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));

  app.get('/api/bootstrap',(_req,res)=>res.json({family:'release-dependency',count:rows.length}));
  app.get('/api/plans',(_req,res)=>res.json(rows.map(publicRow)));

  app.get('/api/plans/:id',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    res.set('ETag',String(row.revision)).json(row);
  });

  app.put('/api/plans/:id',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    if(req.body.revision!==row.revision){
      return res.status(409).json({error:'revision_conflict',current:row});
    }
    row.content=String(req.body.content??'');
    row.revision+=1;
    row.updatedAt=new Date().toISOString();
    res.json(row);
  });

  // Graph-aware impact analysis.  Node identities in the response are always
  // package names; SCC grouping is metadata only, so client expand/collapse
  // state can never change what the server propagates.
  app.post('/api/plans/:id/analyze',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});

    const knownRevision=typeof req.body?.knownRevision==='number'?req.body.knownRevision:undefined;
    if(knownRevision!==undefined&&knownRevision!==row.revision){
      return res.status(409).json({error:'revision_conflict',current:publicRow(row)});
    }

    const content=typeof req.body?.content==='string'?req.body.content:row.content;
    const root=String(req.body?.root??'');
    const rootVersion=req.body?.rootVersion===undefined?undefined:String(req.body.rootVersion);

    const graph=parseGraph(content);
    let analysis:AnalyzeGraphResponse;
    try{
      analysis=analyzeImpact(graph,root,rootVersion);
    }catch(err){
      if(err instanceof GraphError)return res.status(400).json({error:err.code,message:err.message,diagnostics:graph.diagnostics});
      throw err;
    }
    res.json({
      id:row.id,
      revision:row.revision,
      // the revision the analysis was computed against, so the client can
      // notice a graph revision change and refetch instead of showing stale
      // causes.
      analyzedAt:new Date().toISOString(),
      analysis:serialize(analysis),
    });
  });

  return app;
}

// Intervals are plain structural JSON; this stays explicit so the wire shape
// is documented in one place.
function serialize(r:AnalyzeGraphResponse){
  return {
    ...r,
    rootVersion:`${r.rootVersion.major}.${r.rootVersion.minor}.${r.rootVersion.patch}`,
    packages:r.packages.map(p=>({
      ...p,
      effectiveLabel:p.effective?formatInterval(p.effective):null,
      requiredVersion:p.requiredVersion?`${p.requiredVersion.major}.${p.requiredVersion.minor}.${p.requiredVersion.patch}`:null,
    })),
  };
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'));
}
