#!/usr/bin/env node
/**
 * Capacity/load test bot swarm for the quiz server.
 *
 * Spins up N fake players (per session, across M concurrent sessions), plays
 * a full game against a real running server over real socket.io connections,
 * and reports join/answer latency percentiles plus server-side metrics
 * (event loop lag, sqlite write latency, memory, connected sockets) sampled
 * from GET /api/admin/metrics while the test runs.
 *
 * Usage:
 *   node scripts/load-test.mjs --url http://localhost:3000 \
 *     --email admin --password '<admin password>' \
 *     --players 100 --sessions 1 --questions 5 --time 15
 *
 * Flags:
 *   --url             server base URL              (default http://localhost:3000)
 *   --email           admin username or user email  (required; or ADMIN_USERNAME env)
 *   --password        admin/user password           (required; or ADMIN_PASSWORD env)
 *   --players         bots per session               (default 20)
 *   --sessions        concurrent game sessions        (default 1)
 *   --questions       questions in the generated quiz (default 5)
 *   --time            seconds per question            (default 15)
 *   --answer-delay    max random pre-answer delay, ms (default 0.6 * time*1000)
 *   --metrics-interval  ms between /metrics polls     (default 2000)
 *   --keep            skip cleanup (leave quiz/sessions in the DB)
 */
import { io as ioClient } from 'socket.io-client';

// ─── CLI args ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { players: 20, sessions: 1, questions: 5, time: 15, metricsInterval: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'keep') {
      args.keep = true;
      continue;
    }
    const value = argv[++i];
    args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const BASE_URL = (args.url ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = args.email ?? process.env.ADMIN_USERNAME;
const PASSWORD = args.password ?? process.env.ADMIN_PASSWORD;
const PLAYERS = Number(args.players);
const SESSIONS = Number(args.sessions);
const QUESTIONS = Number(args.questions);
const TIME_SEC = Number(args.time);
const ANSWER_DELAY_MAX = Number(args.answerDelay ?? TIME_SEC * 600);
const METRICS_INTERVAL = Number(args.metricsInterval);
const KEEP = !!args.keep;

if (!EMAIL || !PASSWORD) {
  console.error('Missing --email/--password (or ADMIN_USERNAME/ADMIN_PASSWORD env).');
  process.exit(1);
}

// ─── Stats helpers ────────────────────────────────────────────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(idx, 0)];
}

