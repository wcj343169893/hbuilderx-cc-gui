import { memo, useCallback } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { FileChangeSummary } from '../../types';
import { openFile } from '../../utils/bridge';
import { openDiffViewer } from '../../utils/diffViewer';
import FileIcon from './FileIcon';

interface FileChangesListProps {
  fileChanges: FileChangeSummary[];
  undoingFile: string | null;
  isDiscardingAll: boolean;
  onUndoClick: (fileChange: FileChangeSummary) => void;
  onDiscardAllClick: () => void;
  onKeepAllClick: () => void;
}

interface FileChangeRowProps {
  fileChange: FileChangeSummary;
  isUndoing: boolean;
  onOpen: (fileChange: FileChangeSummary) => void;
  onShowDiff: (fileChange: FileChangeSummary) => void;
  onUndo: (fileChange: FileChangeSummary) => void;
  t: TFunction;
}

const FileChangeRow = memo(({ fileChange, isUndoing, onOpen, onShowDiff, onUndo, t }: FileChangeRowProps) => {
  const status = String(fileChange.status || 'M');
  const statusClass = status === 'A' ? 'added' : 'modified';

  const handleOpen = useCallback(() => {
    onOpen(fileChange);
  }, [onOpen, fileChange]);

  const handleOpenKeyDown = useCallback((event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(fileChange);
    }
  }, [onOpen, fileChange]);

  const handleShowDiff = useCallback(() => {
    onShowDiff(fileChange);
  }, [onShowDiff, fileChange]);

  const handleUndo = useCallback(() => {
    onUndo(fileChange);
  }, [onUndo, fileChange]);

  return (
    <div className="file-change-item">
      {/* Status indicator (A/M) */}
      <span className={`file-change-status status-${statusClass}`}>
        {status}
      </span>

      {/* File icon */}
      <FileIcon filePath={fileChange.filePath} />

      {/* File name — keyboard accessible since it acts as a button */}
      <span
        className="file-change-name"
        role="button"
        tabIndex={0}
        onClick={handleOpen}
        onKeyDown={handleOpenKeyDown}
        title={fileChange.filePath}
      >
        {fileChange.fileName}
      </span>

      {/* Stats */}
      {(fileChange.additions > 0 || fileChange.deletions > 0) && (
        <span className="file-change-stats">
          {fileChange.additions > 0 && <span className="additions">+{fileChange.additions}</span>}
          {fileChange.deletions > 0 && <span className="deletions">-{fileChange.deletions}</span>}
        </span>
      )}

      {/* Actions */}
      <div className="file-change-actions">
        <button
          className="file-change-action-btn diff-btn tests"
          onClick={handleShowDiff}
          title={t('statusPanel.showDiff')}
        >
          <span className="codicon codicon-diff" />
        </button>
        <button
          className="file-change-action-btn undo-btn"
          onClick={handleUndo}
          title={t('statusPanel.undoChanges')}
          disabled={isUndoing}
        >
          {isUndoing ? (
            <span className="codicon codicon-loading codicon-modifier-spin" />
          ) : (
            <span className="codicon codicon-discard" />
          )}
        </button>
      </div>
    </div>
  );
});

FileChangeRow.displayName = 'FileChangeRow';

const FileChangesList = memo(({
  fileChanges,
  undoingFile,
  isDiscardingAll,
  onUndoClick,
  onDiscardAllClick,
  onKeepAllClick,
}: FileChangesListProps) => {
  const { t } = useTranslation();

  const handleOpenFile = useCallback((fileChange: FileChangeSummary) => {
    openFile(fileChange.filePath, fileChange.lineStart, fileChange.lineEnd);
  }, []);

  const handleShowDiff = useCallback((fileChange: FileChangeSummary) => {
    // HBuilderX 无原生 diff 视图 API（executeCommand 不能传参），改为在 webview 内
    // 自建左右分栏对比弹窗（DiffViewerModal）。operations 里已带每处改动的 old/new，
    // 无需后端补内容，故纯前端即可展示。
    const ops = fileChange.operations || [];
    const sections = ops.length > 0
      ? ops.map((op, i) => ({
          label: t('diffViewer.editN', { index: i + 1, defaultValue: `第 ${i + 1} 处修改` }),
          before: op.oldString ?? '',
          after: op.newString ?? '',
        }))
      : [{ before: '', after: '' }];
    openDiffViewer({
      title: fileChange.fileName || fileChange.filePath,
      filePath: fileChange.filePath,
      sections,
    });
  }, [t]);

  if (fileChanges.length === 0) {
    return <div className="status-panel-empty">{t('statusPanel.noFileChanges')}</div>;
  }

  return (
    <div className="file-changes-container">
      {/* Batch action buttons */}
      <div className="file-changes-actions-bar">
        <button
          className="file-changes-action-btn discard-all-btn"
          onClick={onDiscardAllClick}
          disabled={isDiscardingAll}
          title={t('statusPanel.discardAll')}
        >
          {isDiscardingAll ? (
            <span className="codicon codicon-loading codicon-modifier-spin" />
          ) : (
            <span className="codicon codicon-trash" />
          )}
          <span>{t('statusPanel.discardAll')}</span>
        </button>
        <button
          className="file-changes-action-btn keep-all-btn"
          onClick={onKeepAllClick}
          title={t('statusPanel.keepAll')}
        >
          <span className="codicon codicon-check-all" />
          <span>{t('statusPanel.keepAll')}</span>
        </button>
      </div>

      {/* File list */}
      <div className="file-changes-list">
        {fileChanges.map((fileChange) => (
          <FileChangeRow
            key={fileChange.filePath}
            fileChange={fileChange}
            isUndoing={undoingFile === fileChange.filePath}
            onOpen={handleOpenFile}
            onShowDiff={handleShowDiff}
            onUndo={onUndoClick}
            t={t}
          />
        ))}
      </div>
    </div>
  );
});

FileChangesList.displayName = 'FileChangesList';

export default FileChangesList;
