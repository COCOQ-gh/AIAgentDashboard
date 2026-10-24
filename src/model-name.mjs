// モデル名の正規化。純関数のみ。parse / pricing / models が共有する(循環 import を避けるため独立)。

/** 表示・集計用のモデル名。日付サフィックス(claude-haiku-4-5-20251001)を落とす。 */
export function normalizeModel(m) {
  return m ? String(m).replace(/-\d{8}$/, '') : '(不明)';
}

/** `<synthetic>`(Claude Code が自前で差し込む行。usage はすべて 0)。 */
export function isSyntheticModel(m) {
  return typeof m === 'string' && m.startsWith('<') && m.endsWith('>');
}
