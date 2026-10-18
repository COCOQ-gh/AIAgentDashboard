// scan.mjs の並列パース用ワーカー。1 メッセージ = 1 ファイル({ seq, entry })。
// 読み込み + parseTranscript を行い { seq, session } か { seq, error } を返す。
import { parentPort } from 'node:worker_threads';
import { readSession } from './scan.mjs';

parentPort.on('message', async ({ seq, entry }) => {
  try {
    parentPort.postMessage({ seq, session: await readSession(entry) });
  } catch (e) {
    parentPort.postMessage({ seq, error: String(e.message || e) });
  }
});
