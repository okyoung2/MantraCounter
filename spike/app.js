// 시험판 화면: 녹음 3번 → 이어서 외우는 소리를 듣고 세기.
import { createFeaturizer, makeTemplate, calibrate, createDetector } from './dsp.js';

const $ = id => document.getElementById(id);
const KEY = 'mantraCounterSpike.v1';
const MIN_TAKES = 3, MAX_TAKES = 5;
const store = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } },
  set(v) { try { localStorage.setItem(KEY, JSON.stringify({ ...store.get(), ...v })); } catch { /* 저장 안 돼도 동작 */ } },
};

let ctx = null, mode = null, recBuf = [], onSamples = null;
let takes = [];      // 녹음마다 특징 프레임 배열
let templates = null, base = null, det = null, wakeLock = null;
const scores = [];   // 그래프용 최근 점수
const debugEvents = []; // 디버그: 이번 카운트의 판정 기록 (콘솔에서 mc.events 로 표로 보기: console.table(mc.events))
window.mc = { get events() { return debugEvents; }, get det() { return det; }, get base() { return base; } };
const sounds = { done: new Audio('sounds/done.wav') };

function log(msg) { const el = $('log'); el.textContent = `${new Date().toLocaleTimeString()} ${msg}\n` + el.textContent.slice(0, 3000); }
function fatal(msg) { $('fatal').textContent = msg; $('fatal').hidden = false; }

async function ensureMic() {
  if (ctx) { if (ctx.state === 'suspended') await ctx.resume(); return; }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 브라우저에서는 마이크를 쓸 수 없어요. https 주소로 열었는지 확인해 주세요.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0;
  proc.onaudioprocess = e => {
    const x = new Float32Array(e.inputBuffer.getChannelData(0));
    if (mode === 'rec') recBuf.push(x);
    else if (mode === 'count' && onSamples) onSamples(x);
  };
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  log(`마이크 켜짐 (샘플레이트 ${ctx.sampleRate})`);
}

// ---------- 등록 ----------
function renderTakes() {
  const now = mode === 'rec' ? takes.length : -1;
  $('takes').innerHTML = [0, 1, 2, 3, 4].map(i => {
    const cls = i < takes.length ? 'take done' : i === now ? 'take now' : 'take';
    const label = i < takes.length ? `✔ ${i + 1}<br>${takes[i].sec.toFixed(1)}초` : i === now ? `● ${i + 1}<br>녹음 중` : `${i + 1}${i >= MIN_TAKES ? '<br>(선택)' : ''}`;
    return `<div class="${cls}">${label}</div>`;
  }).join('');
  const full = takes.length >= MAX_TAKES;
  $('rec-btn').disabled = full && mode !== 'rec';
  $('rec-btn').textContent = mode === 'rec' ? '■ 녹음 종료' : full ? `등록 완료 (${MAX_TAKES}회)` : takes.length >= MIN_TAKES ? `● 녹음 더 하기 (${takes.length + 1}회차, 선택)` : `● 녹음 시작 (${takes.length + 1}회차)`;
  $('rec-btn').className = mode === 'rec' ? 'rec big' : 'primary big';
  $('count-btn').disabled = !templates || mode === 'rec';
}

async function toggleRec() {
  if (mode === 'count') return;
  if (mode !== 'rec') {
    try { await ensureMic(); } catch (e) { fatal('마이크를 켤 수 없어요: ' + e.message); return; }
    recBuf = []; mode = 'rec'; $('enroll-msg').textContent = '만트라를 한 번 외우고 녹음 종료를 눌러 주세요.';
    renderTakes(); return;
  }
  mode = null;
  const len = recBuf.reduce((a, b) => a + b.length, 0), all = new Float32Array(len);
  let k = 0; for (const b of recBuf) { all.set(b, k); k += b.length; }
  const frames = createFeaturizer(ctx.sampleRate).push(all);
  const t = frames.length > 20 ? makeTemplate(frames) : null;
  if (!t || t.sec < 0.6) { $('enroll-msg').textContent = '소리가 너무 짧거나 작아요. 이번 회차를 다시 녹음해 주세요.'; renderTakes(); return; }
  takes.push({ frames: frames.map(f => ({ c: Array.from(f.c), e: f.e })), sec: t.sec });
  $('enroll-msg').textContent = `${takes.length}회차 녹음 완료 (${t.sec.toFixed(1)}초)`;
  if (takes.length >= MIN_TAKES) buildModel(true);
  renderTakes();
}

function buildModel(save) {
  const fl = takes.map(t => t.frames);
  templates = fl.map(makeTemplate);
  base = calibrate(templates, fl);
  if (save) store.set({ takes, sr: ctx?.sampleRate });
  const lens = templates.map(t => t.sec.toFixed(1)).join(' / ');
  $('enroll-msg').textContent = `등록 완료 (${takes.length}회). 녹음 길이 ${lens}초. 이제 카운트를 시작할 수 있어요.`;
  $('status').textContent = '목표 횟수를 정하고 카운트 시작을 눌러 주세요.';
  log(`등록: 길이 ${lens}초, 기준 거리 ${base.toFixed(2)}`);
  console.log('[MC] 등록', JSON.stringify({ takes: takes.length, tplSec: templates.map(t => +t.sec.toFixed(2)), base: +base.toFixed(3) }));
}

function resetTakes() {
  if (mode) return;
  takes = []; templates = null; base = null; store.set({ takes: [] });
  $('enroll-msg').textContent = ''; $('status').textContent = '먼저 만트라를 3번 녹음해 주세요.';
  renderTakes();
}

// ---------- 카운트 ----------
const target = () => Math.max(1, Math.min(9999, parseInt($('target').value, 10) || 1));
function play(s) { try { s.currentTime = 0; s.play().catch(() => {}); } catch { /* 무시 */ } }

