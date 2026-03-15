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
    model: 'claude-sonnet-4-6',
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
    model: 'claude-sonnet-4-6',
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
    model: 'claude-sonnet-4-6',
    maxTokens: 1400,
    systemPrompt: `You are a QA Engineer. Review the implementation and produce a structured report.

Review the code for:
1. Correctness — does it match the stated requirements?
2. Error handling — null/undefined checks, edge cases, input validation
3. Security — injection, auth bypass, data exposure, unsafe operations
4. Code quality — obvious bugs, missing logic, incomplete implementation

You MUST respond in EXACTLY this format (all three sections required):

VERDICT: PASS
(or write VERDICT: FAIL if any issues were found)

ISSUES:
- describe each specific issue with file/function reference if possible
(omit the ISSUES section entirely when VERDICT is PASS)

TESTS:
\`\`\`javascript
// complete Jest test file here
\`\`\`

The TESTS section must always be present and contain a complete, runnable Jest file.
Use describe/it blocks. Mock external deps with jest.mock(). Cover: happy path, edge cases, errors, security.`,
  },
};

// ─── Non-DEV agents: call Anthropic API directly ──────────────────────────────

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export async function callAgent(agentKey, userMessage) {
  const agent = AGENTS[agentKey];
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: agent.model,
        max_tokens: agent.maxTokens,
        system: agent.systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
      return response.content[0].text;
    } catch (err) {
      lastError = err;
      const status = err.status ?? err.statusCode;
      const isRetryable = RETRYABLE_STATUS.has(status) || err.message?.includes('timeout');

      if (!isRetryable || attempt === MAX_RETRIES) break;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.error(`[${agent.abbr}] API error (${status ?? err.message}) — retry ${attempt}/${MAX_RETRIES - 1} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error(`[${agent.abbr}] Failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// ─── DEV agent: run Claude Code as subprocess ─────────────────────────────────

/**
 * runDevAgentForTask — Developer agent สำหรับ 1 task (ใช้ใน parallel mode)
 *
 * @param {object} task         - { title, files } task จาก TL
 * @param {string} requirement  - original user requirement
 * @param {string} tlOutput     - tech lead's full architecture plan
 * @param {string} taskDir      - directory สำหรับ task นี้โดยเฉพาะ
 * @param {object} opts         - { mode, sprintLog, agentKey }
 */
export async function runDevAgentForTask(task, requirement, tlOutput, taskDir, opts = {}) {
  const { mode = 'execute', sprintLog } = opts;

  if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });

  writeFileSync(
    join(taskDir, 'TASK_CONTEXT.md'),
    buildTaskContext(task, requirement, tlOutput, mode)
  );

  if (mode === 'simulate') return await callSimulateDevTask(task, requirement, tlOutput);

  return await runClaudeCodeForTask(task, requirement, tlOutput, taskDir, sprintLog);
}

async function callSimulateDevTask(task, requirement, tlOutput) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: `You are a Senior Developer. Describe your implementation plan for ONE specific task.
Be specific about file names and function signatures. Do NOT write full code.`,
    messages: [{
      role: 'user',
      content: `Requirement: ${requirement}\n\nYour task: ${task.title}\n${task.files ? `Files: ${task.files}` : ''}\n\nArchitecture:\n${tlOutput}\n\nDescribe your plan for this task only.`,
    }],
  });
  return response.content[0].text;
}

