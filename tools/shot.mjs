#!/usr/bin/env node
// 開発用の計測器。稼働中のダッシュボードを Chrome DevTools Protocol で駆動し、
// 「1 画面に収まっているか」を**実測**する(レイアウトは静的検査では証明できない)。
//
//   node tools/shot.mjs [--url http://127.0.0.1:4317/] [--size 1440x900]
//                       [--out tmp/shot.png] [--settle 2500] [--full] [--expect-no-scroll]
//                       [--density compact|normal|large] [--script path/to/probe.mjs]
//
// 出力: ビューポート実寸 / ページのスクロール量 / スクロール可能な要素 / 到達不能に切れた要素 / console エラー / PNG のパス。
// --expect-no-scroll を付けると、ページスクロールまたは到達不能に切れた要素があれば終了コード 1 で落ちる。
// --density は読み込み前に localStorage を仕込み、密度 3 段を切り替えて計測する。
// --script は描画が落ち着いた後にそのファイルの JS を評価し、戻り値(await 可)を JSON で出力する
// ——「検索で絞られたか」「タブが切り替わったか」など、レイアウト以外の挙動を実測するための窓。
// 依存は Chrome 本体のみ(npm 依存は増やさない)。CHROME 環境変数でパスを上書きできる。
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const argv = process.argv;
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const url = arg('url', 'http://127.0.0.1:4317/');
const size = arg('size', '1440x900');
const [width, height] = size.split('x').map(Number);
const out = path.resolve(arg('out', `tmp/shot-${size}.png`));
const settle = Number(arg('settle', '2500'));
const density = arg('density', '');
const scriptFile = arg('script', '');
const port = 9400 + Math.floor(Math.random() * 400);

const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('Chrome が見つかりません。CHROME=<path to chrome.exe> で指定してください。');
  process.exit(2);
}

/** CDP の 1 本の WebSocket をラップし、method 呼び出しを Promise に、イベントを購読に変える。 */
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.method + ': ' + msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('CDP WebSocket error: ' + (e.message || 'unknown'))));
    ws.addEventListener('open', () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        on: (fn) => listeners.push(fn),
        close: () => ws.close(),
      }));
  });
}

async function devtools(pathname) {
  // Chrome の起動を待ちながら HTTP エンドポイントを叩く
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (r.ok) return r.json();
    } catch { /* まだ起きていない */ }
    await sleep(100);
  }
  throw new Error(`DevTools エンドポイントに接続できません: ${pathname}`);
}

mkdirSync(path.dirname(out), { recursive: true });
rmSync(out, { force: true });
const profile = path.join(path.dirname(out), '.chrome-profile');

const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--window-size=${width},${height}`,
  'about:blank',
], { stdio: 'ignore' });

let code = 0;
try {
  await devtools('/json/version');
  const targets = await devtools('/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('page ターゲットが見つかりません');
  const c = await cdp(page.webSocketDebuggerUrl);

  const problems = [];
  c.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning'))
      problems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    if (m.method === 'Runtime.exceptionThrown')
      problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });

  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  if (density) {
    // ページ自身のスクリプトより前に走らせ、保存済み設定として読ませる
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('aiad-density', ${JSON.stringify(density)}); } catch (e) {}`,
    });
  }

  const loaded = new Promise((res) => c.on((m) => m.method === 'Page.loadEventFired' && res()));
  await c.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(20000)]);
  await sleep(settle); // API fetch と描画の落ち着きを待つ

  // --script: 画面を操作して(検索語を入れる・タブを押す等)、その結果の状態を測る
  let probeOut;
  if (scriptFile) {
    const src = readFileSync(path.resolve(scriptFile), 'utf8');
    const r = await c.send('Runtime.evaluate', {
      expression: `(async () => { ${src} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('probe 失敗: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    probeOut = r.result.value;
  }

  // 「1 画面に収まっているか」の観測量。
  // scrollHeight は使えない: html の overflow が visible なら body の overflow はビューポートへ
  // 伝播し、body 自身は clip しない。その状態でも root の scrollHeight は内容全高を返すため、
  // 「スクロールするか」を表さない。代わりに (1) 実際にスクロールを試す (2) ビューポート外に出た
  // 要素がスクロール可能な祖先を持つか(= 到達できるか)を見る。
  const { result } = await c.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const d = document.documentElement;
      const vh = d.clientHeight, vw = d.clientWidth;
      const y0 = window.scrollY, x0 = window.scrollX;
      window.scrollTo(9999, 9999);
      const pageY = window.scrollY, pageX = window.scrollX;
      window.scrollTo(x0, y0);

      const scrollableAncestor = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (/auto|scroll/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) return p;
          if (/auto|scroll/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return p;
        }
        return null;
      };
      const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
        + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
      const cut = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;                 // hidden なペイン等は対象外
        if (getComputedStyle(el).position === 'fixed') continue;        // tooltip 等は画面追従
        const out = r.bottom > vh + 1 || r.right > vw + 1 || r.top < -1 || r.left < -1;
        if (out && !scrollableAncestor(el)) cut.push({ sel: name(el), top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right) });
      }
      const scrollers = [...document.querySelectorAll('body *')]
        .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
        .map((el) => name(el) + \` (\${el.clientHeight}/\${el.scrollHeight}px)\`);
      return { vh, vw, pageY, pageX, cut, scrollers, title: document.title };
    })()`,
  });
  const m = result.value;

  const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: has('full') });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));

  console.log(`url      : ${url}${density ? `  density=${density}` : ''}`);
  console.log(`viewport : ${m.vw}x${m.vh} (指定 ${width}x${height})`);
  console.log(`page     : スクロール量 縦 ${m.pageY}px / 横 ${m.pageX}px`);
  console.log(`scrollers: ${m.scrollers.length ? m.scrollers.join(', ') : 'なし'}`);
  console.log(`cut      : ${m.cut.length ? m.cut.length + ' 件(画面外で到達不能)' : 'なし'}`);
  for (const x of m.cut.slice(0, 10)) console.log(`  - ${x.sel} top=${x.top} bottom=${x.bottom} right=${x.right}`);
  console.log(`console  : ${problems.length ? problems.length + ' 件' : 'エラー・警告なし'}`);
  for (const p of problems.slice(0, 10)) console.log('  - ' + p);
  console.log(`png      : ${out}${has('full') ? ' (フルページ)' : ''}`);
  if (scriptFile) console.log('probe    : ' + JSON.stringify(probeOut, null, 2));

  if (has('expect-no-scroll') && (m.pageY > 0 || m.pageX > 0 || m.cut.length)) {
    console.error('NG: ページスクロールまたは到達不能な切れが発生しています(1 画面に収まっていません)。');
    code = 1;
  }
  c.close();
} catch (e) {
  console.error('計測に失敗:', e.message);
  code = 2;
} finally {
  proc.kill();
}
process.exit(code);
