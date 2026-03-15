/**
 * web-server.js
 *
 * Real-time web dashboard for AI Software Company
 * Run with: node src/web-server.js
 * Or with sprint: node src/cli.js --web "requirement"
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── State Management ────────────────────────────────────────────────────────

let sprintState = {
  status: 'idle', // idle, running, complete, error
  requirement: '',
  mode: 'execute',
  startedAt: null,
  completedAt: null,
  currentPhase: null,
  phases: {
    po: { status: 'pending', output: '', startTime: null, duration: 0 },
    tl: { status: 'pending', output: '', startTime: null, duration: 0 },
    dev: { status: 'pending', output: '', startTime: null, duration: 0 },
    qa: { status: 'pending', output: '', startTime: null, duration: 0 },
  },
  kanban: {
    backlog: [],
    inProgress: [],
    review: [],
    done: [],
  },
  logs: [],
  connectedClients: 0,
};

let wss = null;
let httpServer = null;

// ─── WebSocket Server ────────────────────────────────────────────────────────

export function startWebServer(port = 3456) {
  return new Promise((resolve) => {
    httpServer = createServer(handleHTTPRequest);

    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws) => {
      sprintState.connectedClients = wss.clients.size;
      broadcast({ type: 'client:count', count: sprintState.connectedClients });

      // Send current state to new client
      ws.send(JSON.stringify({ type: 'state:full', state: sprintState }));

      ws.on('close', () => {
        sprintState.connectedClients = wss.clients.size;
        broadcast({ type: 'client:count', count: sprintState.connectedClients });
      });
    });

    httpServer.listen(port, () => {
      console.log(`\n  Dashboard: http://localhost:${port}\n`);
      resolve({ port, broadcast, resetState });
    });
  });
}

// ─── HTTP Handler ─────────────────────────────────────────────────────────────

function handleHTTPRequest(req, res) {
  const url = req.url === '/' ? '/dashboard.html' : req.url;

  // API endpoint for current state
  if (url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sprintState));
    return;
  }

  // Serve static files
  const filePath = join(__dirname, 'web', url);
  if (existsSync(filePath)) {
    const ext = filePath.split('.').pop();
    const contentTypes = {
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      json: 'application/json',
    };
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

function broadcast(message) {
  const data = JSON.stringify(message);
  wss?.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(data);
    }
  });
}

// ─── State Management for Sprint ──────────────────────────────────────────────

export function resetState(requirement, mode) {
  sprintState = {
    status: 'idle',
    requirement: requirement || '',
    mode: mode || 'execute',
    startedAt: null,
    completedAt: null,
    currentPhase: null,
    phases: {
      po: { status: 'pending', output: '', startTime: null, duration: 0 },
      tl: { status: 'pending', output: '', startTime: null, duration: 0 },
      dev: { status: 'pending', output: '', startTime: null, duration: 0 },
      qa: { status: 'pending', output: '', startTime: null, duration: 0 },
    },
    kanban: {
      backlog: [],
      inProgress: [],
      review: [],
      done: [],
    },
    logs: [],
    connectedClients: sprintState.connectedClients,
  };
  broadcast({ type: 'state:full', state: sprintState });
}

// ─── Progress Handler for Sprint Integration ─────────────────────────────────

export function createWebProgressHandler() {
  return (event) => {
    switch (event.type) {
      case 'sprint:start':
        sprintState.status = 'running';
        sprintState.startedAt = new Date().toISOString();
        broadcast({ type: 'state:start', state: sprintState });
        break;

      case 'phase':
        const prevPhase = sprintState.currentPhase;
        if (prevPhase && sprintState.phases[prevPhase]) {
          sprintState.phases[prevPhase].duration =
            Date.now() - (sprintState.phases[prevPhase].startTime || Date.now());
        }

        sprintState.currentPhase = event.agent;
        if (sprintState.phases[event.agent]) {
          sprintState.phases[event.agent].status = 'running';
          sprintState.phases[event.agent].startTime = Date.now();
        }

        broadcast({
          type: 'phase:start',
          agent: event.agent,
          phase: event.phase,
          state: sprintState,
        });
        break;

      case 'output':
        if (sprintState.phases[event.agent]) {
          sprintState.phases[event.agent].status = 'complete';
          sprintState.phases[event.agent].output = event.content;
          sprintState.phases[event.agent].duration =
            Date.now() - (sprintState.phases[event.agent].startTime || Date.now());
        }

        broadcast({
          type: 'phase:output',
          agent: event.agent,
          content: event.content,
          state: sprintState,
        });
        break;

      case 'log':
        sprintState.logs.push({
          timestamp: event.timestamp || new Date().toISOString(),
          agent: event.agent,
          message: event.message,
          decision: event.decision,
        });

        broadcast({
          type: 'log',
          entry: {
            timestamp: event.timestamp,
            agent: event.agent,
            message: event.message,
            decision: event.decision,
          },
        });
        break;

      case 'kanban':
        // Update kanban state
        const { id, column, title, agent } = event;

        // Remove from all columns first
        Object.keys(sprintState.kanban).forEach((col) => {
          sprintState.kanban[col] = sprintState.kanban[col].filter((c) => c.id !== id);
        });

        // Add to new column
        if (column && sprintState.kanban[column]) {
          const existingCard = Object.values(sprintState.kanban)
            .flat()
            .find((c) => c.id === id);
          sprintState.kanban[column].push({
            id,
            title: title || existingCard?.title || '',
            agent: agent || existingCard?.agent || '',
          });
        }

        broadcast({
          type: 'kanban',
          id,
          column,
          title,
          kanban: sprintState.kanban,
        });
        break;

      case 'done':
        sprintState.status = 'complete';
        sprintState.completedAt = event.sprint?.completedAt || new Date().toISOString();

        // Mark any remaining phase durations
        Object.keys(sprintState.phases).forEach((phase) => {
          if (sprintState.phases[phase].status === 'running') {
            sprintState.phases[phase].status = 'complete';
            sprintState.phases[phase].duration =
              Date.now() - (sprintState.phases[phase].startTime || Date.now());
          }
        });

        broadcast({
          type: 'sprint:done',
          sprint: event.sprint,
          state: sprintState,
        });
        break;

      case 'error':
        sprintState.status = 'error';
        broadcast({ type: 'error', error: event.error, state: sprintState });
        break;
    }
  };
}

// ─── Standalone Mode ─────────────────────────────────────────────────────────

async function standalone() {
  const port = process.env.PORT || 3456;
  await startWebServer(port);

  console.log('  Press Ctrl+C to stop');
  console.log('  Waiting for sprint to start...\n');
}

// Run standalone if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  standalone().catch(console.error);
}
