// Knowledge management: ingest documents, inspect the RAG pipeline, test retrieval.
import { useState } from 'react';
import { DEL, fmtDate, fmtNum, GET, POST } from '../api.ts';
import { Fields, Workspace, useAction, useLoad, type EditorProps } from '../ui.tsx';

const PIPELINE = ['Ingestion', 'Chunking', 'Embedding', 'Vector store', 'Retrieval', 'Ranking', 'Generation'];
const TEXT_TYPES = /\.(txt|md|markdown|csv|tsv|json|html?|xml|log|ya?ml)$/i;

function KbEditor({ res, data, set, readOnly }: EditorProps) {
  const { data: docs, reload } = useLoad(() => GET<any[]>(`/kb/${res.id}/documents`), [res.id]);
  const [paste, setPaste] = useState({ name: '', text: '', url: '' });
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const [last, setLast] = useState<any>(null);
  const { busy, act } = useAction();
  const add = (body: any) => act(async () => { setLast(await POST(`/kb/${res.id}/documents`, body)); setPaste({ name: '', text: '', url: '' }); reload(); }, 'Document indexed');
  const upload = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) {
      if (!TEXT_TYPES.test(f.name) && !f.type.startsWith('text/')) { await act(async () => { throw new Error(`${f.name}: only text formats can be read here (txt, md, csv, json, html). Export PDF, Word and Excel files to text or CSV first.`); }); continue; }
      await add({ name: f.name, text: await f.text() });
    }
  };
  const chunks = docs?.reduce((a, d) => a + d.chunks, 0) ?? 0;
  return (
    <div className="col">
      <div className="card col">
        <h3>Pipeline</h3>
        <div className="pipeline">{PIPELINE.map((p, i) => <span key={p} className="row" style={{ gap: 4 }}>{i > 0 && <span className="arrow">&rarr;</span>}<span className="badge info">{p}</span></span>)}</div>
        <p className="muted small">Documents are split into overlapping chunks, embedded on this server (512-dimension hashed word and phrase vectors), and stored. A question is embedded the same way; the closest chunks are re-ranked by keyword overlap and handed to the agent's model, which writes the answer. {docs?.length ?? 0} document(s), {fmtNum(chunks)} chunk(s) indexed.</p>
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
          <Fields columns={3} value={data} onChange={(v) => set(v)} defs={[{ key: 'description', label: 'Description' }, { key: 'chunkSize', label: 'Chunk size (characters)', kind: 'number', placeholder: '900' }, { key: 'overlap', label: 'Overlap (characters)', kind: 'number', placeholder: '150' }]} />
        </fieldset>
      </div>
      <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <div className="col">
          {!readOnly && (
            <div className="card col">
              <h3>Add sources</h3>
              <label className="field">Upload text files<input type="file" multiple accept=".txt,.md,.csv,.tsv,.json,.html,.htm,.xml,.log,.yaml,.yml,text/*" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} /><small>Text, Markdown, CSV, JSON and HTML. Up to 2 MB of text per document.</small></label>
              <div className="row"><input aria-label="Web page address" placeholder="https://example.com/policy" value={paste.url} onChange={(e) => setPaste({ ...paste, url: e.target.value })} /><button className="btn" disabled={busy || !paste.url.trim()} onClick={() => void add({ url: paste.url })}>Fetch page</button></div>
              <label className="field">Or paste text<input placeholder="Document name" value={paste.name} onChange={(e) => setPaste({ ...paste, name: e.target.value })} /><textarea rows={4} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} /></label>
              <div><button className="btn primary" disabled={busy || !paste.text.trim()} onClick={() => void add({ name: paste.name || 'Pasted text', text: paste.text })}>Index text</button></div>
              {last && <div className={`notice ${last.injection.length ? 'warn' : 'good'} small`}>Indexed {last.chunks} chunk(s) from {fmtNum(last.characters)} characters.{last.pii ? ` ${last.pii} personal-data value(s) detected${last.masked ? ' and masked' : ''}.` : ''}{last.injection.length ? ` Instruction-like text was found (${last.injection.join(', ')}); such passages are withheld from agents at retrieval time.` : ''}</div>}
            </div>
          )}
          <div className="table-wrap"><table>
            <thead><tr><th>Document</th><th className="num">Chunks</th><th className="num">Characters</th><th>Added</th><th /></tr></thead>
            <tbody>
              {docs?.map((d) => <tr key={d.doc_id}><td>{d.doc_name}</td><td className="num">{d.chunks}</td><td className="num">{fmtNum(d.characters)}</td><td className="small muted">{fmtDate(d.created_at)}</td><td>{!readOnly && <button className="btn sm ghost danger" onClick={() => confirm(`Remove "${d.doc_name}" from the index?`) && act(async () => { await DEL(`/kb/${res.id}/documents/${d.doc_id}`); reload(); })}>Remove</button>}</td></tr>)}
              {docs && !docs.length && <tr><td colSpan={5} className="muted">No documents yet.</td></tr>}
            </tbody>
          </table></div>
        </div>
        <div className="card col">
          <h3>Test retrieval</h3>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => setHits(await POST(`/kb/${res.id}/search`, { query }))); }}>
            <input aria-label="Question" placeholder="Ask a question your documents should answer" value={query} onChange={(e) => setQuery(e.target.value)} /><button className="btn primary" disabled={busy || !query.trim()}>Search</button>
          </form>
          {hits && !hits.length && <p className="muted">No passage matched. An agent would say it has no source for this question.</p>}
          {hits?.map((h, i) => (
            <div key={i} className="card flat col" style={{ gap: 4 }}>
              <div className="row spread small"><b>{h.docName} · chunk {h.seq + 1}</b><span className="muted num">score {h.score.toFixed(2)} (vector {h.vector.toFixed(2)}, keywords {h.keyword.toFixed(2)})</span></div>
              <p className="small">{h.text.slice(0, 600)}{h.text.length > 600 ? '...' : ''}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const Knowledge = ({ id }: { id?: string }) => (
  <Workspace kind="kb" id={id} base="/knowledge" title="Knowledge" noun="knowledge base" blurb="Give agents your documents. Each knowledge base is a searchable index that agents query before they answer."
    blank={() => ({ description: '', chunkSize: 900, overlap: 150 })} Editor={KbEditor} describe={(r) => r.data.description || ''} />
);
