import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, useParams, Link, Router as WouterRouter } from 'wouter';
import { useAuth } from '@workspace/replit-auth-web';
import { useGetDashboardSummary, useGetDrafts, useCreateDraft, useGetDraft, getGetDraftQueryKey, getGetDraftsQueryKey, getGetDashboardSummaryQueryKey, useUpdateDraft, useDeleteDraft, useCreateDraftShare, useUpdateComment, useGetReview, getGetReviewQueryKey, useCreateReviewComment, useRequestUploadUrl, useClaimUploadedObject } from '@workspace/api-client-react';
import type { Draft, DraftPage, ReviewComment } from '@workspace/api-client-react';
import { ArrowDown, ArrowLeft, ArrowUpRight, Check, CheckCircle2, ChevronRight, CircleHelp, Clipboard, Clock3, FileImage, ImagePlus, LoaderCircle, LogOut, MessageCircle, PanelTop, Plus, Share2, Split, Upload, X } from 'lucide-react';

const queryClient = new QueryClient();
const cx = (...x: Array<string | false | undefined>) => x.filter(Boolean).join(' ');
const prettyDate = (value: string) => new Intl.DateTimeFormat('en', { month:'short', day:'numeric', year:'numeric' }).format(new Date(value));
const statusLabel = (s: string) => s === 'in_review' ? 'In review' : s === 'approved' ? 'Approved' : 'Draft';
const Status = ({ value }: { value: string }) => <span className={cx('status', value)}><i />{statusLabel(value)}</span>;
const Btn = ({ children, onClick, variant='solid', disabled=false, type='button', testid }: {children:ReactNode;onClick?:()=>void;variant?:string;disabled?:boolean;type?:'button'|'submit';testid?:string}) => <button data-testid={testid} type={type} onClick={onClick} disabled={disabled} className={`btn ${variant}`}>{children}</button>;

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return <div className="min-h-[100dvh] paper-grain">
    <aside className="rail">
      <Link href="/" className="brand"><span className="brand-mark"><PanelTop size={19}/></span><span>panelproof<small>CREATOR STUDIO</small></span></Link>
      <div className="rail-label">WORKSPACE</div><Link href="/" className="rail-link selected"><span className="rail-icon"><FileImage size={17}/></span>Episodes</Link>
      <div className="rail-bottom"><div className="tiny-avatar">{user?.firstName?.[0] || user?.email?.[0] || 'C'}</div><div className="profile"><b>{user?.firstName || 'Creator'}</b><span>Studio account</span></div><button className="icon-button" aria-label="Log out" onClick={logout}><LogOut size={16}/></button></div>
    </aside>
    <main className="main">{children}</main>
  </div>
}

function Login() {
  const { login, isLoading } = useAuth();
  return <div className="login-page"><div className="login-card"><div className="brand"><span className="brand-mark"><PanelTop size={19}/></span><span>panelproof<small>CREATOR STUDIO</small></span></div><div className="login-stamp">A QUIETER WAY TO PROOF</div><h1 className="serif">Your story,<br/><em>panel by panel.</em></h1><p>Split long artwork into reader-ready pages. Share a proof, gather notes, and get back to drawing.</p><Btn onClick={login} disabled={isLoading}>{isLoading ? 'Getting your studio ready…' : 'Enter your studio'} <ArrowUpRight size={16}/></Btn><span className="login-foot">Private workspace · Editor links stay yours</span></div><div className="login-art"><div className="fake-comic"><div className="comic-head">A SMALL<br/>STORY ABOUT<br/>THE WEATHER</div><div className="comic-sun"/><div className="comic-horizon"/><span>01 / 08</span></div><div className="art-caption mono">READ DOWN<br/>NOT ACROSS <ArrowDown size={14}/></div></div></div>
}

