// 6인 프리플랍 차트 생성기 (오프라인, Node.js)
// 사용: node tools/preflop_solver.js out.json [반복수]
// 모델
//  - 앞사람 전부 폴드 → 오프너가 폴드 / 오픈 / (짧으면) 올인
//  - 오픈 뒤 뒷사람이 순서대로 폴드 / 콜 / 3벳 / (짧으면) 3벳 올인. 처음으로 폴드하지 않은 1명만 대응(단일 대응자)
//  - 3벳 → 오프너 폴드 / 콜 / 4벳 / 올인 → 3벳터 폴드 / 콜 / 올인 → 오프너 폴드 / 콜
//  - 콜로 끝나면 플랍 이후 가치 = 팟 × 승률을 실현계수(포지션·핸드 종류·SPR)로 보정한 몫, 올인은 승률표 그대로
//  - 169개 핸드 클래스 벡터로 CFR(DCFR) 반복, 카드 겹침은 승률표의 호환 콤보 수로 반영
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

function loadEngine() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const get = id => new RegExp('<script[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</script>').exec(html)[1];
  const fn = new Function(get('engine') + '\nloadPfeq(' + JSON.stringify(get('d-pfeq')) + ');\nreturn {CLASSES, PFEQ, PFN, PFM};');
  return fn();
}
const POS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
const CFG = {
  sb: 0.5, bb: 1, bbAnte: 1,
  open: { UTG: 2.2, HJ: 2.2, CO: 2.2, BTN: 2.2, SB: 3 },
  threeIP: 3, threeOOP: 4, four: 2.2, fourMaxFrac: 0.4,
  openJamMax: 30, threeJamMax: 60,
  realize: { ip: 1.05, oop: 0.8, slope: 0.8, pair: 0.04, suited: 0.05, conn: 0.03, off: -0.04, sprFull: 5, min: 0.3, max: 1.3, mwPenalty: 0.07 },
  depths: [25, 40, 60, 100]
};