async function toggleCount() {
  if (mode === 'count') { stopCount('정지했어요.'); return; }
  try { await ensureMic(); } catch (e) { fatal('마이크를 켤 수 없어요: ' + e.message); return; }
  const goal = target();
  const fz = createFeaturizer(ctx.sampleRate);
  det = createDetector({
    templates, base, sens: +$('sens').value,
    onEvent(e) {
      $('count').textContent = e.count; $('miss').textContent = e.miss;
      const d = e.debug, n = e.count + e.miss;
      log((e.type === 'count' ? `셈 ${e.count}  (차이 ${d.rel.toFixed(2)})`
        : `놓침 ${e.miss}  (${e.reason === 'timeout' ? `소리는 났지만 못 찾음, 가장 가까웠던 ${d.bestRecent ?? '없음'}` : '애매함 ' + d.rel.toFixed(2)})`)
        + `  [${n}번째, 음색 어긋남 ${d.drift}]`);
      // PC 크롬 chrome://inspect 에서 보는 자세한 기록
      console.log(`[MC] ${n}번째 ${e.type === 'count' ? '셈' : '놓침'} ${e.reason}`, JSON.stringify(d));
      debugEvents.push({ n, type: e.type, reason: e.reason, ...d });
      if (e.type !== 'count') return;
      if (goal > 1 && e.count === goal - 1) $('status').textContent = '마지막 1회 남았어요.';
      if (e.count >= goal) { play(sounds.done); stopCount(`${goal}회 완료! (놓침 ${e.miss})`); }
    },
  });
  debugEvents.length = 0;
  console.log('[MC] 카운트 시작', JSON.stringify({ goal, sens: +$('sens').value, base: +base.toFixed(3), sampleRate: ctx.sampleRate,
    tplSec: templates.map(t => +t.sec.toFixed(2)), takes: takes.length }));
  onSamples = x => { det.push(fz.push(x)); scores.push(det.lastScore); if (scores.length > 400) scores.splice(0, scores.length - 400); };
  scores.length = 0;
  $('count').textContent = '0'; $('miss').textContent = '0';
  mode = 'count';
  $('count-btn').textContent = '■ 정지'; $('count-btn').className = 'rec big';
  $('status').textContent = '듣고 있어요. 만트라를 외워 주세요.';
  $('rec-btn').disabled = true; $('reset-btn').disabled = true;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 없어도 됨 */ }
  log(`카운트 시작 (목표 ${goal}, 민감도 ${(+$('sens').value).toFixed(2)})`);
}

function stopCount(msg) {
  mode = null; onSamples = null;
  if (debugEvents.length) { console.log('[MC] 카운트 끝:', msg); console.table(debugEvents); }
  $('count-btn').textContent = '▶ 카운트 시작'; $('count-btn').className = 'primary big';
  $('status').textContent = msg; $('reset-btn').disabled = false;
  try { wakeLock?.release(); } catch { /* 무시 */ } wakeLock = null;
  renderTakes();
}

// ---------- 그래프 ----------
function draw() {
  const cv = $('graph'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  if (base) {
    const sens = +$('sens').value, top = base * 3, y = v => H - Math.min(1, v / top) * H;
    const css = getComputedStyle(document.documentElement);
    for (const [v, c] of [[base * sens, '--ok'], [base * sens * 1.35, '--accent']]) {
      g.strokeStyle = css.getPropertyValue(c); g.lineWidth = 2; g.beginPath(); g.moveTo(0, y(v)); g.lineTo(W, y(v)); g.stroke();
    }
    g.strokeStyle = css.getPropertyValue('--text'); g.lineWidth = 2; g.beginPath();
    let pen = false;
    scores.forEach((s, i) => { const x = i / 400 * W; if (s == null) { pen = false; return; } pen ? g.lineTo(x, y(s)) : g.moveTo(x, y(s)); pen = true; });
    g.stroke();
  }
  requestAnimationFrame(draw);
}

// ---------- 시작 ----------
function init() {
  const saved = store.get();
  if (saved.sens2) $('sens').value = Math.min(1.3, Math.max(1.05, saved.sens2));
  $('sens-val').textContent = (+$('sens').value).toFixed(2);
  if (saved.target) $('target').value = saved.target;
  $('target-show').textContent = target();
  if (Array.isArray(saved.takes) && saved.takes.length >= MIN_TAKES) {
    takes = saved.takes.map(t => ({ ...t, frames: t.frames.map(f => ({ c: Float32Array.from(f.c), e: f.e })) }));
    buildModel(false);
  }
  $('chips').innerHTML = [21, 54, 108].map(n => `<button type="button" data-n="${n}" aria-pressed="false">${n}회</button>`).join('');
  const syncChips = () => document.querySelectorAll('#chips button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.n === target())));
  syncChips();
  $('chips').onclick = e => { const n = e.target.dataset?.n; if (!n || mode === 'count') return; $('target').value = n; $('target').dispatchEvent(new Event('input')); };
  $('target').oninput = () => { $('target-show').textContent = target(); store.set({ target: target() }); syncChips(); };
  $('sens').oninput = () => { const v = +$('sens').value; $('sens-val').textContent = v.toFixed(2); store.set({ sens2: v }); if (det) det.sens = v; };
  const nudge = d => { $('sens').value = (Math.round(+$('sens').value * 100) + d) / 100; $('sens').dispatchEvent(new Event('input')); };
  $('sens-down').onclick = () => nudge(-1);
  $('sens-up').onclick = () => nudge(1);
  $('rec-btn').onclick = toggleRec;
  $('reset-btn').onclick = resetTakes;
  $('count-btn').onclick = toggleCount;
  renderTakes();
  requestAnimationFrame(draw);
}
init();