function Dashboard() {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const summaryQ = useGetDashboardSummary();
  const draftsQ = useGetDrafts();
  const summary = summaryQ.data;
  const drafts = draftsQ.data || [];
  const [showComposer, setShowComposer] = useState(false);
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const createDraft = useCreateDraft();
  const requestUpload = useRequestUploadUrl();
  const claimObject = useClaimUploadedObject();
  const qc = useQueryClient();
  const busy = createDraft.isPending || requestUpload.isPending || claimObject.isPending;
  if (isLoading) return <LoadingScreen/>;
  if (!isAuthenticated) return <Login/>;
  const handleFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const selected = Array.from(incoming);
    const accepted = selected.filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type));
    setFiles(accepted.sort((a,b)=>a.name.localeCompare(b.name, undefined, {numeric:true})));
    setUploadError(accepted.length === selected.length ? '' : 'Use JPG, PNG, or WebP artwork.');
  };
  async function makeDraft(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setUploadError('');
    if (!title.trim() || !files.length) return;
    try {
      const pages: DraftPage[] = [];
      for (const file of files) {
        const img = new Image(); img.src = URL.createObjectURL(file);
        await new Promise<void>((resolve, reject) => { img.onload=()=>resolve(); img.onerror=()=>reject(new Error(`Could not read ${file.name}`)); });
        const scale = 800 / img.naturalWidth;
        const outputHeight = Math.ceil(img.naturalHeight * scale);
        for (let y=0; y<outputHeight; y+=1280) {
          const height = Math.min(1280, outputHeight-y);
          const canvas = document.createElement('canvas'); canvas.width=800; canvas.height=height;
          const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Could not split this artwork.');
          ctx.drawImage(img,0,y/scale,img.naturalWidth,height/scale,0,0,800,height);
          const blob = await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Image export failed.')),'image/png'));
          const pageFile = new File([blob], `${file.name.replace(/\.[^.]+$/,'')}-${String(pages.length+1).padStart(2,'0')}.png`, {type:'image/png'});
          const requested = await requestUpload.mutateAsync({data:{name:pageFile.name,size:pageFile.size,contentType:pageFile.type}});
          const put = await fetch(requested.uploadURL,{method:'PUT',headers:{'Content-Type':pageFile.type},body:pageFile});
          if (!put.ok) throw new Error('Upload failed. Please try again.');
          await claimObject.mutateAsync({data:{objectPath:requested.objectPath}});
          pages.push({objectPath:requested.objectPath,width:800,height});
        }
        URL.revokeObjectURL(img.src);
      }
      const draft=await createDraft.mutateAsync({data:{title:title.trim(),pages}});
      await Promise.all([qc.invalidateQueries({queryKey:getGetDraftsQueryKey()}),qc.invalidateQueries({queryKey:getGetDashboardSummaryQueryKey()})]);
      setLocation(`/draft/${draft.id}`);
    } catch (err) { setUploadError(err instanceof Error ? err.message : 'Something went wrong while uploading.'); }
  }
  return <Shell><header className="topline"><div><div className="eyebrow">YOUR WORKSPACE <span className="dot"/> {new Date().toLocaleDateString('en',{weekday:'long',month:'long',day:'numeric'})}</div><h1 className="serif">Good stories need <em>good margins.</em></h1><p className="subhead">A clear place to prepare, share, and refine your next episode.</p></div><div className="top-actions"><span className="saved-note"><span/> All changes saved</span><Btn onClick={()=>setShowComposer(true)}><Plus size={17}/> New episode</Btn></div></header>
    <section className="stats-row">
      <Metric label="Episodes" value={summaryQ.isLoading?'—':summary?.episodeCount ?? drafts.length} icon={<PanelTop size={16}/>} foot="in your studio"/>
      <Metric label="In proof" value={summaryQ.isLoading?'—':summary?.inReviewCount ?? drafts.filter(d=>d.status==='in_review').length} icon={<Clock3 size={16}/>} foot="waiting on a read"/>
      <Metric label="Open notes" value={summaryQ.isLoading?'—':summary?.openCommentCount ?? drafts.reduce((a,d)=>a+d.commentCount-d.resolvedCount,0)} icon={<MessageCircle size={16}/>} foot="to take a look at"/>
    </section>
    <section className="section-heading"><div><span className="section-kicker">IN THE STUDIO</span><h2 className="serif">Recent episodes</h2></div><span className="section-count mono">{drafts.length.toString().padStart(2,'0')} TOTAL</span></section>
    {draftsQ.isLoading ? <div className="episode-list">{[0,1,2].map(i=><div className="skeleton-row" key={i}/>)}</div> : draftsQ.isError ? <div className="empty-panel"><p>Episodes could not be loaded.</p><Btn variant="outline" onClick={()=>draftsQ.refetch()}>Try again</Btn></div> : drafts.length ? <div className="episode-list">{drafts.map((d,i)=><EpisodeRow draft={d} index={i} key={d.id}/>)}</div> : <div className="empty-panel"><div className="empty-icon"><ImagePlus size={23}/></div><h3 className="serif">A blank page is a beginning.</h3><p>Upload your long-form artwork and PanelProof will split it into reader-ready panels.</p><Btn onClick={()=>setShowComposer(true)}><Plus size={17}/> Prepare an episode</Btn></div>}
    <footer className="dashboard-footer"><span><CircleHelp size={14}/> Artwork is split into 1280px-high reading panels.</span><span className="mono">PANELPROOF / 01</span></footer>
    {showComposer && <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setShowComposer(false)}}><form className="composer" onSubmit={makeDraft}><div className="modal-top"><div><span className="section-kicker">NEW EPISODE</span><h2 className="serif">Set the scene.</h2></div><button type="button" className="icon-button" onClick={()=>setShowComposer(false)} aria-label="Close"><X size={18}/></button></div><label className="field-label">Episode title<input data-testid="input-episode-title" value={title} onChange={e=>setTitle(e.target.value)} maxLength={180} placeholder="The rain between us" required /></label><div className="field-label">Upload artwork <span className="field-help">Tall pages or 800px-wide long canvases</span></div><button type="button" className="dropzone" onClick={()=>fileRef.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();handleFiles(e.dataTransfer.files)}}><Upload size={22}/><b>{files.length ? `${files.length} image${files.length===1?'':'s'} selected` : 'Choose images or drop them here'}</b><span>PNG, JPG, WEBP · arranged by filename</span></button><input ref={fileRef} className="hidden" type="file" accept="image/*" multiple onChange={e=>handleFiles(e.target.files)}/>{files.length>0&&<div className="file-list">{files.map(f=><span key={f.name}><FileImage size={14}/>{f.name}</span>)}</div>}<div className="split-note"><Split size={16}/><span>Long artwork is sliced at <b>1280px</b> per panel. Your original width is preserved.</span></div>{uploadError&&<p className="error-text">{uploadError}</p>}<div className="modal-actions"><Btn variant="outline" onClick={()=>setShowComposer(false)} disabled={busy}>Cancel</Btn><Btn type="submit" disabled={busy||!title.trim()||!files.length}>{busy?<><LoaderCircle className="spin" size={16}/> Preparing…</>:<>Split & create <ChevronRight size={16}/></>}</Btn></div></form></div>}
  </Shell>
}

