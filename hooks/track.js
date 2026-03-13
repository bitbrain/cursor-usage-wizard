#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const USAGE_DIR = path.join(os.homedir(), '.cursor', 'usage-wizard');
const USAGE_FILE = path.join(USAGE_DIR, 'usage.jsonl');
const ACTIVE_CONVERSATION_FILE = path.join(USAGE_DIR, 'active-conversation.json');

const eventArg = process.argv.find((a) => a.startsWith('--'));
const eventName = eventArg ? eventArg.replace('--', '') : 'unknown';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const data = input ? JSON.parse(input) : {};
    const conversationId = data.conversation_id || data.session_id || 'unknown';
    const model = data.model || 'auto';
    const source = eventName === 'afterTabFileEdit' ? 'tab' : 'agent';

    const line = JSON.stringify({
      ts: Date.now(),
      event: eventName,
      conversation_id: conversationId,
      model,
      source,
    }) + '\n';

    if (!fs.existsSync(USAGE_DIR)) {
      fs.mkdirSync(USAGE_DIR, { recursive: true });
    }
    fs.appendFileSync(USAGE_FILE, line);
    if (conversationId !== 'unknown') {
      fs.writeFileSync(
        ACTIVE_CONVERSATION_FILE,
        JSON.stringify({ conversationId, ts: Date.now() }),
        'utf8'
      );
    }
  } catch (err) {
    // Silently ignore parse errors
  }
  process.exit(0);
});
