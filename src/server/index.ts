import express from 'express';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AnalysisResult, analyzeGraph, parseGraph} from './graph';

type RecordRow = {id: string; name: string; revision: number; content: string; updatedAt: string};
type AnalysisResponse = AnalysisResult & {id: string; revision: number};

const defaultRows: RecordRow[] = [
  {
    id: 'alpha',
    name: 'Primary package graphs',
    revision: 3,
    content: [
      '# package <name>@<version>',
      '# <from> -> <to>[@<range>] [optional]',
      '# release <name> <patch|minor|major>',
      'package alpha@1.0.0',
      'package beta@1.0.0',
      'package gamma@2.0.0',
      'package delta@1.4.0',
      'alpha -> beta@^1.0.0',
      'beta -> alpha@^1.0.0',
      'gamma -> alpha@^1.0.0',
      'delta -> gamma@^2.0.0 optional',
      'release alpha major',
      '',
    ].join('\n'),
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'beta',
    name: 'Secondary package graphs',
    revision: 5,
    content: ['package web@3.2.0', 'package ui@1.8.0', 'web -> ui@^1.5.0', 'release ui minor', ''].join('\n'),
    updatedAt: new Date(1000).toISOString(),
  },
];

export function createApp(rows: RecordRow[] = defaultRows) {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  // Analysis results are pure functions of (graph content, releases), so they
  // are cached per (plan, revision, content). A PUT bumps the revision, which
  // changes the key and therefore invalidates any stale analysis.
  const analysisCache = new Map<string, AnalysisResponse>();

  app.get('/api/bootstrap', (_req, res) => res.json({family: 'release-dependency', count: rows.length}));
  app.get('/api/plans', (_req, res) => res.json(rows.map(({content, ...row}) => row)));
  app.get('/api/plans/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/plans/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const body = req.body ?? {};
    if (body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/plans/:id/analyze', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const body = req.body ?? {};
    if (body.revision !== undefined && body.revision !== row.revision) {
      return res.status(409).json({error: 'revision_conflict', current: {id: row.id, revision: row.revision}});
    }
    const content = String(body.content ?? row.content);
    const key = `${row.id}:${row.revision}:${createHash('sha1').update(content).digest('hex')}`;
    let result = analysisCache.get(key);
    if (!result) {
      result = {id: row.id, revision: row.revision, ...analyzeGraph(parseGraph(content))};
      analysisCache.set(key, result);
    }
    res.json(result);
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
