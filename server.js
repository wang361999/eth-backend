const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ===== 这里填你的Supabase信息 =====
const supabase = createClient(
  'https://artvmbjvbnsyarrcouqe.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFydHZtYmp2Ym5zeWFycmNvdXFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTgzNjEsImV4cCI6MjA5ODIzNDM2MX0.xsrJuHIKzQmsM9yX0qxg16FGIdPfVHwjLCcYHFuCYJ4'
);

let currentPrice = null;
let klineData = [];
let accountState = { balance: 10000, leverage: 5, isRunning: false };
let position = null;
let strategyResults = {};
let totalTrades = 0, wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;

// ===== 获取K线数据 =====
async function fetchKlines(interval, limit) {
  limit = limit || 500;
  try {
    const resp = await fetch(`https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=${interval}&limit=${limit}`);
    const raw = await resp.json();
    if (!Array.isArray(raw) || raw.length < 20) return null;
    return raw.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]),
      volume: parseFloat(k[5]), isClosed: true
    }));
  } catch(e) { console.error('K线失败:', e.message); return null; }
}

// ===== 策略计算 =====
function calcPivot(klines) {
  if (!klines || klines.length < 4) return null;
  var recent = klines.slice(-10).filter(k => k.isClosed);
  if (recent.length < 3) recent = klines.slice(-6);
  if (recent.length < 3) return null;
  var hh = 0, ll = Infinity, sc = 0;
  for (var i = 0; i < recent.length; i++) {
    if (recent[i].high > hh) hh = recent[i].high;
    if (recent[i].low < ll) ll = recent[i].low;
    sc += recent[i].close;
  }
  var P = (hh + ll + sc/recent.length) / 3, r = hh - ll;
  return { P: P, R1: 2*P-ll, R2: P+r, R3: 2*P-ll+r, S1: 2*P-hh, S2: P-r, S3: 2*P-hh-r };
}

function calcTD(klines) {
  if (!klines || klines.length < 20) return { bullCount: 0, bearCount: 0 };
  var bc = 0, bsc = 0;
  for (var i = klines.length - 1; i >= 4; i--) { if (klines[i].close > klines[i-4].close) bc++; else break; }
  for (var i = klines.length - 1; i >= 4; i--) { if (klines[i].close < klines[i-4].close) bsc++; else break; }
  return { bullCount: Math.min(bc, 9), bearCount: Math.min(bsc, 9) };
}

function calcBB(klines) {
  if (!klines || klines.length < 20) return null;
  var closes = klines.slice(-20).map(k => k.close), sum = 0;
  for (var i = 0; i < closes.length; i++) sum += closes[i];
  var sma = sum / 20, variance = 0;
  for (var i = 0; i < closes.length; i++) variance += Math.pow(closes[i] - sma, 2);
  var std = Math.sqrt(variance / 20);
  return { upper: sma + 2*std, middle: sma, lower: sma - 2*std };
}

function calcMACD(klines) {
  if (!klines || klines.length < 35) return null;
  var closes = klines.map(k => k.close);
  function ema(data, p) { var k = 2/(p+1), r = [data[0]]; for (var i=1; i<data.length; i++) r.push(data[i]*k+r[i-1]*(1-k)); return r; }
  var ef = ema(closes, 12), es = ema(closes, 26), dif = [], dea = [], hist = [];
  for (var i = 0; i < closes.length; i++) dif.push(ef[i] - es[i]);
  var ds = dif.slice(25), dv = ema(ds, 9);
  for (var i = 0; i < 25; i++) { dea.push(0); hist.push(0); }
  for (var i = 0; i < dv.length; i++) { dea.push(dv[i]); hist.push((dif[25+i] - dv[i]) * 2); }
  var ld = dif[dif.length-1], le = dea[dea.length-1], pd = dif[dif.length-2], pe = dea[dea.length-2];
  var status = ld > le ? (pd <= pe ? '金叉' : '多头') : (pd >= pe ? '死叉' : '空头');
  return { dif: dif, dea: dea, histogram: hist, status: status };
}

function calcPA(klines) {
  if (!klines || klines.length < 30) return null;
  var recent = klines.slice(-30), sh = [], sl = [];
  for (var i = 2; i < recent.length - 2; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i-2].high && recent[i].high > recent[i+1].high && recent[i].high > recent[i+2].high) sh.push(recent[i].high);
    if (recent[i].low < recent[i-1].low && recent[i].low < recent[i-2].low && recent[i].low < recent[i+1].low && recent[i].low < recent[i+2].low) sl.push(recent[i].low);
  }
  if (sh.length < 2 || sl.length < 2) return null;
  var upper = 0, lower = 0;
  for (var i = 0; i < Math.min(3, sh.length); i++) upper += sh[i];
  for (var i = 0; i < Math.min(3, sl.length); i++) lower += sl[i];
  upper /= Math.min(3, sh.length); lower /= Math.min(3, sl.length);
  var range = upper - lower, mid = (upper + lower) / 2;
  return { upper: upper, lower: lower, range: range, isRange: range < mid * 0.05 };
}