function Metric({label,value,icon,foot}:{label:string;value:number|string;icon:ReactNode;foot:string}) { return <div className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{foot}</small></div> }
function EpisodeRow({draft,index}:{draft:Draft;index:number}) { return <Link href={`/draft/${draft.id}`} className="episode-row" data-testid={`row-episode-${draft.id}`}><div className="episode-no mono">{String(index+1).padStart(2,'0')}</div><div className="cover-thumb"><div className="cover-stripe" style={{transform:`rotate(${index%2?'-':'+'}18deg)`}}/><span>{draft.pages.length.toString().padStart(2,'0')}<small> PANELS</small></span></div><div className="episode-title"><b>{draft.title}</b><span>Updated {prettyDate(draft.updatedAt)}</span></div><div className="episode-pages mono">{draft.pages.length} {draft.pages.length===1?'page':'pages'}</div><Status value={draft.status}/><div className="episode-comments"><MessageCircle size={14}/>{Math.max(0,draft.commentCount-draft.resolvedCount)}</div><ChevronRight className="row-arrow" size={17}/></Link> }
function LoadingScreen(){return <div className="loading-screen"><span className="brand-mark"><PanelTop size={19}/></span><div className="loading-line"/></div>}
function RoutedBoundary({children}:{children:ReactNode}){const [loc]=useLocation();return <ErrorBoundary resetKey={loc}>{children}</ErrorBoundary>}

