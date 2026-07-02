/**
 * 共享 diff 计算工具。
 *
 * `computeDiff` 原先内联在 EditToolBlock.tsx，现抽出以便工具卡片（unified 内联 diff）
 * 与 DiffViewerModal（side-by-side 左右对比）复用同一份 LCS 实现，避免两套 diff 结果不一致。
 */

export type DiffLineType = 'unchanged' | 'deleted' | 'added';

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

export interface DiffResult {
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

// Compute actual diff using the LCS algorithm
export function computeDiff(oldLines: string[], newLines: string[]): DiffResult {
  if (oldLines.length === 0 && newLines.length === 0) {
    return { lines: [], additions: 0, deletions: 0 };
  }
  if (oldLines.length === 0) {
    return {
      lines: newLines.map(content => ({ type: 'added' as const, content })),
      additions: newLines.length,
      deletions: 0,
    };
  }
  if (newLines.length === 0) {
    return {
      lines: oldLines.map(content => ({ type: 'deleted' as const, content })),
      additions: 0,
      deletions: oldLines.length,
    };
  }

  const m = oldLines.length;
  const n = newLines.length;

  // Build the LCS dynamic programming table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to generate the diff
  const diffLines: DiffLine[] = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffLines.unshift({ type: 'unchanged', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffLines.unshift({ type: 'added', content: newLines[j - 1] });
      j--;
    } else {
      diffLines.unshift({ type: 'deleted', content: oldLines[i - 1] });
      i--;
    }
  }

  const additions = diffLines.filter(l => l.type === 'added').length;
  const deletions = diffLines.filter(l => l.type === 'deleted').length;

  return { lines: diffLines, additions, deletions };
}

export type SideCellType = 'unchanged' | 'deleted' | 'added' | 'empty';

export interface SideCell {
  /** 行文本；type === 'empty' 时为占位空行 */
  content: string;
  type: SideCellType;
  /** 1-based 行号；占位空行为 null */
  lineNo: number | null;
}

export interface SideBySideRow {
  left: SideCell;
  right: SideCell;
}

const EMPTY_CELL: SideCell = { content: '', type: 'empty', lineNo: null };

/**
 * 把 unified diff 转成左右分栏（side-by-side）行对：
 * - unchanged：左右同一行；
 * - 连续的 deleted / added 块按序配对到同一视觉行（k-th 删对 k-th 增），多出的一侧补空行；
 * 这样「替换」在左右并排显示，接近 git diff 的分栏视图。
 */
export function buildSideBySideRows(before: string, after: string): SideBySideRow[] {
  const oldLines = before ? before.split('\n') : [];
  const newLines = after ? after.split('\n') : [];
  const { lines } = computeDiff(oldLines, newLines);

  const rows: SideBySideRow[] = [];
  let leftNo = 0;
  let rightNo = 0;
  let delBuf: string[] = [];
  let addBuf: string[] = [];

  const flush = () => {
    const count = Math.max(delBuf.length, addBuf.length);
    for (let k = 0; k < count; k++) {
      const d = k < delBuf.length ? delBuf[k] : undefined;
      const a = k < addBuf.length ? addBuf[k] : undefined;
      rows.push({
        left: d !== undefined ? { content: d, type: 'deleted', lineNo: ++leftNo } : EMPTY_CELL,
        right: a !== undefined ? { content: a, type: 'added', lineNo: ++rightNo } : EMPTY_CELL,
      });
    }
    delBuf = [];
    addBuf = [];
  };

  for (const line of lines) {
    if (line.type === 'unchanged') {
      flush();
      rows.push({
        left: { content: line.content, type: 'unchanged', lineNo: ++leftNo },
        right: { content: line.content, type: 'unchanged', lineNo: ++rightNo },
      });
    } else if (line.type === 'deleted') {
      delBuf.push(line.content);
    } else {
      addBuf.push(line.content);
    }
  }
  flush();

  return rows;
}
