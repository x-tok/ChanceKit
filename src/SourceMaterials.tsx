import { ExternalLink, FileText } from 'lucide-react';
import type { ActivitySource } from './schedule';
import s from './Schedule.module.css';
import common from './App.module.css';

export function SourceMaterials({ materials, onOpen, onPdf }: {
  materials: ActivitySource['materials']; onOpen: (url: string) => void; onPdf: (id: string) => void;
}) {
  const unique = materials.filter((item, index) => materials.findIndex(other =>
    other.kind === item.kind && other.url === item.url && (item.url || other.title === item.title)) === index);
  const images = unique.filter(item => item.kind === 'image');
  const sources = unique.filter(item => item.kind !== 'image');
  const imageLinks = images.map((item, index) => item.url
    ? <button key={`${item.url}-${index}`} className={s.imagePreview} onClick={() => onOpen(item.url)} aria-label={`来源图片 ${index + 1}`} title={`打开来源图片 ${index + 1}`}>
      <img src={item.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
      <span><ExternalLink size={13} />来源图片 {index + 1}</span></button>
    : <span key={index} className={s.muted}>{item.title || 'QQ 图片附件'} · 可在来源群聊查看</span>);
  return <div className={s.sourceMaterials}>
    {sources.filter(item => item.snapshotId).map(item => <div key={item.snapshotId} className={s.pdfSource}>
      <button className={common.textButton} onClick={() => onPdf(item.snapshotId!)}><FileText size={14} />网页 PDF · {item.title || '阅读副本'}</button>
      {item.pdfCoverage && <small className={s.muted}>已处理 {item.pdfCoverage.processedPages} / {item.pdfCoverage.totalPages} 页</small>}
      {Boolean(item.notices?.length) && <details className={s.readingNotes}><summary>静态转换说明</summary>
        <ul>{item.notices!.map(note => <li key={note}>{note}</li>)}</ul></details>}
    </div>)}
    {sources.map((item, index) => item.url
      ? <button key={`${item.url}-${index}`} className={common.textButton} onClick={() => onOpen(item.url)}>
        <ExternalLink size={14} />{item.title || (item.kind === 'file' ? '查看来源文件' : '查看原网页')}</button>
      : <span key={index} className={s.muted}>{item.title || 'QQ 文件附件'} · 可在来源群聊查看</span>)}
    {images.length > 3 ? <details className={s.imageSources}><summary>来源图片 · {images.length} 张</summary>
      <div className={s.imageGrid}>{imageLinks}</div></details> : <div className={s.imageGrid}>{imageLinks}</div>}
  </div>;
}