function DraftPageView() {
  const {draftId=''}=useParams<{draftId:string}>();
  const auth=useAuth();
  const q=useGetDraft(draftId,{query:{enabled:!!draftId,queryKey:getGetDraftQueryKey(draftId)}});
  const update=useUpdateDraft();const remove=useDeleteDraft();const share=useCreateDraftShare();const updateComment=useUpdateComment();const qc=useQueryClient();
  const draft=q.data;
  const [copied,setCopied]=useState(false);
  const refresh=()=>{qc.invalidateQueries({queryKey:getGetDraftQueryKey(draftId)});qc.invalidateQueries({queryKey:getGetDraftsQueryKey()});qc.invalidateQueries({queryKey:getGetDashboardSummaryQueryKey()});};
  if(auth.isLoading||q.isLoading)return <Shell><LoadingRows/></Shell>;
  if(!auth.isAuthenticated)return <Login/>;
  if(q.isError||!draft)return <Shell><div className="empty-panel"><p>We couldn't open this episode.</p><Btn variant="outline" onClick={()=>q.refetch()}>Try again</Btn></div></Shell>;
  async function copyLink(){if(!draft?.shareUrl)return;await navigator.clipboard.writeText(draft.shareUrl);setCopied(true);window.setTimeout(()=>setCopied(false),1800)}
  const publicUrl=draft.shareUrl?new URL(draft.shareUrl,window.location.origin).pathname:draft.shareUrl;
  return <Shell><div className="back-row"><Link href="/" className="back-link"><ArrowLeft size={15}/> All episodes</Link><span className="mono">EPISODE / {draft.id.slice(0,8).toUpperCase()}</span></div><header className="draft-header"><div><div className="eyebrow">EPISODE WORKSPACE <span className="dot"/> UPDATED {prettyDate(draft.updatedAt).toUpperCase()}</div><h1 className="serif">{draft.title}</h1><div className="draft-meta"><Status value={draft.status}/><span>{draft.pages.length} reading panels</span><span className="meta-sep">·</span><span>{draft.commentCount-draft.resolvedCount} open notes</span></div></div><div className="top-actions"><Btn variant="outline" onClick={()=>{if(confirm('Delete this episode and its review link?'))remove.mutate({draftId},{onSuccess:()=>{refresh();window.location.href='/';}})}} disabled={remove.isPending}>Delete</Btn>{draft.status!=='approved'&&<Btn variant="outline" onClick={()=>update.mutate({draftId,data:{status:draft.status==='draft'?'in_review':'approved'}},{onSuccess:refresh})} disabled={update.isPending}>{draft.status==='draft'?'Send to review':'Mark approved'}</Btn>}<Btn onClick={()=>share.mutate({draftId},{onSuccess:()=>{refresh();}})} disabled={share.isPending}><Share2 size={16}/>{draft.shareEnabled?'Refresh proof link':'Create proof link'}</Btn></div></header>
    <div className="draft-columns"><section className="draft-main"><div className="preview-heading"><div><span className="section-kicker">READING ORDER</span><h2 className="serif">The scroll preview</h2></div><span className="mono page-dim">{draft.pages.length} PANELS</span></div><div className="panel-stack">{draft.pages.map((page,i)=><article className="panel-item" key={`${page.objectPath}-${i}`}><div className="panel-index mono"><span>{String(i+1).padStart(2,'0')}</span><span>{page.width} × {page.height}</span></div><img src={`/api/storage/objects/${page.objectPath.replace(/^\/objects\//,'')}`} alt={`Episode panel ${i+1}`} loading="lazy"/></article>)}</div></section>
      <aside className="review-sidebar"><div className="share-card"><span className="section-kicker">EDITOR PROOF</span><h3 className="serif">A second set<br/>of eyes.</h3><p>Share a private reading link. Editors can leave notes without an account.</p>{draft.shareEnabled&&draft.shareUrl?<><div className="link-box"><span>{publicUrl}</span><button onClick={copyLink} aria-label="Copy proof link">{copied?<Check size={15}/>:<Clipboard size={15}/>}</button></div><Link className="text-link" href={publicUrl||'#'}>Open reader view <ArrowUpRight size={13}/></Link></>:<div className="share-off">No proof link yet</div>}<div className="card-divider"/><div className="share-state"><span className={cx('share-state-dot',draft.shareEnabled&&'on')}/><span><b>Proof link {draft.shareEnabled?'active':'not created'}</b><small>{draft.shareEnabled?'Anyone with the link can read and comment.':'Create a link when you are ready for feedback.'}</small></span></div></div>
        <div className="comments-panel"><div className="comments-title"><div><span className="section-kicker">FEEDBACK</span><h3 className="serif">Editor notes</h3></div><span className="comment-count">{draft.comments?.length||0}</span></div>{draft.comments?.length?draft.comments.map(c=><CommentCard comment={c} key={c.id} onResolve={()=>updateComment.mutate({draftId,commentId:c.id,data:{resolved:!c.resolved}},{onSuccess:refresh})}/>):<div className="comments-empty"><MessageCircle size={18}/><p>No notes yet. Once an editor shares feedback, it will show up here.</p></div>}</div>
      </aside></div>
  </Shell>
}
function CommentCard({comment,onResolve}:{comment:ReviewComment;onResolve:()=>void}) { return <article className={cx('comment-card',comment.resolved&&'resolved')}><div className="comment-top"><span className="comment-avatar">{comment.reviewerName.slice(0,1).toUpperCase()}</span><span className="comment-author">{comment.reviewerName}</span><span className="comment-date">{prettyDate(comment.createdAt)}</span></div><span className="comment-page">PANEL {String(comment.pageIndex+1).padStart(2,'0')}</span><p>{comment.body}</p><button className="resolve-btn" onClick={onResolve}>{comment.resolved?<><CheckCircle2 size={14}/> Resolved · reopen</>:<><Check size={14}/> Mark resolved</>}</button></article> }
function LoadingRows(){return <div className="loading-rows"><div/><div/><div/></div>}