function generateSignal(td, pivot, bb, macd, pa, cp) {
  if (!cp) return { signal: 'wait', strength: 0, entryPrice: null, stopLoss: null, takeProfit1: null, analysisText: '等待...' };
  var signal = 'wait', strength = 0, entry = null, sl = null, tp = null, txt = '';
  if (pa && pa.isRange) {
    if (cp <= pa.lower * 1.01) { signal = 'long'; strength = 70; entry = cp; sl = pa.lower * 0.99; tp = pa.upper; txt = 'PA箱体下轨做多'; }
    else if (cp >= pa.upper * 0.99) { signal = 'short'; strength = 70; entry = cp; sl = pa.upper * 1.01; tp = pa.lower; txt = 'PA箱体上轨做空'; }
  }
  if (signal === 'wait' && pivot && td) {
    if (td.bullCount > td.bearCount && cp <= pivot.S1) { signal = 'long'; strength = td.bullCount >= 9 ? 85 : 65; entry = cp; sl = pivot.S2; tp = pivot.R1; txt = 'TD+Pivot做多'; }
    else if (td.bearCount > td.bullCount && cp >= pivot.R1) { signal = 'short'; strength = td.bearCount >= 9 ? 85 : 65; entry = cp; sl = pivot.R2; tp = pivot.S1; txt = 'TD+Pivot做空'; }
  }
  if (signal === 'wait' && bb) {
    if (cp <= bb.lower * 1.01) { signal = 'long'; strength = 55; entry = cp; sl = bb.lower * 0.99; tp = bb.middle; txt = '布林下轨做多'; }
    else if (cp >= bb.upper * 0.99) { signal = 'short'; strength = 55; entry = cp; sl = bb.upper * 1.01; tp = bb.middle; txt = '布林上轨做空'; }
  }
  if (signal === 'wait' && macd) {
    if (macd.status === '金叉' && pivot && cp <= pivot.S1) { signal = 'long'; strength = 65; entry = cp; sl = cp * 0.985; tp = cp * 1.03; txt = 'MACD金叉做多'; }
    else if (macd.status === '死叉' && pivot && cp >= pivot.R1) { signal = 'short'; strength = 65; entry = cp; sl = cp * 1.015; tp = cp * 0.97; txt = 'MACD死叉做空'; }
  }
  if (signal === 'wait' && pivot) {
    if (cp <= pivot.S3) { signal = 'long'; strength = 45; entry = cp; sl = cp * 0.98; tp = pivot.S1; txt = 'Pivot超卖做多'; }
    else if (cp >= pivot.R3) { signal = 'short'; strength = 45; entry = cp; sl = cp * 1.02; tp = pivot.R1; txt = 'Pivot超买做空'; }
  }
  return { signal: signal, strength: strength, entryPrice: entry, stopLoss: sl, takeProfit1: tp, analysisText: txt };
}

function calculateAll() {
  if (klineData.length < 30) return;
  var td = calcTD(klineData), pivot = calcPivot(klineData);
  var bb = calcBB(klineData), macd = calcMACD(klineData), pa = calcPA(klineData);
  var sig = generateSignal(td, pivot, bb, macd, pa, currentPrice);
  strategyResults = { td, pivot, bb, macd, pa, signal: sig, timestamp: Date.now() };
  if (accountState.isRunning && !position && sig.signal !== 'wait' && sig.strength >= 50) openPosition(sig);
  return strategyResults;
}

function openPosition(sig) {
  var size = 0.02, margin = size * sig.entryPrice / accountState.leverage;
  position = { direction: sig.signal, entryPrice: sig.entryPrice, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit1, size: size, margin: margin, openTime: new Date() };
  totalTrades++; console.log('📈 开仓:', sig.signal, sig.entryPrice);
}

