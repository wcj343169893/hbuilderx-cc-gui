import { useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * DeepseekQueuePanel
 *
 * 会话界面内的「DeepSeek 平价执行队列」面板。高峰时段(2倍价)用户把任务加入队列后，
 * 这里展示待执行的计划列表；平价时段后台按难度自动选模型、逐个用全新会话执行。
 * 后端通过 window.updateDeepseekQueue 下发列表；移除/清空经 bridge 事件回传后端。
 */

export interface DeepseekQueueItem {
  id: string;
  text: string;
  /** 'easy' | 'medium' | 'hard'（后端启发式判定，仅展示用） */
  difficulty: string;
  /** 所属项目名（basename），可空 */
  project: string;
  /** 平价自动执行时的权限模式（askAlways/acceptEdits/bypassPermissions/plan），可空 */
  permissionMode?: string;
  enqueuedAt: number;
}

const PERMISSION_MODE_LABEL: Record<string, string> = {
  askAlways: '逐次询问',
  acceptEdits: '自动接受编辑',
  bypassPermissions: '全部自动',
  plan: '计划模式',
};

interface DeepseekQueuePanelProps {
  items: DeepseekQueueItem[];
  onRemove: (id: string) => void;
  onClear: () => void;
}

const DIFFICULTY_LABEL: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '复杂',
};

const difficultyColor = (d: string): string => {
  if (d === 'hard') return 'var(--text-warning, #d08770)';
  if (d === 'easy') return 'var(--color-success, #7fb069)';
  return 'var(--text-secondary)';
};

const wrapStyle: CSSProperties = {
  margin: '8px 12px 0',
  border: '1px solid var(--border-secondary)',
  borderRadius: 8,
  background: 'var(--bg-secondary)',
  fontSize: 12,
  color: 'var(--text-primary)',
  overflow: 'hidden',
  flex: '0 0 auto',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '6px 10px',
  cursor: 'pointer',
  userSelect: 'none',
};

const listStyle: CSSProperties = {
  maxHeight: 180,
  overflowY: 'auto',
  borderTop: '1px solid var(--border-secondary)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '6px 10px',
  borderBottom: '1px solid var(--border-secondary)',
};

const textStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--text-primary)',
};

const metaStyle: CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: 11,
  marginTop: 2,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const iconBtnStyle: CSSProperties = {
  flex: '0 0 auto',
  background: 'transparent',
  border: 'none',
  color: 'var(--text-tertiary)',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: '18px',
  padding: '0 4px',
};

const linkBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--color-link, var(--accent-primary))',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
};

const DeepseekQueuePanel = ({ items, onRemove, onClear }: DeepseekQueuePanelProps) => {
  const [collapsed, setCollapsed] = useState(false);

  if (!items || items.length === 0) return null;

  return (
    <div style={wrapStyle} data-testid="deepseek-queue-panel">
      <div style={headerStyle} onClick={() => setCollapsed((c) => !c)}>
        <span style={{ fontWeight: 600 }}>
          {collapsed ? '▸' : '▾'} DeepSeek 平价执行队列（{items.length}）
        </span>
        <button
          type="button"
          style={linkBtnStyle}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          title="清空整个队列"
        >
          清空
        </button>
      </div>

      {!collapsed && (
        <div style={listStyle}>
          {items.map((it, i) => {
            const preview = String(it.text || '').replace(/\s+/g, ' ').trim();
            const diff = DIFFICULTY_LABEL[it.difficulty] || it.difficulty || '';
            return (
              <div style={rowStyle} key={it.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={textStyle} title={preview}>
                    {i + 1}. {preview || '(空)'}
                  </div>
                  <div style={metaStyle}>
                    {diff && (
                      <span style={{ color: difficultyColor(it.difficulty) }}>难度：{diff}</span>
                    )}
                    {it.permissionMode
                      ? `　·　${PERMISSION_MODE_LABEL[it.permissionMode] || it.permissionMode}`
                      : ''}
                    {it.project ? `　·　${it.project}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  style={iconBtnStyle}
                  onClick={() => onRemove(it.id)}
                  title="从队列移除"
                  aria-label="从队列移除"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {!collapsed && (
        <div style={{ padding: '6px 10px', color: 'var(--text-tertiary)', fontSize: 11 }}>
          平价时段（北京时间 12:00 后 / 18:00 后）将按难度自动选模型、逐个用全新会话执行。
        </div>
      )}
    </div>
  );
};

export default DeepseekQueuePanel;
