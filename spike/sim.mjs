// 시험판 확인용: 가짜 "목소리"로 만트라를 만들어 세기가 맞는지 본다.  node spike/sim.mjs
import { createFeaturizer, makeTemplate, calibrate, createDetector } from './dsp.js';

const SR = 48000;
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const VOWELS = { a: [730, 1090], i: [270, 2290], u: [300, 870], e: [530, 1840], o: [570, 840] };
const OM = ['o', 'u', 'a', 'a', 'i', 'a', 'a']; // 옴 나마 시바야 비슷한 모음 흐름
const OTHER = ['e', 'i', 'o', 'u', 'e', 'o', 'i'];

function syllable(v, sec, f0) {
  const n = Math.round(sec * SR), out = new Float32Array(n), [F1, F2] = VOWELS[v];
  for (let h = 1; h * f0 < 4000; h++) {
    const f = h * f0, amp = Math.exp(-(((f - F1) / 120) ** 2)) + 0.7 * Math.exp(-(((f - F2) / 160) ** 2)) + 0.02;
    const ph = rnd() * 6.28;
    for (let t = 0; t < n; t++) out[t] += amp * Math.sin(2 * Math.PI * f * t / SR + ph);
  }
  const ramp = Math.round(0.03 * SR);
  for (let t = 0; t < n; t++) out[t] *= 0.1 * Math.min(1, t / ramp, (n - t) / ramp);
  return out;
}
const concat = parts => { const o = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const chant = (seq, tempo) => { const f0 = 140 * (0.95 + rnd() * 0.1); return concat(seq.map(v => syllable(v, 0.36 * tempo * (0.9 + rnd() * 0.2), f0))); };
const silence = sec => new Float32Array(Math.round(sec * SR));
const noisy = (x, lvl) => x.map(v => v + (rnd() - 0.5) * lvl);

function feats(x) { const f = createFeaturizer(SR); const out = []; for (let i = 0; i < x.length; i += 4096) out.push(...f.push(x.subarray(i, i + 4096))); return out; }

const takes = [0.95, 1.0, 1.05].map(t => feats(noisy(concat([silence(0.4), chant(OM, t), silence(0.4)]), 0.004)));
const templates = takes.map(makeTemplate);
const base = calibrate(templates, takes);
console.log('패턴 길이(초):', templates.map(t => t.sec.toFixed(2)).join(', '), ' 기준 거리:', base.toFixed(2));

function run(label, seq, reps, expect) {
  const parts = [silence(1)];
  for (let r = 0; r < reps; r++) parts.push(chant(seq, 0.85 + rnd() * 0.3));
  parts.push(silence(1));
  const ev = [];
  const det = createDetector({ templates, base, onEvent: e => ev.push(e.type[0] + (e.score ? (e.score / base).toFixed(2) : '?')) });
  det.push(feats(noisy(concat(parts), 0.006)));
  console.log(`${label}: ${reps}번 외움 → 셈 ${det.count}, 놓침 ${det.miss}  (기대 ${expect})`);
  console.log('   기준 대비 점수:', ev.slice(0, 25).join(' '));
}
run('같은 만트라 20번 이어서', OM, 20, '셈 20');
run('같은 만트라 108번 이어서', OM, 108, '셈 108');
run('다른 만트라 10번', OTHER, 10, '셈 0');
