/**
 * agents.js
 *
 * PO, TL, QA  → Anthropic SDK (claude-sonnet)
 * DEV         → Claude Code subprocess (claude code --print)
 *               เขียน code จริง, สร้าง files จริง ใน project directory
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// ─── Anthropic client ──────────────────────────────────────────────────────────

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Agent definitions ─────────────────────────────────────────────────────────

export const AGENTS = {
  po: {
    name: 'Product Owner',
    abbr: 'PO',
    color: 'magenta',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 900,
    systemPrompt: `You are a Product Owner in an Agile software team.
Analyze requirements and produce:
1. A brief summary (2-3 sentences)
2. Exactly 3-4 user stories: "As a [user], I want [feature] so that [benefit]"
3. Acceptance criteria for each story (2-3 bullets)
4. Key risks or unknowns (1-2 items)
Be concise and actionable. Output plain text, no markdown headers.`,
  },

  tl: {
    name: 'Tech Lead',
    abbr: 'TL',
    color: 'green',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 1000,
    systemPrompt: `You are a Tech Lead / Dev Lead in an Agile team.
Given a requirement and user stories, produce:
1. Recommended tech stack with one-line justification per item
2. High-level architecture (3-5 components, how they connect)
3. Exactly 3 developer tasks — each with:
   - Task name
   - Files/modules to create (e.g. src/auth/authService.ts)
   - Key functions or classes needed
4. One Architecture Decision Record (ADR):
   Decision: [what]
   Because: [why]
   Trade-off: [what we give up]
Output plain text. Be specific about file paths and function names.`,
  },

  qa: {
    name: 'QA Engineer',
    abbr: 'QA',
    color: 'yellow',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 900,
    systemPrompt: `You are a QA Engineer. Given a feature and its implementation,
write a Jest test file covering:
1. Happy path (main success scenario)
2. Edge cases (empty input, boundary values)
3. Error cases (invalid data, missing auth)
4. At least one security test (injection, auth bypass)

Output ONLY the test code — a complete Jest test file, no explanation before or after.
Use describe/it blocks. Mock external dependencies with jest.mock().
File should be self-contained and runnable.`,
  },
};

// ─── Non-DEV agents: call Anthropic API directly ──────────────────────────────

export async function callAgent(agentKey, userMessage) {
  const agent = AGENTS[agentKey];
  const response = await client.messages.create({
    model: agent.model,
    max_tokens: agent.maxTokens,
    system: agent.systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content[0].text;
}

// ─── DEV agent: run Claude Code as subprocess ─────────────────────────────────

/**
 * Claude Code เป็น Developer agent จริงๆ
 * สร้าง project directory, เขียน files, และรัน claude code --print
 *
 * @param {string} requirement   - original user requirement
 * @param {string} tlOutput      - tech lead's architecture plan
 * @param {string} projectDir    - target project directory
 * @param {object} opts          - { mode, sprintLog }
 */
export async function runDevAgent(requirement, tlOutput, projectDir, opts = {}) {
  const { mode = 'execute', sprintLog } = opts;

  // Ensure project directory exists
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  // Write context files that Claude Code will read
  const contextFile = join(projectDir, 'SPRINT_CONTEXT.md');
  writeFileSync(contextFile, buildDevContext(requirement, tlOutput, mode));

  if (mode === 'simulate') {
    // Simulate mode: just ask for an implementation plan without writing files
    return await callSimulateDev(requirement, tlOutput);
  }

  // Execute mode: run Claude Code subprocess
  return await runClaudeCode(projectDir, requirement, tlOutput, sprintLog);
}

// ─── Simulate DEV (no file writes) ─────────────────────────────────────────────

async function callSimulateDev(requirement, tlOutput) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: `You are a Senior Developer. Given an architecture plan, describe your implementation approach:
- Which files you would create and why
- Key design patterns and data structures  
- Potential pitfalls and how you'd handle them
Be specific (file names, function signatures). Do NOT write full code — describe the plan clearly.`,
    messages: [{
      role: 'user',
      content: `Requirement: ${requirement}\n\nArchitecture from Tech Lead:\n${tlOutput}\n\nDescribe your implementation plan.`,
    }],
  });
  return response.content[0].text;
}