async function runClaudeCodeForTask(task, requirement, tlOutput, taskDir, sprintLog) {
  const devPrompt = buildClaudeCodeTaskPrompt(task, requirement, tlOutput);
  writeFileSync(join(taskDir, '.cc-prompt.txt'), devPrompt);

  if (!isClaudeCodeAvailable()) return fallbackDevTaskOutput(task, requirement, tlOutput, taskDir);

  try {
    const result = spawnSync('claude', ['--print', '--dangerously-skip-permissions'], {
      input: devPrompt,
      encoding: 'utf8',
      cwd: taskDir,
      timeout: 120_000,
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`);

    const output = result.stdout?.trim() || '(no output)';
    const files = listCreatedFiles(taskDir);
    if (files.length > 0) sprintLog?.(`Created ${files.length} files: ${files.join(', ')}`);
    return output;
  } catch (err) {
    sprintLog?.(`Claude Code unavailable (${err.message}) — using API fallback`);
    return fallbackDevTaskOutput(task, requirement, tlOutput, taskDir);
  }
}

async function fallbackDevTaskOutput(task, requirement, tlOutput, taskDir) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `You are a Senior Developer. Implement ONE specific task.
Respond in this format for EACH file:

===FILE: path/to/file.ts===
[file contents]
===END===

Focus only on your assigned task. Write clean, production-ready code.`,
    messages: [{
      role: 'user',
      content: `Requirement: ${requirement}\n\nYour task: ${task.title}\n${task.files ? `Files: ${task.files}` : ''}\n\nArchitecture:\n${tlOutput}\n\nImplement your task only.`,
    }],
  });
  const output = response.content[0].text;
  writeGeneratedFiles(output, taskDir);
  return output;
}

function buildClaudeCodeTaskPrompt(task, requirement, tlOutput) {
  return `You are a Developer agent in an AI Agile team. You are responsible for ONE specific task.

## Your assigned task
${task.title}
${task.files ? `\nFiles to create:\n${task.files}` : ''}

## Overall requirement (context only)
${requirement}

## Architecture from Tech Lead
${tlOutput}

## Instructions
1. Implement ONLY your assigned task above
2. Create the files listed (or determine appropriate files if not specified)
3. Write clean, production-ready code with error handling
4. Add a brief comment at the top of each file explaining its purpose
5. Do NOT implement tasks assigned to other developers

Start implementing now.`;
}

function buildTaskContext(task, requirement, tlOutput, mode) {
  return `# Task Context
Generated: ${new Date().toISOString()}
Mode: ${mode}

## Your Task
${task.title}
${task.files ? `Files: ${task.files}` : ''}

## Requirement
${requirement}

## Architecture
${tlOutput}
`;
}

// ─── QA Verdict Parser ─────────────────────────────────────────────────────────

/**
 * Parse structured QA output into verdict + issues + test code.
 *
 * @param {string} qaOutput - raw text from QA agent
 * @returns {{ passed: boolean, issues: string[], tests: string }}
 */
export function parseQaVerdict(qaOutput) {
  // Extract VERDICT line
  const verdictMatch = qaOutput.match(/VERDICT:\s*(PASS|FAIL)/i);
  // Default to PASS if QA agent didn't follow the format (fail-safe)
  const passed = verdictMatch ? verdictMatch[1].toUpperCase() === 'PASS' : true;

  // Extract ISSUES section (between ISSUES: and TESTS:)
  const issues = [];
  const issuesBlock = qaOutput.match(/ISSUES:\n([\s\S]*?)(?=\nTESTS:|$)/i);
  if (issuesBlock) {
    issuesBlock[1].split('\n').forEach(line => {
      const trimmed = line.replace(/^\s*[-*•\d.)]\s*/, '').trim();
      if (trimmed.length > 3) issues.push(trimmed);
    });
  }

  // Extract TESTS section — strip fenced code block markers if present
  const testsBlock = qaOutput.match(/TESTS:\n(?:```(?:javascript|js|typescript|ts)?\n)?([\s\S]*?)(?:```\s*)?$/i);
  const tests = testsBlock
    ? testsBlock[1].replace(/```\s*$/, '').trim()
    : qaOutput; // fallback: treat entire output as tests

  return { passed, issues, tests };
}

// ─── DEV Fix Agent ─────────────────────────────────────────────────────────────

/**
 * runDevFixForTask — re-run the developer agent to fix specific QA issues.
 *
 * @param {object} task           - { title, files } the original task
 * @param {string} currentOutput  - dev's previous implementation output
 * @param {string[]} qaIssues     - list of issues found by QA
 * @param {string} taskDir        - task's working directory
 * @param {object} opts           - { mode, sprintLog, agentKey }
 */
export async function runDevFixForTask(task, currentOutput, qaIssues, taskDir, opts = {}) {
  const { mode = 'execute', sprintLog } = opts;

  if (mode === 'simulate') {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 900,
      system: `You are a Senior Developer fixing code issues raised by QA review.
Describe concisely how you would address each issue — be specific about file names and functions.
Do NOT write full code in simulate mode.`,
      messages: [{
        role: 'user',
        content: buildDevFixUserMessage(task, currentOutput, qaIssues),
      }],
    });
    return response.content[0].text;
  }

  // Write updated context with QA feedback
  writeFileSync(
    join(taskDir, 'QA_FEEDBACK.md'),
    buildQaFeedbackContext(task, qaIssues)
  );

  if (!isClaudeCodeAvailable()) {
    return await fallbackDevFixOutput(task, currentOutput, qaIssues, taskDir);
  }

  const fixPrompt = buildDevFixPrompt(task, currentOutput, qaIssues);
  writeFileSync(join(taskDir, '.cc-fix-prompt.txt'), fixPrompt);

  try {
    const result = spawnSync('claude', ['--print', '--dangerously-skip-permissions'], {
      input: fixPrompt,
      encoding: 'utf8',
      cwd: taskDir,
      timeout: 120_000,
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`);

    const output = result.stdout?.trim() || '(no output)';
    const files = listCreatedFiles(taskDir);
    if (files.length > 0) sprintLog?.(`Fixed ${files.length} file(s): ${files.join(', ')}`);
    return output;
  } catch (err) {
    sprintLog?.(`Claude Code fix failed (${err.message}) — using API fallback`);
    return await fallbackDevFixOutput(task, currentOutput, qaIssues, taskDir);
  }
}

function buildDevFixPrompt(task, currentOutput, qaIssues) {
  return `You are a Developer agent. QA has reviewed your work and found issues that must be fixed.

## Your Task
${task.title}

## QA Issues to Fix
${qaIssues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

## Your Previous Implementation
${currentOutput}

## Instructions
1. Fix EACH issue listed above — address them all
2. Modify the relevant files directly
3. Do NOT change code that is already correct and working
4. After making changes, briefly summarize what you fixed

Fix the issues now.`;
}

function buildDevFixUserMessage(task, currentOutput, qaIssues) {
  return `Task: ${task.title}

QA found these issues in your implementation:
${qaIssues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

Your current implementation:
${currentOutput.slice(0, 800)}${currentOutput.length > 800 ? '\n...(truncated)' : ''}

Describe how you would fix each issue.`;
}

function buildQaFeedbackContext(task, qaIssues) {
  return `# QA Feedback
Generated: ${new Date().toISOString()}

## Task
${task.title}

## Issues to Fix
${qaIssues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

## Instructions
Address all issues above. Modify existing files as needed.
`;
}

async function fallbackDevFixOutput(task, currentOutput, qaIssues, taskDir) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `You are a Senior Developer fixing QA issues.
Return corrected files using this format for EACH file changed:

===FILE: path/to/file.ts===
[complete corrected file contents]
===END===

Include ONLY files that need changes. Write clean, production-ready code.`,
    messages: [{
      role: 'user',
      content: buildDevFixUserMessage(task, currentOutput, qaIssues),
    }],
  });
  const output = response.content[0].text;
  writeGeneratedFiles(output, taskDir);
  return output;
}

/**
 * runDevAgent — legacy single-dev entry point (ยังคงไว้เพื่อ backward compat)
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
    model: 'claude-sonnet-4-6',
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
    model: 'claude-sonnet-4-6',
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