function ReviewPageView() {
  const {shareToken=''}=useParams<{shareToken:string}>();
  const q=useGetReview(shareToken,{query:{enabled:!!shareToken,queryKey:getGetReviewQueryKey(shareToken)}});
  const add=useCreateReviewComment();
  const [pageIndex,setPageIndex]=useState(0);
  const [name,setName]=useState('');const [body,setBody]=useState('');const [notice,setNotice]=useState('');
  const review=q.data;const comments=review?.comments||[];
  const page=review?.pages[Math.min(pageIndex,Math.max((review?.pages.length||1)-1,0))];
  if(q.isLoading)return <div className="reader-loading"><div className="reader-skeleton"/></div>;
  if(q.isError||!review)return <div className="reader-error"><span className="brand-mark"><PanelTop size={19}/></span><h1 className="serif">This proof isn't available.</h1><p>The link may have expired or been turned off by its creator.</p></div>;
  function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setNotice('');if(!body.trim()||!name.trim()||!page)return;add.mutate({shareToken,data:{reviewerName:name.trim(),pageIndex:page.index,body:body.trim()}},{onSuccess:()=>{setBody('');setNotice('Your note has been added. Thank you for reading.');q.refetch()},onError:()=>setNotice('Your note could not be sent. Please try again.')})}
  return <div className="reader"><header className="reader-top"><Link href="/" className="reader-brand"><span className="brand-mark"><PanelTop size={17}/></span><b>panelproof</b></Link><span className="reader-label">A PRIVATE PROOF</span></header><div className="reader-content"><div className="reader-intro"><span className="eyebrow">FOR YOUR EYES, THEN YOUR NOTES</span><h1 className="serif">{review.title}</h1><div className="reader-sub"><Status value={review.status}/><span>{review.pages.length} panels</span><span className="dot"/> Scroll to read at your own pace</div></div>
    <div className="reader-paper">{review.pages.map((p,i)=><figure className={cx('reader-panel',p.index===page?.index&&'active-panel')} key={p.index}><div className="reader-panel-num mono">PANEL {String(i+1).padStart(2,'0')}</div><img src={p.imageUrl} alt={`Panel ${i+1} from ${review.title}`} loading="lazy"/>{comments.filter(c=>c.pageIndex===p.index).length>0&&<span className="reader-note-marker"><MessageCircle size={12}/>{comments.filter(c=>c.pageIndex===p.index).length}</span>}</figure>)}</div>
    <section className="reader-feedback"><div className="feedback-head"><span className="section-kicker">THE MARGIN IS YOURS</span><h2 className="serif">Leave a note.</h2><p>Something unclear, a typo, a thought to share? Your note goes straight to the creator.</p></div><div className="page-select"><label htmlFor="feedback-page">ON PANEL</label><select id="feedback-page" value={pageIndex} onChange={e=>setPageIndex(Number(e.target.value))}>{review.pages.map((p,i)=><option value={i} key={p.index}>Panel {String(i+1).padStart(2,'0')}</option>)}</select><span className="select-chevron"><ChevronRight size={14}/></span></div><form className="feedback-form" onSubmit={submit}><label>Your name<input data-testid="input-reviewer-name" value={name} onChange={e=>setName(e.target.value)} maxLength={80} placeholder="How should we credit you?" required/></label><label>Your note<textarea data-testid="input-review-comment" value={body} onChange={e=>setBody(e.target.value)} maxLength={2000} rows={4} placeholder="Share a specific thought…" required/></label>{notice&&<p className={cx('notice',notice.startsWith('Your note has')?'success':'error-text')}>{notice}</p>}<Btn type="submit" disabled={add.isPending||!name.trim()||!body.trim()}>{add.isPending?<><LoaderCircle className="spin" size={16}/> Sending…</>:<>Send note <ArrowUpRight size={15}/></>}</Btn></form>
      {comments.length>0&&<div className="reader-existing"><span className="section-kicker">NOTES SO FAR · {comments.length}</span>{comments.map(c=><article key={c.id}><div><b>{c.reviewerName}</b><span>Panel {c.pageIndex+1} · {prettyDate(c.createdAt)}</span></div><p>{c.body}</p></article>)}</div>}</section><footer className="reader-foot">A story in progress <span>·</span> Read with care</footer></div></div>
}

function AppRouter(){
 return <RoutedBoundary><Switch><Route path="/" component={Dashboard}/><Route path="/draft/:draftId" component={DraftPageView}/><Route path="/review/:shareToken" component={ReviewPageView}/><Route component={NotFound}/></Switch></RoutedBoundary>
}
function App(){return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/,'')}><AppRouter/></WouterRouter><Toaster/></TooltipProvider></QueryClientProvider>}
export default App;
