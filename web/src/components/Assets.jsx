import { useCallback, useEffect, useRef, useState } from 'react';
import { api, humanBytes, mediaUrl } from '../lib/api.js';
import { Empty, Icon, useToast } from './ui.jsx';
import { ContextMenu, useContextMenu } from './controls.jsx';
import { useSession } from '../lib/session.js';

export default function Assets({ projectId }) {
  const [images, setImages] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const say = useToast();
  const ctx = useContextMenu();
  const { user } = useSession();

  const download = (img) => {
    const a = document.createElement('a');
    a.href = mediaUrl(img.file);
    a.download = `${img.original_name.replace(/\.[^.]+$/, '')}.webp`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const setCover = async (img) => {
    try {
      await api.patch(`/api/projects/${projectId}`, { coverImageId: img.id });
      say('Set as the project cover');
    } catch (e) { say(e.message); }
  };

  const assetMenu = (e, img) => ctx.open(e, [
    { label: 'Download', icon: <Icon.Download />, onClick: () => download(img) },
    { label: 'Open full size', icon: <Icon.Image />, onClick: () => window.open(mediaUrl(img.file), '_blank', 'noopener') },
    user.isAdmin && { label: 'Use as project cover', icon: <Icon.Cover />, onClick: () => setCover(img) },
    { divider: true },
    { label: 'Delete', icon: <Icon.Trash />, danger: true, onClick: () => remove(img) },
  ], { title: img.original_name });

  const load = useCallback(async () => {
    const r = await api.get(`/api/images/project/${projectId}`);
    setImages(r.images);
  }, [projectId]);

  useEffect(() => { load().catch(() => setImages([])); }, [load]);

  async function upload(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      list.forEach((f) => fd.append('files', f));
      await api.form(`/api/images/project/${projectId}`, fd);
      await load();
      say(`${list.length} image${list.length > 1 ? 's' : ''} stored`);
    } catch (e) { say(e.message); } finally { setBusy(false); }
  }

  async function remove(img) {
    try {
      await api.del(`/api/images/${img.id}`);
    } catch (e) {
      if (e.status === 409 && confirm(`${e.message}. Remove it from those boards too?`)) {
        await api.del(`/api/images/${img.id}`, { force: true });
      } else return;
    }
    setImages((s) => s.filter((i) => i.id !== img.id));
    say('Image deleted');
  }

  const total = images?.reduce((n, i) => n + i.bytes, 0) || 0;

  return (
    <div className="page"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }}>
      <div className="page-inner">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 20 }}>
          <div>
            <p className="eyebrow">Everything uploaded to this project</p>
            <h1>Assets</h1>
          </div>
          <div style={{ flex: 1 }} />
          <span className="hint mono">{images?.length || 0} files · {humanBytes(total)} on disk</span>
          <button className="btn primary" disabled={busy} onClick={() => fileRef.current.click()}>
            {busy ? <div className="spin" /> : <Icon.Plus />} Upload
          </button>
        </div>

        <p className="hint" style={{ marginTop: -8, marginBottom: 18 }}>
          Images are re-encoded to WebP on upload and stored with a small proxy alongside, so boards stay quick
          and the disk stays small. Right-click any of them to download one or make it the project cover.
        </p>

        {images?.length === 0 && (
          <Empty title="No images yet" hint="Drop files anywhere on this page, or paste straight onto a moodboard."
            action={<button className="btn primary" onClick={() => fileRef.current.click()}><Icon.Plus /> Upload images</button>} />
        )}

        {images?.length > 0 && (
          <div className="asset-grid">
            {images.map((img) => (
              <figure className="asset" key={img.id} style={{ margin: 0 }} onContextMenu={(e) => assetMenu(e, img)}>
                <a href={mediaUrl(img.file)} target="_blank" rel="noreferrer">
                  <img src={mediaUrl(img.thumb)} alt={img.original_name} loading="lazy" />
                </a>
                <figcaption className="cap">
                  <span title={img.original_name}>{img.original_name}</span>
                  <span className="mono">{img.width}×{img.height}</span>
                </figcaption>
                <button className="btn danger icon sm kill" onClick={() => remove(img)} title="Delete image"><Icon.Trash /></button>
              </figure>
            ))}
          </div>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
    </div>
  );
}
