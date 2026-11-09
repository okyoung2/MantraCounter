// 시험판(버려도 되는 코드): 소리 → 특징(MFCC) → 녹음한 만트라 패턴을 이어진 소리에서 찾아 세기.
// 브라우저와 node 둘 다에서 쓰도록 DOM 없이 작성.

export const HOP_SEC = 0.02;
const N_MEL = 26;
const N_CEP = 12; // c1..c12 (c0=음량은 버림)

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function melBank(N, sr, lo, hi) {
  const mel = f => 2595 * Math.log10(1 + f / 700);
  const inv = m => 700 * (10 ** (m / 2595) - 1);
  const pts = [];
  for (let k = 0; k < N_MEL + 2; k++) pts.push(Math.floor((N + 1) * inv(mel(lo) + (mel(hi) - mel(lo)) * k / (N_MEL + 1)) / sr));
  const bank = [];
  for (let m = 1; m <= N_MEL; m++) {
    const a = pts[m - 1], c = pts[m], b = pts[m + 1], w = [];
    for (let k = a; k <= b; k++) w.push(k < c ? (k - a) / Math.max(1, c - a) : (b - k) / Math.max(1, b - c));
    bank.push({ start: a, w });
  }
  return bank;
}

export function createFeaturizer(sr) {
  const hop = Math.round(sr * HOP_SEC);
  let N = 256; while (N < sr * 0.032) N *= 2;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const bank = melBank(N, sr, 80, Math.min(7000, sr / 2 - 1));
  const cos = [];
  for (let k = 1; k <= N_CEP; k++) cos.push(Float64Array.from({ length: N_MEL }, (_, m) => Math.cos(Math.PI * k * (m + 0.5) / N_MEL)));
  const re = new Float64Array(N), im = new Float64Array(N), logMel = new Float64Array(N_MEL);
  let pending = new Float32Array(0), prev = 0;

  function frame(buf) {
    for (let i = 0; i < N; i++) { re[i] = buf[i] * win[i]; im[i] = 0; }
    fft(re, im);
    let tot = 0;
    for (let k = 0; k <= N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; re[k] = p; tot += p; }
    for (let m = 0; m < N_MEL; m++) {
      const { start, w } = bank[m]; let s = 0;
      for (let k = 0; k < w.length; k++) s += re[start + k] * w[k];
      logMel[m] = Math.log(s + 1e-10);
    }
    const c = new Float32Array(N_CEP);
    for (let k = 0; k < N_CEP; k++) { let s = 0; for (let m = 0; m < N_MEL; m++) s += logMel[m] * cos[k][m]; c[k] = s; }
    return { c, e: 10 * Math.log10(tot / N + 1e-12) };
  }

  return {
    push(samples) {
      const next = new Float32Array(pending.length + samples.length);
      next.set(pending);
      for (let i = 0; i < samples.length; i++) { next[pending.length + i] = samples[i] - 0.97 * prev; prev = samples[i]; }
      const out = [];
      let off = 0;
      while (next.length - off >= N) { out.push(frame(next.subarray(off, off + N))); off += hop; }
      pending = next.slice(off);
      return out;
    },
  };
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function dist(a, b) { let s = 0; for (let k = 0; k < a.length; k++) { const d = a[k] - b[k]; s += d * d; } return Math.sqrt(s); }

// 녹음 1개 → 앞뒤 조용한 부분을 잘라 낸 패턴
export function makeTemplate(frames) {
  const loud = pct(frames.map(f => f.e), 0.9);
  const floor = pct(frames.map(f => f.e), 0.05); // 주변 잡음 크기
  const thr = Math.max(loud - 25, floor + Math.max(6, (loud - floor) * 0.35));
  let a = 0, b = frames.length - 1;
  while (a < b && frames[a].e < thr) a++;
  while (b > a && frames[b].e < thr) b--;
  const t = frames.slice(Math.max(0, a - 1), Math.min(frames.length, b + 2));
  const mean = new Float32Array(N_CEP);
  for (const f of t) for (let k = 0; k < N_CEP; k++) mean[k] += f.c[k] / t.length;
  return { vecs: t.map(f => f.c.map((v, k) => v - mean[k])), mean: Array.from(mean), loud, floor, sec: t.length * HOP_SEC };
}

const W_OFF = 1.3; // 늘이기/줄이기(대각선이 아닌 걸음)에 주는 벌점

// 두 패턴 전체를 맞춰 본 평균 거리
export function dtwCost(A, B) {
  const n = A.length, m = B.length;
  let pD = new Float64Array(m).fill(Infinity), pL = new Float64Array(m);
  let cD = new Float64Array(m), cL = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const d = dist(A[i], B[j]);
      if (i === 0 && j === 0) { cD[0] = d; cL[0] = 1; continue; }
      let bD = Infinity, bL = 1, best = Infinity;
      const opts = [[i > 0 && j > 0 ? pD[j - 1] : Infinity, pL[j - 1], d],
        [i > 0 ? pD[j] : Infinity, pL[j], d * W_OFF],
        [j > 0 ? cD[j - 1] : Infinity, cL[j - 1], d * W_OFF]];
      for (const [D, L, dd] of opts) { const v = (D + dd) / (L + 1); if (v < best) { best = v; bD = D + dd; bL = L + 1; } }
      cD[j] = bD; cL[j] = bL;
    }
    [pD, cD] = [cD, pD]; [pL, cL] = [cL, pL];
  }
  return pD[m - 1] / pL[m - 1];
}