function checkExit() {
  if (!position || !currentPrice) return;
  var ep = null, rs = '';
  if (position.direction === 'long') {
    if (currentPrice <= position.stopLoss) { ep = position.stopLoss; rs = '止损'; }
    else if (currentPrice >= position.takeProfit) { ep = position.takeProfit; rs = '止盈'; }
  } else {
    if (currentPrice >= position.stopLoss) { ep = position.stopLoss; rs = '止损'; }
    else if (currentPrice <= position.takeProfit) { ep = position.takeProfit; rs = '止盈'; }
  }
  if (ep) {
    var pnl = position.direction === 'long' ? (ep - position.entryPrice) * position.size * accountState.leverage : (position.entryPrice - ep) * position.size * accountState.leverage;
    accountState.balance += pnl;
    if (pnl > 0) { wins++; totalProfit += pnl; } else { losses++; totalLoss += Math.abs(pnl); }
    supabase.from('trades').insert({ direction: position.direction, entry_price: position.entryPrice, exit_price: ep, pnl: pnl, reason: rs }).then(function() {});
    position = null; saveAccount(); console.log('💰 平仓:', rs, pnl.toFixed(2));
  }
}

function saveAccount() {
  supabase.from('account').upsert({ id: 1, balance: accountState.balance, leverage: accountState.leverage, is_running: accountState.isRunning }).then(function() {});
}

function connectWS(interval) {
  var ws = new WebSocket('wss://stream.binance.com:9443/ws/ethusdt@kline_' + interval);
  ws.on('open', function() { console.log('✅ WS连接'); });
  ws.on('message', function(data) {
    try {
      var msg = JSON.parse(data.toString());
      if (msg.e === 'kline') {
        var k = msg.k; currentPrice = parseFloat(k.c);
        var ct = Math.floor(k.t / 1000);
        var candle = { time: ct, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v), isClosed: k.x };
        var found = false;
        for (var i = 0; i < klineData.length; i++) { if (klineData[i].time === ct) { klineData[i] = candle; found = true; break; } }
        if (!found) klineData.push(candle);
        klineData.sort(function(a, b) { return a.time - b.time; });
        if (klineData.length > 800) klineData = klineData.slice(-800);
        checkExit();
        if (k.x) calculateAll();
      }
    } catch(e) {}
  });
  ws.on('close', function() { setTimeout(function() { connectWS(interval); }, 3000); });
}

// ===== API接口 =====
app.get('/api/status', function(req, res) {
  res.json({
    price: currentPrice,
    position: position,
    account: { balance: accountState.balance, leverage: accountState.leverage, isRunning: accountState.isRunning, totalTrades, wins, losses, totalProfit, totalLoss },
    strategies: strategyResults,
    klineCount: klineData.length
  });
});

app.get('/api/klines', function(req, res) { res.json(klineData.slice(-300)); });

app.get('/api/history', async function(req, res) {
  var { data } = await supabase.from('trades').select('*').order('created_at', { ascending: false }).limit(50);
  res.json(data || []);
});

app.post('/api/start', function(req, res) { accountState.isRunning = true; saveAccount(); res.json({ success: true }); });
app.post('/api/stop', function(req, res) { accountState.isRunning = false; saveAccount(); res.json({ success: true }); });
app.post('/api/close', function(req, res) {
  if (!position || !currentPrice) { res.json({ success: false }); return; }
  var pnl = position.direction === 'long' ? (currentPrice - position.entryPrice) * position.size * accountState.leverage : (position.entryPrice - currentPrice) * position.size * accountState.leverage;
  accountState.balance += pnl;
  if (pnl > 0) { wins++; totalProfit += pnl; } else { losses++; totalLoss += Math.abs(pnl); }
  supabase.from('trades').insert({ direction: position.direction, entry_price: position.entryPrice, exit_price: currentPrice, pnl: pnl, reason: '手动平仓' }).then(function() {});
  position = null; saveAccount(); res.json({ success: true, pnl: pnl });
});
app.get('/api/reset', function(req, res) {
  accountState.balance = 10000; totalTrades = 0; wins = 0; losses = 0; totalProfit = 0; totalLoss = 0;
  position = null; accountState.isRunning = false; saveAccount();
  supabase.from('trades').delete().neq('id', 0).then(function() {});
  res.json({ success: true });
});
app.get('/', function(req, res) { res.send('✅ ETH交易系统后端运行中'); });

var PORT = process.env.PORT || 3000;
app.listen(PORT, async function() {
  console.log('🚀 端口:', PORT);
  var { data } = await supabase.from('account').select('*').eq('id', 1).single();
  if (data) { accountState.balance = data.balance || 10000; accountState.leverage = data.leverage || 5; accountState.isRunning = data.isRunning || false; }
  var klines = await fetchKlines('4h', 500);
  if (klines) { klineData = klines; if (klineData.length > 0) currentPrice = klineData[klineData.length - 1].close; calculateAll(); }
  connectWS('4h');
  setInterval(function() { saveAccount(); }, 30000);
});