function solveDepth(S, iters, E) {
  const { CLASSES, PFEQ, PFN, PFM } = E, H = 169;
  const live = k => POS[k] === 'SB' ? CFG.sb : POS[k] === 'BB' ? CFG.bb : 0;
  const dead = k => POS[k] === 'BB' ? CFG.bbAnte : 0;
  const posts = CFG.sb + CFG.bb + CFG.bbAnte;
  const postOrder = ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'];
  const isIP = (a, b) => postOrder.indexOf(POS[a]) > postOrder.indexOf(POS[b]);
  const handAdj = CLASSES.map(c => { const R = CFG.realize; let x = 0; if (c.type === 'p') x += R.pair; else { if (c.type === 's') x += R.suited; else x += R.off; if (c.hi - c.lo <= 2) x += R.conn; } return x; });
  const N = PFN, M = PFM;
  // ---- 행렬 유틸 ----
  const mv = (A, w, out) => { for (let h = 0; h < H; h++) { let s = 0; const o = h * H; for (let c = 0; c < H; c++) { const x = w[c]; if (x) s += x * A[o + c]; } out[h] = s; } return out; };
  const realCache = new Map();
  const realMat = (t, o, spr, behind) => { // t 관점 실현 승률 몫 행렬 (N 포함), behind = 콜 뒤에 남은(스퀴즈·오버콜 가능) 인원 가중치
    const key = t + '|' + o + '|' + spr.toFixed(2) + '|' + behind; if (realCache.has(key)) return realCache.get(key);
    // 실현계수: 각자 독립 (합이 1이 아님 = 못 실현한 몫은 사라짐). 약한 승률일수록 덜 실현, SPR이 낮을수록 1에 가까워짐
    const R = CFG.realize, k = Math.min(1, spr / R.sprFull), tip = isIP(t, o), base = tip ? R.ip : R.oop, mw = Math.max(0.5, 1 - R.mwPenalty * (behind || 0));
    const A = new Float64Array(H * H);
    for (let h = 0; h < H; h++) for (let c = 0; c < H; c++) { const e = PFEQ[h * H + c]; let r = base + R.slope * (e - 0.5) + handAdj[h]; r = Math.min(R.max, Math.max(R.min, r)); r = (1 - (1 - r) * k) * mw; A[h * H + c] = N[h * H + c] * e * r; }
    realCache.set(key, A); return A;
  };
  // ---- 트리 ----
  const nodes = []; // 차트로 내보낼 결정 노드
  const act = (id, p, names) => { const n = { type: 'act', id, p, names, kids: [], reg: new Float64Array(names.length * H), ss: new Float64Array(names.length * H) }; nodes.push(n); return n; };
  const term = (type, i, k, invI, invK, extra = {}) => Object.assign({ type, i, k, inv: { [i]: invI, [k]: invK }, pot: posts + invI + invK }, extra);
  const commit = x => S - dead(x);
  const build = i => {
    const root = act('rfi|' + POS[i], i, S <= CFG.openJamMax ? ['fold', 'open', 'jam'] : ['fold', 'open']);
    const O = CFG.open[POS[i]];
    root.kids.push({ type: 'zero' });
    // 오픈 체인
    const chain = (k, jam) => {
      if (k >= POS.length) return { type: 'steal' };
      const X0 = jam ? commit(i) : O;
      if (jam) { // 올인에 대한 대응: 폴드 / 콜
        const n = act('rj|' + POS[i] + '|' + POS[k], k, ['fold', 'call']); n.chain = true; n.i = i;
        const eff = Math.min(commit(i), commit(k));
        n.kids.push(chain(k + 1, true)); n.kids.push(term('allin', i, k, eff - live(i), eff - live(k)));
        return n;
      }
      const ip = isIP(k, i), X3 = Math.round(O * (ip ? CFG.threeIP : CFG.threeOOP) * 10) / 10;
      const names = ['fold', 'call', '3bet']; if (S <= CFG.threeJamMax) names.push('jam');
      const n = act('resp|' + POS[i] + '|' + POS[k], k, names); n.chain = true; n.i = i;
      n.kids.push(chain(k + 1, false));
      n.kids.push(term('post', i, k, O - live(i), O - live(k), { spr: (S - O) / (posts + 2 * O - live(i) - live(k)), behind: POS.length - 1 - k }));
      // 3벳 서브트리
      const v3names = ['fold', 'call']; const X4 = Math.round(X3 * CFG.four * 10) / 10, can4 = X4 < CFG.fourMaxFrac * S; if (can4) v3names.push('4bet'); v3names.push('jam');
      const v3 = act('v3|' + POS[i] + '|' + POS[k], i, v3names);
      v3.kids.push(term('fold', i, k, O - live(i), X3 - live(k), { loser: i }));
      v3.kids.push(term('post', i, k, X3 - live(i), X3 - live(k), { spr: (S - X3) / (posts + 2 * X3 - live(i) - live(k)), behind: (POS.length - 1 - k) / 2 }));
      const eff = Math.min(commit(i), commit(k));
      if (can4) {
        const v4 = act('v4|' + POS[i] + '|' + POS[k], k, ['fold', 'call', 'jam']);
        v4.kids.push(term('fold', i, k, X4 - live(i), X3 - live(k), { loser: k }));
        v4.kids.push(term('post', i, k, X4 - live(i), X4 - live(k), { spr: (S - X4) / (posts + 2 * X4 - live(i) - live(k)) }));
        const v5 = act('v5|' + POS[i] + '|' + POS[k], i, ['fold', 'call']);
        v5.kids.push(term('fold', i, k, X4 - live(i), eff - live(k), { loser: i }));
        v5.kids.push(term('allin', i, k, eff - live(i), eff - live(k)));
        v4.kids.push(v5); v3.kids.push(v4);
      }
      const vj4 = act('vj4|' + POS[i] + '|' + POS[k], k, ['fold', 'call']);
      vj4.kids.push(term('fold', i, k, eff - live(i), X3 - live(k), { loser: k }));
      vj4.kids.push(term('allin', i, k, eff - live(i), eff - live(k)));
      v3.kids.push(vj4);
      n.kids.push(v3);
      if (names.includes('jam')) {
        const vj3 = act('vj3|' + POS[i] + '|' + POS[k], i, ['fold', 'call']);
        vj3.kids.push(term('fold', i, k, O - live(i), eff - live(k), { loser: i }));
        vj3.kids.push(term('allin', i, k, eff - live(i), eff - live(k)));
        n.kids.push(vj3);
      }
      return n;
    };
    root.kids.push(chain(i + 1, false));
    if (root.names.includes('jam')) root.kids.push(chain(i + 1, true));
    return root;
  };
  const roots = []; for (let i = 0; i < 5; i++) roots.push(build(i));
  // ---- CFR ----
  const full = new Float64Array(H).fill(1 / 1225);
  let dPos = 1, dNeg = 0.5, dSum = 1;
  const strat = (n, avg, dst) => { const nA = n.names.length, src = avg ? n.ss : n.reg; for (let h = 0; h < H; h++) { let z = 0; for (let a = 0; a < nA; a++) { const x = src[a * H + h]; if (x > 0) z += x; } for (let a = 0; a < nA; a++) { const x = src[a * H + h]; dst[a * H + h] = z > 0 ? (x > 0 ? x / z : 0) : 1 / nA; } } return dst; };
  const D = w => mv(N, w, new Float64Array(H));
  // cfv: 행동 중인 2인 서브게임에서 t의 클래스별 반사실 가치. w = 상대 도달 가중치. mode 0 갱신, 2 평균 전략 평가
  function cfv(n, t, rT, w, mode) {
    const out = new Float64Array(H);
    if (n.type === 'zero') return out;
    if (n.type === 'steal') { out.fill(posts); return out; }
    if (n.type === 'fold') { const d = D(w), o = t === n.i ? n.k : n.i, v = n.loser === t ? -n.inv[t] : posts + n.inv[o]; for (let h = 0; h < H; h++) out[h] = v * d[h]; return out; }
    if (n.type === 'post' || n.type === 'allin') { const o = t === n.i ? n.k : n.i, A = n.type === 'post' ? realMat(t, o, Math.max(0, n.spr), n.behind || 0) : M, tmp = mv(A, w, new Float64Array(H)), d = D(w); for (let h = 0; h < H; h++) out[h] = n.pot * tmp[h] - n.inv[t] * d[h]; return out; }
    const nA = n.names.length, st = strat(n, mode === 2, new Float64Array(nA * H));
    if (n.chain && t === n.i) { // 오프너 관점: 대응자 n.p는 전체 레인지에서 행동, 폴드면 다음 대응자로
      const fw = new Float64Array(H); for (let c = 0; c < H; c++) fw[c] = full[c] * st[c];
      const F = D(fw), nxt = cfv(n.kids[0], t, rT, full, mode);
      for (let h = 0; h < H; h++) out[h] = F[h] * nxt[h];
      for (let a = 1; a < nA; a++) { const wa = new Float64Array(H); for (let c = 0; c < H; c++) wa[c] = full[c] * st[a * H + c]; const v = cfv(n.kids[a], t, rT, wa, mode); for (let h = 0; h < H; h++) out[h] += v[h]; }
      return out;
    }
    if (n.p === t) {
      const vals = []; for (let a = 0; a < nA; a++) { const r = new Float64Array(H); for (let h = 0; h < H; h++) r[h] = rT[h] * st[a * H + h]; vals.push(n.chain && a === 0 ? new Float64Array(H) : cfv(n.kids[a], t, r, w, mode)); }
      for (let h = 0; h < H; h++) { let v = 0; for (let a = 0; a < nA; a++) v += st[a * H + h] * vals[a][h]; out[h] = v; }
      if (mode === 0) for (let a = 0; a < nA; a++) for (let h = 0; h < H; h++) { const ix = a * H + h; let r = n.reg[ix]; r *= r > 0 ? dPos : dNeg; n.reg[ix] = r + vals[a][h] - out[h]; n.ss[ix] = n.ss[ix] * dSum + rT[h] * st[ix]; }
      if (mode === 2) n.ev = vals.map(v => v.slice());
      return out;
    }
    for (let a = 0; a < nA; a++) { const wa = new Float64Array(H); for (let c = 0; c < H; c++) wa[c] = w[c] * st[a * H + c]; const v = cfv(n.kids[a], t, rT, wa, mode); for (let h = 0; h < H; h++) out[h] += v[h]; }
    return out;
  }
  const ones = new Float64Array(H).fill(1);
  // 대응자 k의 체인 노드 목록 (오프너 i 기준)
  const chainNodes = root => { const L = []; const walk = n => { if (!n || n.type !== 'act') return; if (n.chain) { L.push(n); walk(n.kids[0]); } }; walk(root.kids[1]); if (root.kids[2]) walk(root.kids[2]); return L; };
  const openW = (root, a) => { const st = strat(root, false, new Float64Array(root.names.length * H)); const w = new Float64Array(H); for (let h = 0; h < H; h++) w[h] = st[a * H + h]; return w; };
  for (let it = 1; it <= iters; it++) {
    const ta = Math.pow(it, 1.5); dPos = ta / (ta + 1); dNeg = 0.5; dSum = Math.pow(it / (it + 1), 2);
    for (const root of roots) {
      cfv(root, root.p, ones, full, 0);
      const wOpen = openW(root, 1), wJam = root.names.includes('jam') ? openW(root, 2) : null;
      for (const cn of chainNodes(root)) cfv(cn, cn.p, ones, cn.id.startsWith('rj|') ? wJam : wOpen, 0);
    }
  }
  // 평균 전략 평가 → 노드별 EV
  for (const root of roots) {
    cfv(root, root.p, ones, full, 2);
    const wOpen = (() => { const st = strat(root, true, new Float64Array(root.names.length * H)); const w = new Float64Array(H); for (let h = 0; h < H; h++) w[h] = st[H + h]; return w; })();
    const wJam = root.names.includes('jam') ? (() => { const st = strat(root, true, new Float64Array(root.names.length * H)); const w = new Float64Array(H); for (let h = 0; h < H; h++) w[h] = st[2 * H + h]; return w; })() : null;
    for (const cn of chainNodes(root)) {
      const w = cn.id.startsWith('rj|') ? wJam : wOpen; cfv(cn, cn.p, ones, w, 2);
      // 하위 노드: 상대 도달 가중치로 정규화하기 위해 한 번 더 평가 (opp 질량)
      const evalSub = (n, t, wOpp) => { if (!n || n.type !== 'act' || n.chain) return; cfv(n, t, ones, wOpp, 2); n.mass = D(wOpp); };
      cn.mass = D(w);
      const st = strat(cn, true, new Float64Array(cn.names.length * H));
      const a3 = cn.names.indexOf('3bet'), aj = cn.names.indexOf('jam');
      if (a3 >= 0) { // v3: 오프너 관점, 상대(3벳터) 도달 = 전체 × 3벳 빈도
        const w3 = new Float64Array(H); for (let c = 0; c < H; c++) w3[c] = full[c] * st[a3 * H + c];
        const v3 = cn.kids[a3]; evalSub(v3, v3.p, w3);
        const s3 = strat(v3, true, new Float64Array(v3.names.length * H));
        const i4 = v3.names.indexOf('4bet'), ij = v3.names.indexOf('jam');
        const wI = a => { const x = new Float64Array(H); for (let h = 0; h < H; h++) x[h] = w[h] * s3[a * H + h]; return x; };
        if (i4 >= 0) { const v4 = v3.kids[i4]; evalSub(v4, v4.p, wI(i4)); const s4 = strat(v4, true, new Float64Array(v4.names.length * H)); const x = new Float64Array(H); for (let c = 0; c < H; c++) x[c] = w3[c] * s4[2 * H + c]; evalSub(v4.kids[2], v4.kids[2].p, x); }
        if (ij >= 0) { const vj4 = v3.kids[ij]; evalSub(vj4, vj4.p, wI(ij)); }
      }
      if (aj >= 0) { const x = new Float64Array(H); for (let c = 0; c < H; c++) x[c] = full[c] * st[aj * H + c]; evalSub(cn.kids[aj], cn.kids[aj].p, x); }
    }
    root.mass = new Float64Array(H).fill(1);
  }
  // 내보내기: 노드별 [액션][핸드] 빈도(0~255)와 EV(폴드 대비, 0.1bb 단위 Int8)
  const out = { S, nodes: [] };
  for (const n of nodes) {
    const st = strat(n, true, new Float64Array(n.names.length * H)), fz = n.names.indexOf('fold');
    const ev = n.ev ? n.ev.map(v => Array.from(v, (x, h) => n.mass && n.mass[h] > 1e-12 ? x / n.mass[h] : 0)) : null;
    out.nodes.push({ id: n.id, names: n.names, freq: n.names.map((_, a) => Array.from({ length: H }, (_, h) => st[a * H + h])), ev: ev ? ev.map(v => v.map((x, h) => fz >= 0 ? x - ev[fz][h] : x)) : null });
  }
  return out;
}