// 녹음마다 나머지 두 녹음으로 찾아보게 해서 나온 거리의 평균 = "같은 만트라"의 기준 거리
// (실제로 셀 때와 똑같은 계산을 쓰므로 기준이 맞는다)
export function calibrate(templates, framesList) {
  const c = [];
  templates.forEach((_, k) => {
    const det = createDetector({ templates: templates.filter((_, j) => j !== k), base: 1 });
    let mn = Infinity;
    for (const f of framesList[k]) { det.push([f]); if (det.lastScore != null) mn = Math.min(mn, det.lastScore); }
    if (isFinite(mn)) c.push(mn);
  });
  return c.reduce((a, b) => a + b, 0) / c.length;
}

// 이어진 소리 안에서 패턴 하나가 지금 막 끝났는지 보는 계산(시작 위치 자유)
function makeMatcher(T) {
  const M = T.length;
  let D = new Float64Array(M).fill(Infinity), L = new Float64Array(M), S = new Int32Array(M);
  let nD = new Float64Array(M), nL = new Float64Array(M), nS = new Int32Array(M);
  const maxSpan = Math.round(1.8 * M);
  return {
    M,
    step(x, i) {
      // 너무 오래 늘어진 길은 버린다(안 그러면 옛날 길이 계속 이김)
      for (let j = 0; j < M; j++) if (i - S[j] > maxSpan) D[j] = Infinity;
      nD[0] = dist(x, T[0]); nL[0] = 1; nS[0] = i;
      for (let j = 1; j < M; j++) {
        const d = dist(x, T[j]);
        // 대각선, 입력만 진행(패턴을 늘려 말함), 패턴만 진행(빨리 말함) 중 합이 가장 작은 길
        let bD = D[j - 1] + d, bL = L[j - 1] + 1, bS = S[j - 1];
        if (D[j] + d * W_OFF < bD) { bD = D[j] + d * W_OFF; bL = L[j] + 1; bS = S[j]; }
        if (nD[j - 1] + d * W_OFF < bD) { bD = nD[j - 1] + d * W_OFF; bL = nL[j - 1] + 1; bS = nS[j - 1]; }
        nD[j] = bD; nL[j] = bL; nS[j] = bS;
      }
      [D, nD] = [nD, D]; [L, nL] = [nL, L]; [S, nS] = [nS, S];
      const span = i - S[M - 1] + 1;
      if (!isFinite(D[M - 1]) || span < 0.6 * M || span > 1.8 * M) return null;
      return { score: D[M - 1] / L[M - 1], start: S[M - 1] };
    },
  };
}

// 판정: 확실(sure) 아래면 1회, 애매(maybe) 사이면 놓침 1회.
export function createDetector({ templates, base, sens = 1.5, onEvent = () => {} }) {
  const matchers = templates.map(t => makeMatcher(t.vecs));
  const M = matchers.reduce((a, m) => a + m.M, 0) / matchers.length;
  const mean = Float32Array.from({ length: N_CEP }, (_, k) => templates.reduce((a, t) => a + t.mean[k], 0) / templates.length);
  const avg = key => templates.reduce((a, t) => a + t[key], 0) / templates.length;
  const voiceThr = Math.max(avg('loud') - 30, avg('floor') + 6);
  const det = {
    sens, i: 0, count: 0, miss: 0, lastScore: null,
    get thrSure() { return base * det.sens; },
    get thrMaybe() { return base * det.sens * 1.35; },
  };
  let cand = null, lastEnd = -Infinity, anchor = null, lastVoiced = -Infinity;

  function fire(type, reason, score, frame) {
    if (type === 'count') det.count++; else det.miss++;
    onEvent({ type, reason, score, frame, count: det.count, miss: det.miss });
  }

  det.push = function (frames) {
    for (const f of frames) {
      const i = det.i++;
      const voiced = f.e > voiceThr;
      if (voiced) {
        for (let k = 0; k < N_CEP; k++) mean[k] += (f.c[k] - mean[k]) / 100;
        if (anchor === null) anchor = i;
        lastVoiced = i;
      } else if (i - lastVoiced > 25) anchor = null;
      const x = f.c.map((v, k) => v - mean[k]);

      let best = null;
      for (const m of matchers) { const r = m.step(x, i); if (r && (!best || r.score < best.score)) best = r; }
      det.lastScore = best ? best.score : null;

      if (best && best.score < det.thrMaybe && best.start >= lastEnd - 0.3 * M && i - lastEnd >= 0.5 * M) {
        if (!cand || best.score < cand.score) cand = { score: best.score, frame: i };
      }
      if (cand && i - cand.frame >= 0.3 * M) {
        if (cand.score < det.thrSure) fire('count', 'match', cand.score, cand.frame);
        else fire('miss', 'unsure', cand.score, cand.frame);
        lastEnd = cand.frame; anchor = cand.frame; cand = null;
      }
      // 소리는 계속 나는데 한참 동안 아무것도 못 찾았으면 놓친 것으로 본다
      if (!cand && anchor !== null && i - anchor > 1.9 * M) {
        fire('miss', 'timeout', null, i);
        anchor += M; lastEnd = Math.max(lastEnd, anchor);
      }
    }
  };
  return det;
}