function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n ? sorted.reduce((a, b) => a + b, 0) / n : NaN;
  console.log(
    `  ${label.padEnd(22)} n=${String(n).padEnd(6)} mean=${mean.toFixed(1).padStart(7)}ms  ` +
      `p50=${percentile(sorted, 50).toFixed(1).padStart(7)}ms  ` +
      `p95=${percentile(sorted, 95).toFixed(1).padStart(7)}ms  ` +
      `p99=${percentile(sorted, 99).toFixed(1).padStart(7)}ms  ` +
      `max=${(sorted[n - 1] ?? NaN).toFixed(1).padStart(7)}ms`,
  );
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────
async function api(path, opts = {}, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${opts.method ?? 'GET'} ${path} -> ${res.status} ${body}`);
  }
  return res.json();
}

// ─── Metrics poller ───────────────────────────────────────────────────────
function startMetricsPolling(token) {
  const samples = [];
  const timer = setInterval(async () => {
    try {
      const m = await api('/api/admin/metrics', {}, token);
      samples.push(m);
      const mb = (m.memory.rss / 1024 / 1024).toFixed(0);
      console.log(
        `  [metrics] sockets=${m.socketsConnected} sessions=${m.sessions.active} ` +
          `players=${m.sessions.totalPlayers} evtLoopLag(p99)=${m.eventLoopLagMs.p99.toFixed(1)}ms ` +
          `sqlitePing=${m.sqlitePingMs.toFixed(1)}ms rss=${mb}MB load1=${m.loadavg[0].toFixed(2)}`,
      );
    } catch (err) {
      console.warn(`  [metrics] poll failed: ${err.message}`);
    }
  }, METRICS_INTERVAL);
  return {
    samples,
    stop: () => clearInterval(timer),
  };
}

// ─── Quiz generation ──────────────────────────────────────────────────────
function buildQuiz(numQuestions, timeSec) {
  const questions = Array.from({ length: numQuestions }, (_, i) => ({
    text: `Load test question ${i + 1}`,
    options: ['A', 'B', 'C', 'D'],
    correctIndex: 0,
    baseScore: 500,
    timeSec,
    questionType: 'multiple_choice',
  }));
  return { title: `[load-test] ${new Date().toISOString()}`, description: '', questions };
}

// ─── One bot player ───────────────────────────────────────────────────────
function runBot(pin, username, joinLatencies, answerLatencies, errors) {
  return new Promise((resolve) => {
    const socket = ioClient(BASE_URL, { transports: ['websocket'], reconnection: false });
    let playerId = null;
    let joinedSessionId = null;
    let currentQuestionId = null;
    let joinSentAt = 0;
    let answerSentAt = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      socket.disconnect();
      resolve();
    };

    socket.on('connect', () => {
      joinSentAt = Date.now();
      socket.emit('player:join', { pin, username });
    });

    socket.on('connect_error', (err) => {
      errors.push(`connect: ${err.message}`);
      finish();
    });

    socket.on('player:error', (err) => {
      errors.push(`join: ${err.message}`);
      finish();
    });

    socket.on('player:joined', (data) => {
      playerId = data.playerId;
      joinedSessionId = data.sessionId;
      joinLatencies.push(Date.now() - joinSentAt);
    });

    socket.on('game:question', (q) => {
      currentQuestionId = q.questionId;
      const delay = Math.random() * ANSWER_DELAY_MAX;
      setTimeout(() => {
        if (done || currentQuestionId !== q.questionId) return;
        answerSentAt = Date.now();
        socket.emit('player:answer', {
          sessionId: joinedSessionId,
          questionId: q.questionId,
          chosenIndex: Math.floor(Math.random() * (q.options?.length ?? 4)),
          playerId,
        });
      }, delay);
    });

    socket.on('player:answer-received', () => {
      answerLatencies.push(Date.now() - answerSentAt);
    });

    socket.on('game:ended', finish);
    socket.on('disconnect', (reason) => {
      if (!done && reason !== 'io client disconnect') errors.push(`disconnect: ${reason}`);
      finish();
    });
  });
}

// ─── One full session (admin + its bots) ─────────────────────────────────
async function runSession(sessionIndex, quizId, token) {
  const { id: sessionId, pin } = await api(
    '/api/admin/sessions',
    { method: 'POST', body: JSON.stringify({ quizId }) },
    token,
  );

  const joinLatencies = [];
  const answerLatencies = [];
  const errors = [];

  const bots = Array.from({ length: PLAYERS }, (_, i) =>
    runBot(pin, `bot-s${sessionIndex}-${i}`, joinLatencies, answerLatencies, errors),
  );

  // Wait for bots to finish joining (or a generous timeout) before starting.
  const joinDeadline = Date.now() + 5000 + PLAYERS * 30;
  while (joinLatencies.length + errors.length < PLAYERS && Date.now() < joinDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const adminSocket = ioClient(BASE_URL, { transports: ['websocket'], reconnection: false });
  adminSocket.on('error', (err) => errors.push(`admin: ${err.message}`));
  await new Promise((resolve) => adminSocket.on('connect', resolve));
  adminSocket.emit('admin:join-session', { sessionId, token });
  // admin:join-session does async DB work before the in-memory session state
  // exists; admin:start-game needs that state, so wait for the ack.
  await new Promise((resolve) => adminSocket.once('session:state', resolve));

  // Results only auto-advance when resultsAutoAdvanceSec is configured (it
  // defaults to 0 = manual-only), so the "host" has to click next itself.
  // The server already fast-forwards to results once every currently-joined
  // bot has answered, so all we drive here is the results -> next-question step.
  adminSocket.on('game:question-results', () => {
    setTimeout(() => adminSocket.emit('admin:next-question', { sessionId, token }), 300);
  });

  adminSocket.emit('admin:start-game', { sessionId, token });

  await Promise.all(bots);
  adminSocket.disconnect();

  return { sessionId, pin, joinLatencies, answerLatencies, errors };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `Load test: ${SESSIONS} session(s) x ${PLAYERS} players, ${QUESTIONS} questions @ ${TIME_SEC}s vs ${BASE_URL}\n`,
  );

  const { token } = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  const { id: quizId } = await api(
    '/api/admin/quizzes',
    { method: 'POST', body: JSON.stringify(buildQuiz(QUESTIONS, TIME_SEC)) },
    token,
  );

  const metrics = startMetricsPolling(token);
  const startedAt = Date.now();

  const results = await Promise.all(
    Array.from({ length: SESSIONS }, (_, i) => runSession(i, quizId, token)),
  );

  metrics.stop();
  const wallSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\nDone in ${wallSec}s. Results:\n`);
  const allJoins = results.flatMap((r) => r.joinLatencies);
  const allAnswers = results.flatMap((r) => r.answerLatencies);
  const allErrors = results.flatMap((r) => r.errors);

  summarize('join latency', allJoins);
  summarize('answer round-trip', allAnswers);
  console.log(
    `  join success        ${allJoins.length}/${SESSIONS * PLAYERS}`,
  );
  console.log(`  errors               ${allErrors.length}`);
  if (allErrors.length) {
    const counts = new Map();
    for (const e of allErrors) counts.set(e, (counts.get(e) ?? 0) + 1);
    for (const [msg, count] of counts) console.log(`    x${count}  ${msg}`);
  }

  if (metrics.samples.length) {
    const peakLag = Math.max(...metrics.samples.map((m) => m.eventLoopLagMs.p99));
    const peakSqlite = Math.max(...metrics.samples.map((m) => m.sqlitePingMs));
    const peakRssMb = Math.max(...metrics.samples.map((m) => m.memory.rss)) / 1024 / 1024;
    console.log(
      `  peak evtLoopLag(p99) ${peakLag.toFixed(1)}ms   peak sqlitePing ${peakSqlite.toFixed(1)}ms   peak rss ${peakRssMb.toFixed(0)}MB`,
    );
  }

  if (!KEEP) {
    for (const r of results) {
      await api(`/api/admin/sessions/${r.sessionId}/force-end`, { method: 'POST' }, token).catch(
        () => {},
      );
    }
    await api(`/api/admin/quizzes/${quizId}`, { method: 'DELETE' }, token).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
