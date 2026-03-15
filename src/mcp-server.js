#!/usr/bin/env node
/**
 * mcp-server.js
 *
 * MCP Server — expose sprint workflow เป็น tools ให้ Claude Code เรียกได้โดยตรง
 *
 * Setup:
 *   เพิ่มใน ~/.claude/claude_desktop_config.json หรือ .claude/settings.json:
 *
 *   {
 *     "mcpServers": {
 *       "ai-company": {
 *         "command": "node",
 *         "args": ["/path/to/ai-company-cc/src/mcp-server.js"],
 *         "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
 *       }
 *     }
 *   }
 *
 * แล้วใน Claude Code พิมพ์ได้เลย:
 *   "Run a sprint for: Build JWT auth API"
 *   "Simulate an architecture for: Payment service"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'path';
import { runSprint } from './sprint.js';

// ─── MCP Server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'ai-company', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'run_sprint',
      description:
        'Run an Agile sprint with AI agents: Product Owner creates user stories, ' +
        'Tech Lead defines architecture, Developer (Claude Code) writes the code, ' +
        'QA generates tests. Returns sprint output and file paths.',
      inputSchema: {
        type: 'object',
        properties: {
          requirement: {
            type: 'string',
            description: 'What to build — the feature or system requirement',
          },
          mode: {
            type: 'string',
            enum: ['execute', 'simulate', 'both'],
            default: 'execute',
            description:
              'execute: writes real files | simulate: plan only | both: simulate then execute',
          },
          output_dir: {
            type: 'string',
            description: 'Directory to write output files (default: ./output)',
          },
        },
        required: ['requirement'],
      },
    },

    {
      name: 'get_sprint_log',
      description: 'Get the markdown log from the last sprint run.',
      inputSchema: {
        type: 'object',
        properties: {
          output_dir: {
            type: 'string',
            description: 'Directory where sprint-log.md was written',
          },
        },
      },
    },

    {
      name: 'simulate_architecture',
      description:
        'Run only the PO + TL agents to get user stories and architecture plan. ' +
        'Faster than a full sprint — useful for planning before writing code.',
      inputSchema: {
        type: 'object',
        properties: {
          requirement: {
            type: 'string',
            description: 'Feature or system to design',
          },
        },
        required: ['requirement'],
      },
    },
  ],
}));

// ─── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      case 'run_sprint': {
        const { requirement, mode = 'execute', output_dir } = args;
        const slug = requirement.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const outputDir = output_dir ? resolve(output_dir) : resolve(`output/${slug}`);
        const projectDir = `${outputDir}/project`;

        const logs = [];
        const sprint = await runSprint(requirement, {
          mode,
          projectDir,
          outputDir,
          onProgress: (event) => {
            if (event.type === 'log') {
              logs.push(`[${event.agent}] ${event.message}${event.decision ? ` → ${event.decision}` : ''}`);
            }
          },
        });

        const summary = buildSprintSummary(sprint, outputDir, projectDir, mode);
        return { content: [{ type: 'text', text: summary }] };
      }

      case 'get_sprint_log': {
        const { output_dir = './output' } = args;
        const logPath = resolve(output_dir, 'sprint-log.md');
        try {
          const { readFileSync } = await import('fs');
          const content = readFileSync(logPath, 'utf8');
          return { content: [{ type: 'text', text: content }] };
        } catch {
          return { content: [{ type: 'text', text: `No sprint log found at ${logPath}` }] };
        }
      }

      case 'simulate_architecture': {
        const { requirement } = args;
        const { callAgent } = await import('./agents.js');

        const poOutput = await callAgent('po', `Requirement: ${requirement}\nMode: simulate`);
        const tlOutput = await callAgent('tl',
          `Requirement: ${requirement}\n\nUser stories:\n${poOutput}`
        );

        const result = [
          '## Product Owner: User Stories',
          '',
          poOutput,
          '',
          '---',
          '',
          '## Tech Lead: Architecture',
          '',
          tlOutput,
        ].join('\n');

        return { content: [{ type: 'text', text: result }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildSprintSummary(sprint, outputDir, projectDir, mode) {
  const done = sprint.kanban?.done?.length || 0;
  const total = Object.values(sprint.kanban || {}).flat().length;
  const duration = sprint.completedAt
    ? Math.round((new Date(sprint.completedAt) - new Date(sprint.startedAt)) / 1000)
    : '?';

  const lines = [
    `✅ Sprint complete (${duration}s)`,
    ``,
    `Tasks: ${done}/${total} done | Mode: ${mode}`,
    ``,
    `## Outputs`,
    ``,
  ];

  if (mode !== 'simulate') {
    lines.push(`**Project files:** \`${projectDir}\``);
    lines.push(`**Tests:** \`${projectDir}/__tests__/sprint.test.js\``);
  }
  lines.push(`**Sprint log:** \`${outputDir}/sprint-log.md\``);
  lines.push(`**Sprint JSON:** \`${outputDir}/sprint-log.json\``);
  lines.push(``);

  lines.push(`## Tech Lead Architecture`);
  lines.push(``);
  lines.push(sprint.outputs?.tl || '');
  lines.push(``);

  if (sprint.log?.length > 0) {
    lines.push(`## Decision Log`);
    lines.push(``);
    sprint.log
      .filter(e => e.decision)
      .forEach(e => {
        lines.push(`- **${e.agent}**: ${e.message}`);
        lines.push(`  > ${e.decision}`);
      });
  }

  return lines.join('\n');
}

// ─── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// Server is running — MCP protocol over stdio