// ─── Execute DEV via Claude Code ───────────────────────────────────────────────

async function runClaudeCode(projectDir, requirement, tlOutput, sprintLog) {
  // Build the prompt for Claude Code
  const devPrompt = buildClaudeCodePrompt(requirement, tlOutput);

  // Write prompt to file (Claude Code reads it via --print)
  const promptFile = join(projectDir, '.cc-prompt.txt');
  writeFileSync(promptFile, devPrompt);

  // Check if claude CLI is available
  const claudeAvailable = isClaudeCodeAvailable();
  if (!claudeAvailable) {
    return fallbackDevOutput(requirement, tlOutput, projectDir);
  }

  sprintLog?.('DEV', 'Claude Code subprocess starting...', null);

  try {
    // Run: claude --print < prompt.txt
    // --print = non-interactive mode, outputs result to stdout
    const result = spawnSync(
      'claude',
      ['--print', '--dangerously-skip-permissions'],
      {
        input: devPrompt,
        encoding: 'utf8',
        cwd: projectDir,
        timeout: 120_000,           // 2 min max
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
      }
    );

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`);

    const output = result.stdout?.trim() || '(no output)';

    // Log what files were created
    const createdFiles = listCreatedFiles(projectDir);
    if (createdFiles.length > 0) {
      sprintLog?.('DEV', `Created ${createdFiles.length} files`, createdFiles.join(', '));
    }

    return output;
  } catch (err) {
    // Claude Code not available or failed — fall back to API
    sprintLog?.('DEV', `Claude Code unavailable (${err.message}) — falling back to API`);
    return fallbackDevOutput(requirement, tlOutput, projectDir);
  }
}

// ─── Fallback: DEV via Anthropic API (writes files itself) ─────────────────────

async function fallbackDevOutput(requirement, tlOutput, projectDir) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: `You are a Senior Developer. Write production-ready implementation code.
Respond in this exact format for EACH file:

===FILE: path/to/file.ts===
[file contents here]
===END===

Create all necessary files. Keep each file focused and clean.`,
    messages: [{
      role: 'user',
      content: `Requirement: ${requirement}\n\nArchitecture:\n${tlOutput}\n\nImplement the core files.`,
    }],
  });

  const output = response.content[0].text;

  // Parse and write files from the response
  writeGeneratedFiles(output, projectDir);

  return output;
}

// ─── Prompt builders ───────────────────────────────────────────────────────────

function buildClaudeCodePrompt(requirement, tlOutput) {
  return `You are the Developer agent in an AI Agile team sprint.

## Your task
Implement the following requirement based on the architecture plan below.
You have full access to the filesystem — create all necessary files.

## Requirement
${requirement}

## Architecture plan from Tech Lead
${tlOutput}

## Instructions
1. Create all files specified in the architecture plan
2. Write clean, production-ready code with error handling
3. Add a brief comment at the top of each file explaining its purpose
4. Create a README.md in the project root summarizing what was built
5. If tests are needed, create a __tests__ directory with basic test stubs

Start implementing now. Create the files directly.`;
}

function buildDevContext(requirement, tlOutput, mode) {
  return `# Sprint Context
Generated: ${new Date().toISOString()}
Mode: ${mode}

## Requirement
${requirement}

## Architecture (from Tech Lead)
${tlOutput}

## Instructions for Developer
${mode === 'execute'
  ? '- Implement all files specified above\n- Write production-ready code\n- Add error handling\n- Create README.md'
  : '- This is a simulation — describe implementation plan only'
}
`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isClaudeCodeAvailable() {
  try {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function listCreatedFiles(dir) {
  try {
    const result = execSync(`find ${dir} -type f -not -name '.*' -not -name 'SPRINT_CONTEXT.md'`, {
      encoding: 'utf8',
    });
    return result.trim().split('\n').filter(Boolean).map(f => f.replace(dir + '/', ''));
  } catch {
    return [];
  }
}

function writeGeneratedFiles(output, projectDir) {
  const fileRegex = /===FILE: (.+?)===\n([\s\S]*?)===END===/g;
  let match;
  while ((match = fileRegex.exec(output)) !== null) {
    const [, filePath, content] = match;
    const fullPath = join(projectDir, filePath.trim());
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content.trim());
  }
}
