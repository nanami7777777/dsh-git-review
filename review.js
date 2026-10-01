/** Parse NUL-delimited porcelain v1, preserving spaces, tabs and newlines. */
export function parseStatus(text) {
  const parts = text.split('\0');
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Incomplete Git status output.');
    const index = record[0], worktree = record[1];
    const row = { path: record.slice(3), index, worktree };
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      if (!parts[i + 1]) throw new Error('Incomplete Git rename output.');
      row.previousPath = parts[++i];
    }
    row.untracked = index === '?' && worktree === '?';
    row.conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(index + worktree);
    rows.push(row);
  }
  return rows;
}

/** Parse --numstat -z --no-renames; binary files have null line counts. */
export function parseNumstat(text) {
  const counts = new Map();
  for (const record of text.split('\0')) {
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Incomplete Git line-count output.');
    counts.set(match[3], {
      added: match[1] === '-' ? null : Number(match[1]),
      deleted: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return counts;
}

/** Produce a bounded overview; totals always describe the complete status. */
export function summarize(status, staged, unstaged, maxFiles) {
  const rows = parseStatus(status);
  const stagedStats = parseNumstat(staged), unstagedStats = parseNumstat(unstaged);
  const files = rows.map(row => ({ ...row,
    staged: !row.untracked && !row.conflict && row.index !== ' ',
    unstaged: !row.untracked && !row.conflict && row.worktree !== ' ',
    stagedLines: stagedStats.get(row.path) ?? null,
    unstagedLines: unstagedStats.get(row.path) ?? null,
  }));
  return {
    scope: 'Current Git working tree and index, including changes made before this DSH session. Not a session attribution report.',
    totals: {
      files: files.length,
      staged: files.filter(file => file.staged).length,
      unstaged: files.filter(file => file.unstaged).length,
      untracked: files.filter(file => file.untracked).length,
      conflicts: files.filter(file => file.conflict).length,
    },
    files: files.slice(0, maxFiles),
    omittedFiles: Math.max(0, files.length - maxFiles),
    notes: [
      'Staged and unstaged counts overlap when a file has both kinds of edits.',
      'Line counts use --no-renames: a staged rename may count the destination as added; its source remains in previousPath.',
      'Untracked file contents are not read. Ignored files are excluded. Binary line counts are null.',
      'Git is read sequentially; avoid editing files while collecting the overview.',
    ],
  };
}