if (isMainThread) {
  const outFile = process.argv[2] || 'charts.json', iters = +(process.argv[3] || 1200), t0 = Date.now();
  let done = 0; const results = [];
  CFG.depths.forEach((S, idx) => {
    const w = new Worker(__filename, { workerData: { S, iters } });
    w.on('message', r => { results[idx] = r; console.log(`${S}bb 완료 ${((Date.now() - t0) / 1000).toFixed(0)}s`); if (++done === CFG.depths.length) finish(); });
    w.on('error', e => { console.error(e); process.exit(1); });
  });
  function finish() {
    const ids = results[0].nodes.map(n => n.id);
    const meta = { version: 1, model: '6인 프리플랍 자체 솔버 (단일 대응자, 실현계수, BB 앤티)', iters, cfg: CFG, depths: CFG.depths, nodes: [] };
    const ORDER = ['fold', 'check', 'call', 'open', '3bet', '4bet', 'jam'], all = new Map();
    results.forEach(r => r.nodes.forEach(n => { const u = new Set([...(all.get(n.id) || []), ...n.names]); all.set(n.id, ORDER.filter(x => u.has(x))); }));
    for (const [id, names] of all) meta.nodes.push({ id, names });
    // 이진: 깊이별 → 노드별 → 액션별 169 빈도 바이트 + 169 EV 바이트 (없는 노드는 0)
    const parts = [];
    for (const r of results) { const m = new Map(r.nodes.map(n => [n.id, n])); for (const nd of meta.nodes) { const n = m.get(nd.id); for (let a = 0; a < nd.names.length; a++) { const f = new Uint8Array(169), e = new Int8Array(169); if (n) { const ai = n.names.indexOf(nd.names[a]); if (ai >= 0) for (let h = 0; h < 169; h++) { f[h] = Math.round(n.freq[ai][h] * 255); e[h] = n.ev ? Math.max(-127, Math.min(127, Math.round(n.ev[ai][h] * 10))) : 0; } } parts.push(Buffer.from(f), Buffer.from(e.buffer)); } } }
    const bin = Buffer.concat(parts), z = zlib.deflateRawSync(bin, { level: 9 });
    fs.writeFileSync(outFile, JSON.stringify({ meta, b64: z.toString('base64') }));
    console.log(`저장 ${outFile}: 노드 ${meta.nodes.length}개, 원본 ${bin.length}B → 압축 ${z.length}B, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    // 요약
    const E = loadEngine();
    for (const r of results) { const rfi = r.nodes.filter(n => n.id.startsWith('rfi|')).map(n => { const fz = n.names.indexOf('fold'); return n.id.slice(4) + ' ' + (100 - n.freq[fz].reduce((s, x, h) => s + x * E.CLASSES[h].combos, 0) / 13.26).toFixed(0) + '%'; }); console.log(`${r.S}bb 오픈(+올인): ${rfi.join(', ')}`); }
  }
} else {
  const E = loadEngine();
  parentPort.postMessage(solveDepth(workerData.S, workerData.iters, E));
}
