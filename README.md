# AI Software Company — Claude Code Edition

Agile sprint ที่ใช้ **Claude Code เป็น Developer agent จริงๆ**
PO + TL + QA ใช้ Anthropic SDK, DEV ใช้ `claude --print` subprocess เพื่อเขียน code และ files จริง

```
Requirement
    │
    ▼
PO  (claude-sonnet) → User stories
    │
    ▼
TL  (claude-sonnet) → Architecture + task breakdown
    │
    ▼
DEV (claude code)   → เขียน files จริงใน output/project/
    │
    ▼
QA  (claude-sonnet) → Test suite → output/project/__tests__/
```

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# 3. ตรวจสอบว่า Claude Code ติดตั้งแล้ว
claude --version
```

---

## วิธีใช้งาน

### A. รัน CLI ตรงๆ (แนะนำ)

```bash
# Interactive — จะถามทีละขั้น
node src/cli.js

# ส่ง requirement ตรงๆ
node src/cli.js "Build a REST API for task management with JWT auth"

# เลือก mode
node src/cli.js --mode simulate "Design a payment service"
node src/cli.js --mode execute  "Build user authentication"
node src/cli.js --mode both     "Create notification service"

# พร้อม PRD file
node src/cli.js --prd requirements.md "Build the feature described in PRD"
```

### B. ใช้เป็น MCP Server ใน Claude Code

เพิ่มใน `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-company": {
      "command": "node",
      "args": ["/absolute/path/to/ai-company-cc/src/mcp-server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

restart Claude Code แล้วพิมพ์ใน Claude Code:

```
Run a sprint for: Build a REST API for task management with JWT auth
```

```
Simulate architecture for: Design a microservices payment system
```

```
Get sprint log from: ./output
```

### C. รันใน Claude Code terminal โดยตรง

เปิด Claude Code ใน project นี้แล้วพิมพ์:

```
Can you run node src/cli.js "Build a JWT authentication service"?
```

Claude Code จะรัน CLI → PO+TL วางแผน → Claude Code เองเป็น DEV เขียน code → QA generate tests

---

## Output Structure

```
output/
└── build-a-jwt-auth-service/
    ├── project/                    ← Claude Code เขียน files ที่นี่
    │   ├── src/
    │   │   ├── auth/
    │   │   │   ├── authService.js
    │   │   │   ├── jwtHelper.js
    │   │   │   └── authController.js
    │   │   └── middleware/
    │   │       └── authMiddleware.js
    │   ├── __tests__/
    │   │   └── sprint.test.js      ← QA generated tests
    │   ├── SPRINT_CONTEXT.md       ← Context ที่ส่งให้ Claude Code
    │   └── README.md               ← Claude Code สร้างให้
    ├── sprint-log.md               ← Full sprint log (Markdown)
    └── sprint-log.json             ← Machine-readable log
```

---

## Mode ต่างๆ

| Mode | PO | TL | DEV | QA | Files written? |
|------|----|----|-----|----|----------------|
| `simulate` | API | API | API (plan only) | API | ไม่มี |
| `execute` | API | API | **Claude Code** | API | ✓ ใน `project/` |
| `both` | API | API | API → **Claude Code** | API | ✓ phase 2 |

---

## ปรับแต่ง Agents

แก้ `src/agents.js`:

```js
// เปลี่ยน model
po: {
  model: 'claude-haiku-4-5-20251001',   // ประหยัด cost สำหรับ PO
  ...
}

// แก้ system prompt
tl: {
  systemPrompt: `You are a Tech Lead specializing in .NET Clean Architecture...`,
  ...
}
```

### เพิ่ม DevOps agent

```js
// ใน sprint.js หลัง QA phase
const devopsOutput = await callAgent('devops',
  `Feature: ${requirement}\nImplementation: ${devOutput}\nCreate Dockerfile and CI config.`
);
```

---

## Troubleshooting

### `claude: command not found`
Claude Code ยังไม่ได้ติดตั้ง หรือไม่อยู่ใน PATH
→ แอปจะ fallback ไปใช้ Anthropic API แทนอัตโนมัติ

### `ANTHROPIC_API_KEY not set`
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Claude Code timeout (> 2 นาที)
แก้ใน `agents.js`:
```js
timeout: 180_000,   // เพิ่มเป็น 3 นาที
```

### MCP Server ไม่ขึ้นใน Claude Code
ตรวจสอบ path ใน config เป็น absolute path และ restart Claude Code

---

## Integrate กับ Obsidian Vault

Sprint log ที่ได้เป็น Markdown — copy ไปใส่ vault ได้เลย:

```bash
# หลัง sprint เสร็จ
cp output/*/sprint-log.md ~/vault/sprints/$(date +%Y-%m-%d)-sprint.md
```

หรือเพิ่มใน `sprint.js` ให้ auto-copy:
```js
// หลัง saveSprint()
if (process.env.OBSIDIAN_VAULT) {
  const dest = join(process.env.OBSIDIAN_VAULT, 'sprints', `${Date.now()}-sprint.md`);
  copyFileSync(join(outputDir, 'sprint-log.md'), dest);
}
```
