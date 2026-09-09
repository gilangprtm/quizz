import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { db } from './db';
import { activeSessions } from './socket/gameState';
import { getSocketIo } from './socket/sessionLifecycle';

// Runs for the life of the process; `.reset()` after each read so every
// snapshot reports lag since the previous snapshot, not since boot.
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();

export interface MetricsSnapshot {
  uptimeSec: number;
  loadavg: number[];
  memory: NodeJS.MemoryUsage;
  eventLoopLagMs: { mean: number; p50: number; p99: number; max: number };
  sqlitePingMs: number;
  socketsConnected: number;
  sessions: { active: number; totalPlayers: number };
}

export async function getMetricsSnapshot(): Promise<MetricsSnapshot> {
  const pingStart = performance.now();
  await db.get('SELECT 1');
  const sqlitePingMs = performance.now() - pingStart;

  const io = getSocketIo();

  let totalPlayers = 0;
  for (const state of activeSessions.values()) totalPlayers += state.playerSockets.size;

  const toMs = (ns: number) => ns / 1e6;
  const snapshot: MetricsSnapshot = {
    uptimeSec: process.uptime(),
    loadavg: os.loadavg(),
    memory: process.memoryUsage(),
    eventLoopLagMs: {
      mean: toMs(eventLoopHistogram.mean),
      p50: toMs(eventLoopHistogram.percentile(50)),
      p99: toMs(eventLoopHistogram.percentile(99)),
      max: toMs(eventLoopHistogram.max),
    },
    sqlitePingMs,
    socketsConnected: io?.engine.clientsCount ?? 0,
    sessions: { active: activeSessions.size, totalPlayers },
  };

  eventLoopHistogram.reset();
  return snapshot;
}
