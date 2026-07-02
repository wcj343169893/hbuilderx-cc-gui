import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildSideBySideRows, type SideBySideRow, type SideCell } from '../../utils/diff';
import { registerDiffViewer, type DiffViewerPayload, type DiffSection } from '../../utils/diffViewer';

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 3000,
  padding: '24px',
};

const CARD_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '92vw',
  height: '88vh',
  maxWidth: '1400px',
  background: 'var(--bg-primary, #1e1e1e)',
  border: '1px solid var(--border-primary, #333)',
  borderRadius: '8px',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
  overflow: 'hidden',
};

const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid var(--border-primary, #333)',
  flex: '0 0 auto',
  gap: '12px',
};

const TITLE_STYLE: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--text-primary, #ccc)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const CLOSE_BTN_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '26px',
  height: '26px',
  border: '1px solid var(--border-primary, #333)',
  borderRadius: '4px',
  background: 'var(--bg-tertiary, #2a2a2a)',
  color: 'var(--text-secondary, #999)',
  cursor: 'pointer',
  flex: '0 0 auto',
};

const BODY_STYLE: React.CSSProperties = {
  flex: '1 1 auto',
  overflowY: 'auto',
  overflowX: 'hidden',
  background: 'var(--diff-surface, #1e1e1e)',
};

const SECTION_HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '6px 14px',
  fontSize: '11px',
  color: 'var(--text-secondary, #999)',
  background: 'var(--diff-gutter-bg, #252526)',
  borderTop: '1px solid var(--diff-gutter-border, #333)',
  borderBottom: '1px solid var(--diff-gutter-border, #333)',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};

const SIDE_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontSize: '12px',
  lineHeight: 1.6,
};

const COL_STYLE: React.CSSProperties = {
  flex: '1 1 0',
  minWidth: 0,
  overflowX: 'auto',
  overflowY: 'hidden',
};

const DIVIDER_STYLE: React.CSSProperties = {
  flex: '0 0 1px',
  background: 'var(--diff-gutter-border, #333)',
};

const ADDED_TEXT_STYLE: React.CSSProperties = { color: 'var(--diff-added-accent)' };
const DELETED_TEXT_STYLE: React.CSSProperties = { color: 'var(--diff-deleted-accent)' };
const STATS_SPACER_STYLE: React.CSSProperties = { margin: '0 4px' };

function cellBg(type: SideCell['type']): string {
  if (type === 'deleted') return 'var(--diff-deleted-bg)';
  if (type === 'added') return 'var(--diff-added-bg)';
  if (type === 'empty') return 'var(--diff-gutter-bg, rgba(0,0,0,0.15))';
  return 'transparent';
}

function glyphFor(type: SideCell['type']): string {
  if (type === 'deleted') return '-';
  if (type === 'added') return '+';
  return ' ';
}

const GUTTER_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  width: '44px',
  textAlign: 'right',
  paddingRight: '8px',
  color: 'var(--diff-muted-text, #666)',
  userSelect: 'none',
  whiteSpace: 'pre',
};

const GLYPH_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  width: '16px',
  textAlign: 'center',
  userSelect: 'none',
};

const CODE_STYLE: React.CSSProperties = {
  flex: '1 1 auto',
  whiteSpace: 'pre',
  tabSize: 4 as unknown as number,
  MozTabSize: 4 as unknown as number,
  color: 'var(--diff-text, #ccc)',
  paddingRight: '12px',
};

/** 单个 cell（左或右一行）。使用 min-content 宽度以便所在列可横向滚动。 */
const CellLine = ({ cell }: { cell: SideCell }) => {
  const isChanged = cell.type === 'deleted' || cell.type === 'added';
  return (
    <div style={{ display: 'flex', minWidth: 'min-content', background: cellBg(cell.type) }}>
      <div style={GUTTER_STYLE}>{cell.lineNo ?? ''}</div>
      <div
        style={{
          ...GLYPH_STYLE,
          color: cell.type === 'deleted'
            ? 'var(--diff-deleted-accent)'
            : cell.type === 'added'
              ? 'var(--diff-added-accent)'
              : 'transparent',
          opacity: isChanged ? 0.8 : 0.3,
        }}
      >
        {glyphFor(cell.type)}
      </div>
      <div style={CODE_STYLE}>{cell.content === '' ? ' ' : cell.content}</div>
    </div>
  );
};

/** 一个改动段的左右分栏视图。左右列行数相同（空侧补占位行），故逐行等高天然对齐。 */
const DiffSectionView = ({ section }: { section: DiffSection }) => {
  const { t } = useTranslation();
  const rows = useMemo<SideBySideRow[]>(
    () => buildSideBySideRows(section.before ?? '', section.after ?? ''),
    [section.before, section.after],
  );
  const additions = rows.filter(r => r.right.type === 'added').length;
  const deletions = rows.filter(r => r.left.type === 'deleted').length;

  return (
    <div>
      <div style={SECTION_HEADER_STYLE}>
        <span>{section.label || t('diffViewer.change', { defaultValue: '改动' })}</span>
        <span style={{ fontFamily: 'var(--idea-editor-font-family, monospace)', fontWeight: 600 }}>
          {additions > 0 && <span style={ADDED_TEXT_STYLE}>+{additions}</span>}
          {additions > 0 && deletions > 0 && <span style={STATS_SPACER_STYLE} />}
          {deletions > 0 && <span style={DELETED_TEXT_STYLE}>-{deletions}</span>}
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '12px 14px', fontSize: '12px', color: 'var(--diff-muted-text, #666)' }}>
          {t('diffViewer.noChange', { defaultValue: '（无差异）' })}
        </div>
      ) : (
        <div style={SIDE_ROW_STYLE}>
          <div style={COL_STYLE}>
            {rows.map((r, i) => <CellLine key={`l${i}`} cell={r.left} />)}
          </div>
          <div style={DIVIDER_STYLE} />
          <div style={COL_STYLE}>
            {rows.map((r, i) => <CellLine key={`r${i}`} cell={r.right} />)}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 左右分栏 diff 弹窗。全局单例：挂载时向 diffViewer bus 注册展示回调，
 * 任意组件调 openDiffViewer(payload) 即可弹出（见 utils/diffViewer.ts）。
 */
const DiffViewerModal = () => {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<DiffViewerPayload | null>(null);

  useEffect(() => {
    registerDiffViewer((p) => setPayload(p));
    return () => registerDiffViewer(null);
  }, []);

  const handleClose = useCallback(() => setPayload(null), []);

  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [payload, handleClose]);

  if (!payload) return null;

  return (
    <div style={OVERLAY_STYLE} onClick={handleClose}>
      <div style={CARD_STYLE} onClick={(e) => e.stopPropagation()}>
        <div style={HEADER_STYLE}>
          <span style={TITLE_STYLE} title={payload.filePath || payload.title}>
            <span className="codicon codicon-diff" style={{ marginRight: '6px' }} />
            {payload.title}
          </span>
          <button
            style={CLOSE_BTN_STYLE}
            onClick={handleClose}
            title={t('common.close', { defaultValue: '关闭' })}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>
        <div style={BODY_STYLE}>
          {payload.sections.map((section, i) => (
            <DiffSectionView key={i} section={section} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default DiffViewerModal;
