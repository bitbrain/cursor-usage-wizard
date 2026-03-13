#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const USAGE_DIR = path.join(os.homedir(), '.cursor', 'usage-wizard');
const USAGE_FILE = path.join(USAGE_DIR, 'usage.jsonl');
const LIMITS_FILE = path.join(USAGE_DIR, 'limits.json');
const ACTIVE_CONVERSATION_FILE = path.join(USAGE_DIR, 'active-conversation.json');

const MODEL_COSTS = {
  'claude-opus': 0.025,
  'claude-sonnet': 0.012,
  'claude-4': 0.012,
  'claude-3': 0.012,
  'gpt-4': 0.02,
  'gpt-4o': 0.02,
  gemini: 0.005,
  auto: 0.003,
  default: 0.005,
};

function estimateCost(model) {
  const lower = (model || '').toLowerCase();
  for (const [key, cost] of Object.entries(MODEL_COSTS)) {
    if (key !== 'default' && lower.includes(key)) return cost;
  }
  return MODEL_COSTS.default;
}

function getConversationUsage(conversationId) {
  if (!fs.existsSync(USAGE_FILE)) return { events: 0, cost: 0 };
  const content = fs.readFileSync(USAGE_FILE, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  let events = 0;
  let cost = 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.conversation_id === conversationId) {
        events++;
        cost += estimateCost(row.model);
      }
    } catch (_) {}
  }
  return { events, cost };
}

function getLimits() {
  if (!fs.existsSync(LIMITS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const data = input ? JSON.parse(input) : {};
    const conversationId = data.conversation_id;
    if (!conversationId) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
      return;
    }

    if (!fs.existsSync(USAGE_DIR)) {
      fs.mkdirSync(USAGE_DIR, { recursive: true });
    }
    fs.writeFileSync(
      ACTIVE_CONVERSATION_FILE,
      JSON.stringify({ conversationId, ts: Date.now() }),
      'utf8'
    );

    const limits = getLimits();
    const limit = limits[conversationId];
    if (!limit) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
      return;
    }

    const { events, cost } = getConversationUsage(conversationId);

    if (limit.maxCost != null && cost >= limit.maxCost) {
      process.stdout.write(
        JSON.stringify({
          continue: false,
          user_message: `Conversation limit reached ($${cost.toFixed(2)} >= $${limit.maxCost}).`,
        }) + '\n'
      );
      process.exit(0);
      return;
    }

    if (limit.maxEvents != null && events >= limit.maxEvents) {
      process.stdout.write(
        JSON.stringify({
          continue: false,
          user_message: `Conversation limit reached (${events} events >= ${limit.maxEvents}).`,
        }) + '\n'
      );
      process.exit(0);
      return;
    }

    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  } catch (_) {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  }
  process.exit(0);
});
