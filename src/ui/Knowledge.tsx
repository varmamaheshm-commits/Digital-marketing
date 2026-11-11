import { useEffect, useMemo, useState } from 'react';
import { agentModel } from '../core/actions';
import { aiAnswer } from '../core/agents';
import { copyText } from '../core/files';
import { draftAnswer, passages, search } from '../core/knowledge';
import { put, remove, useStore } from '../core/store';
import { uid, type KnowledgeDoc } from '../core/types';
import { Empty, Field, fmtDate, Icon, Modal, toast } from './common';

export function Knowledge() {
  const { data, settings } = useStore();
  const [edit, setEdit] = useState<KnowledgeDoc | null>(null);
  const [q, setQ] = useState('');
  const hits = useMemo(() => (q.trim().length > 2 ? search(data.knowledge, q) : []), [data.knowledge, q]);
  const [ai, setAi] = useState<{ q: string; text: string } | null>(null);
  const [thinking, setThinking] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => { if (settings.ai.agents.answers) void agentModel().then(setModel); else setModel(null); }, [settings.ai]);
  const answer = ai && ai.q === q ? ai.text : q.trim().length > 2 ? draftAnswer(hits, settings) : '';
  async function askAi() {
    if (!model) return;
    setThinking(true);
    try { setAi({ q, text: await aiAnswer(model, q, hits, settings) }); } catch (e: any) { toast(String(e?.message ?? e)); }
    setThinking(false);
  }

  async function importFiles(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      const text = (await f.text()).slice(0, 400_000);
      if (text.trim()) await put('knowledge', { id: uid(), title: f.name.replace(/\.[^.]+$/, ''), text, createdAt: Date.now() });
    }
    toast('Added to your knowledge base');
  }

  return (
    <>
      <div className="head">
        <div className="grow"><h1>Knowledge base</h1><p>Your price lists, FAQs and policies. Ask a question and get an answer drawn only from your own documents.</p></div>
        <label className="btn">Import text files<input type="file" accept=".txt,.md,.csv,text/*" multiple hidden onChange={(e) => { void importFiles(e.target.files); e.target.value = ''; }} /></label>
        <button className="btn primary" data-testid="add-doc" onClick={() => setEdit({ id: uid(), title: '', text: '', createdAt: Date.now() })}><Icon name="plus" /> Add document</button>
      </div>
      <div className="grid g2">
        <div className="card stack">
          <h2>Ask your documents</h2>
          <input data-testid="kb-question" placeholder="e.g. What is the return policy?" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Question" />
          {q.trim().length > 2 && hits.length === 0 && <div className="notice warn">Nothing in your documents matches this question yet.</div>}
          {hits.map((h, i) => (
            <div className="notice" key={i} data-testid="kb-hit"><b>{h.title}</b><div className="pre">{h.text}</div></div>
          ))}
          {hits.length > 0 && (
            <>
              <h3>Suggested reply</h3>
              <div className="pre card">{answer}</div>
              <div className="row">
                <button className="btn small" onClick={async () => { await copyText(answer); toast('Reply copied'); }}><Icon name="copy" size={15} /> Copy reply</button>
                {model && <button className="btn small primary" data-testid="kb-ai" disabled={thinking} onClick={askAi}><Icon name="bolt" size={15} /> {thinking ? 'Writing…' : 'Write with AI agent'}</button>}
              </div>
            </>
          )}
        </div>
        <div className="stack">
          {data.knowledge.length === 0 && <Empty title="No documents yet">Add your price list, delivery and return policy, and common questions.</Empty>}
          {[...data.knowledge].sort((a, b) => b.createdAt - a.createdAt).map((d) => (
            <div className="card stack" key={d.id}>
              <div className="row between"><b>{d.title || 'Untitled'}</b><small>{fmtDate(d.createdAt)} · {passages(d).length} passage(s)</small></div>
              <div className="pre clamp muted">{d.text}</div>
              <div><button className="btn small" onClick={() => setEdit(d)}>Edit</button></div>
            </div>
          ))}
        </div>
      </div>
      {edit && (
        <Modal title="Document" onClose={() => setEdit(null)}
          footer={
            <>
              {data.knowledge.some((d) => d.id === edit.id) && <button className="btn danger" onClick={async () => { if (confirm('Delete this document?')) { await remove('knowledge', edit.id); setEdit(null); } }}><Icon name="trash" /> Delete</button>}
              <button className="btn primary" data-testid="save-doc" onClick={async () => { if (edit.text.trim()) { await put('knowledge', { ...edit, title: edit.title.trim() || 'Untitled' }); setEdit(null); } }}>Save</button>
            </>
          }>
          <div className="stack">
            <Field label="Title"><input data-testid="doc-title" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} autoFocus /></Field>
            <Field label="Text" hint="Paste or type. Leave a blank line between topics."><textarea data-testid="doc-text" rows={12} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
