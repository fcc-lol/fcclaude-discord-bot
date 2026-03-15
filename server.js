require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');

// ---------------------------------------------------------------------------
// Validate env
// ---------------------------------------------------------------------------
const { DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, ANTHROPIC_API_KEY } = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID || !ANTHROPIC_API_KEY) {
  console.error('Missing required env vars: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, ANTHROPIC_API_KEY');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Member cache  (username → { id, displayName })
// Populated at startup and updated on every incoming message
// ---------------------------------------------------------------------------
const memberCache = new Map();

function cacheMember(username, id, displayName) {
  memberCache.set(username.toLowerCase(), { id, displayName: displayName || username });
}

function memberMentionList() {
  if (!memberCache.size) return '';
  const entries = Array.from(memberCache.entries())
    .map(([name, { id, displayName }]) => `${displayName} (${name}): <@${id}>`);
  return `known discord members and their mention format — ${entries.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Conversation history  (keyed by channel/thread ID)
// ---------------------------------------------------------------------------
const MAX_HISTORY = 30; // messages kept per channel
const conversations = new Map();

function getHistory(channelId) {
  if (!conversations.has(channelId)) {
    conversations.set(channelId, []);
  }
  return conversations.get(channelId);
}

function clearHistory(channelId) {
  conversations.delete(channelId);
}

function addMessage(channelId, role, content) {
  const history = getHistory(channelId);
  history.push({ role, content });
  // Keep the history bounded (always drop in role pairs to stay valid)
  while (history.length > MAX_HISTORY) {
    history.shift();
  }
}

// ---------------------------------------------------------------------------
// Register slash commands
// ---------------------------------------------------------------------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('claude-clear')
      .setDescription('Clear Claude\'s conversation history for this channel'),
    new SlashCommandBuilder()
      .setName('claude-help')
      .setDescription('Show how to use the Claude bot'),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    console.log('Slash commands registered globally.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
}

// ---------------------------------------------------------------------------
// Split long messages for Discord's 2000-char limit
// ---------------------------------------------------------------------------
function splitMessage(text, maxLen = 1990) {
  const chunks = [];
  while (text.length > maxLen) {
    // Prefer splitting at a newline, then a space
    let split = text.lastIndexOf('\n', maxLen);
    if (split < maxLen * 0.6) split = text.lastIndexOf(' ', maxLen);
    if (split < 1) split = maxLen;
    chunks.push(text.slice(0, split));
    text = text.slice(split).trimStart();
  }
  if (text.length > 0) chunks.push(text);
  return chunks;
}

// ---------------------------------------------------------------------------
// Long-term memory (persisted to disk)
// ---------------------------------------------------------------------------
const MEMORY_FILE = path.join(__dirname, 'memory.json');

function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch { return []; }
}

function saveMemory(memories) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));
}

// ---------------------------------------------------------------------------
// Reminders (persisted to disk)
// ---------------------------------------------------------------------------
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');

function loadReminders() {
  try { return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveReminders(reminders) {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

function startReminderChecker() {
  setInterval(async () => {
    const reminders = loadReminders();
    const now = new Date();
    const due = reminders.filter(r => new Date(r.remind_at) <= now);
    if (!due.length) return;

    saveReminders(reminders.filter(r => new Date(r.remind_at) > now));

    for (const reminder of due) {
      try {
        const channel = await discord.channels.fetch(reminder.channel_id);
        await channel.send(`hey ${reminder.created_by} — reminder: ${reminder.message}`);
      } catch (err) {
        console.error('failed to send reminder:', err);
      }
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Portfolio API
// ---------------------------------------------------------------------------
async function fetchAllProjects() {
  const res = await fetch('https://portfolio-api.fcc.lol/projects');
  if (!res.ok) throw new Error(`portfolio api error: ${res.status}`);
  return res.json();
}

async function fetchProject(id) {
  const res = await fetch(`https://portfolio-api.fcc.lol/projects/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`project not found: ${id}`);
  return res.json();
}

async function fetchProjectsByPerson(person) {
  const res = await fetch(`https://portfolio-api.fcc.lol/projects/person/${encodeURIComponent(person)}`);
  if (!res.ok) throw new Error(`no projects found for person: ${person}`);
  return res.json();
}

async function fetchProjectsByTag(tag) {
  const res = await fetch(`https://portfolio-api.fcc.lol/projects/tag/${encodeURIComponent(tag)}`);
  if (!res.ok) throw new Error(`no projects found for tag: ${tag}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Claude tools
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'search_projects',
    description: 'Search FCC Studio projects by name, description, tag, or member name.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term — e.g. a project name, tag like "hardware", or member name like "Leo"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_project',
    description: 'Get full details about a specific FCC Studio project by its ID/slug.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project ID/slug, e.g. "story-box"' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_projects_by_person',
    description: 'Get all FCC Studio projects by a specific person/member.',
    input_schema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'Person\'s first name, e.g. "leo", "zach", "dan"' },
      },
      required: ['person'],
    },
  },
  {
    name: 'get_projects_by_tag',
    description: 'Get all FCC Studio projects with a specific tag.',
    input_schema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Tag to filter by, e.g. "hardware", "raspberry-pi", "3d-printing"' },
      },
      required: ['tag'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Schedule a message to be sent to this Discord channel at a specific time. Use this when someone asks to be reminded about something.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The reminder message to send.' },
        remind_at: { type: 'string', description: 'ISO 8601 datetime when the reminder should fire, e.g. "2024-03-15T14:00:00".' },
      },
      required: ['message', 'remind_at'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List all pending reminders for this channel.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_reminder',
    description: 'Cancel a pending reminder by its index. Use list_reminders first to find the index.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Index of the reminder to cancel.' },
      },
      required: ['index'],
    },
  },
  {
    name: 'save_memory',
    description: 'Save a fact or note to long-term memory so you can recall it in future conversations. Use this proactively when users share important information.',
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact or note to remember, written as a clear, self-contained statement.' },
      },
      required: ['fact'],
    },
  },
  {
    name: 'get_memory',
    description: 'Retrieve all saved long-term memories. Call this when context from past conversations might be relevant.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_memory',
    description: 'Delete a specific memory by its index (0-based). Use get_memory first to find the index.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Index of the memory to delete.' },
      },
      required: ['index'],
    },
  },
];

async function runTool(name, input, { channelId, username } = {}) {
  if (name === 'set_reminder') {
    const remindAt = new Date(input.remind_at);
    if (isNaN(remindAt)) return { error: 'invalid datetime format' };
    if (remindAt <= new Date()) return { error: 'reminder time is in the past' };
    const reminders = loadReminders();
    reminders.push({
      channel_id: channelId,
      message: input.message,
      remind_at: remindAt.toISOString(),
      created_by: username,
      created_at: new Date().toISOString(),
    });
    saveReminders(reminders);
    return { scheduled: true, remind_at: remindAt.toISOString() };
  }

  if (name === 'list_reminders') {
    const reminders = loadReminders().filter(r => r.channel_id === channelId);
    return reminders.length ? reminders : 'no pending reminders for this channel.';
  }

  if (name === 'delete_reminder') {
    const reminders = loadReminders();
    const channelReminders = reminders.filter(r => r.channel_id === channelId);
    if (input.index < 0 || input.index >= channelReminders.length) return { error: 'index out of range' };
    const target = channelReminders[input.index];
    const updated = reminders.filter(r => r !== target);
    saveReminders(updated);
    return { cancelled: target.message };
  }


  if (name === 'search_projects') {
    const projects = await fetchAllProjects();
    const q = input.query.toLowerCase();
    const matches = projects.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      (p.tags || []).some(t => t.toLowerCase().includes(q)) ||
      (p.credits || []).some(c => c.name.toLowerCase().includes(q))
    );
    return matches.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      date: p.date,
      credits: p.credits,
      tags: p.tags,
      url: `https://fcc.lol/${p.id}`,
    }));
  }

  if (name === 'get_project') {
    const p = await fetchProject(input.id);
    return { ...p, url: `https://fcc.lol/${p.id}` };
  }

  if (name === 'get_projects_by_person') {
    const projects = await fetchProjectsByPerson(input.person);
    return projects.map(p => ({ id: p.id, name: p.name, description: p.description, date: p.date, tags: p.tags, url: `https://fcc.lol/${p.id}` }));
  }

  if (name === 'get_projects_by_tag') {
    const projects = await fetchProjectsByTag(input.tag);
    return projects.map(p => ({ id: p.id, name: p.name, description: p.description, date: p.date, credits: p.credits, url: `https://fcc.lol/${p.id}` }));
  }

  if (name === 'save_memory') {
    const memories = loadMemory();
    memories.push({ fact: input.fact, saved: new Date().toISOString() });
    saveMemory(memories);
    return { saved: true, total: memories.length };
  }

  if (name === 'get_memory') {
    const memories = loadMemory();
    return memories.length ? memories : 'no memories saved yet.';
  }

  if (name === 'delete_memory') {
    const memories = loadMemory();
    if (input.index < 0 || input.index >= memories.length) return { error: 'index out of range' };
    const removed = memories.splice(input.index, 1)[0];
    saveMemory(memories);
    return { deleted: removed.fact, remaining: memories.length };
  }

  throw new Error(`unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// Keep typing indicator alive while waiting for Claude
// ---------------------------------------------------------------------------
function startTyping(channel) {
  channel.sendTyping().catch(() => {});
  const interval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
  return () => clearInterval(interval);
}

// ---------------------------------------------------------------------------
// Call Claude with tool-use agentic loop
// ---------------------------------------------------------------------------
function buildSystemPrompt(messageTime) {
  return [
    'you are claude, an ai assistant for fcc studio — a creative studio with members zach, dan, and leo.',
    'the studio website is https://fcc.lol.',
    'you are chatting in the fcc studio discord server.',
    `the exact time this message was sent is ${messageTime} (UTC). use this as "now" when calculating reminder times.`,
    'you have tools to search and look up fcc studio projects — use them whenever someone asks about projects.',
    'you have long-term memory tools: use get_memory at the start of conversations to recall relevant context,',
    'and use save_memory proactively when users share important facts, preferences, or information worth remembering.',
    'use delete_memory if asked to forget something.',
    'you can schedule reminders with set_reminder — use it whenever someone asks to be reminded about something.',
    'for relative times ("in 2 hours", "tomorrow at noon") calculate from the message timestamp above.',
    'for absolute times without a timezone ("at 3pm"), ask the user which timezone they mean before setting the reminder.',
    'always write in all lowercase. never use emoji.',
    'be concise and conversational. use discord markdown (bold, italics, code blocks) when helpful.',
    'each user message is prefixed with their discord username so you know who is speaking.',
    memberMentionList(),
    'when referring to a member by name in your response, always use their discord mention format (<@ID>) instead of just their name.',
    'if you need to send a very long answer, offer to break it into parts.',
  ].join(' ');
}

async function askClaude(channelId, userTag, userText, messageTime) {
  addMessage(channelId, 'user', `${userTag}: ${userText}`);

  // Build a local messages array for the agentic loop (tool turns are not persisted to history)
  let messages = getHistory(channelId).map(m => ({ role: m.role, content: m.content }));

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(messageTime),
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const text = response.content.find(b => b.type === 'text')?.text ?? '...';
      addMessage(channelId, 'assistant', text);
      return text;
    }

    if (response.stop_reason === 'tool_use') {
      messages = [...messages, { role: 'assistant', content: response.content }];

      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === 'tool_use')
          .map(async b => {
            const result = await runTool(b.name, b.input, { channelId, username: userTag }).catch(e => ({ error: e.message }));
            return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(result) };
          })
      );

      messages = [...messages, { role: 'user', content: toolResults }];
    }
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
discord.once('clientReady', async () => {
  console.log(`Logged in as ${discord.user.tag}`);
  for (const guild of discord.guilds.cache.values()) {
    console.log(` - ${guild.name} (${guild.id})`);
    try {
      const members = await guild.members.fetch();
      members.forEach(m => {
        if (!m.user.bot) cacheMember(m.user.username, m.user.id, m.displayName);
      });
      console.log(`Cached ${memberCache.size} member(s).`);
    } catch {
      console.log('GuildMembers intent not enabled — member cache will populate from messages.');
    }
  }
  await registerCommands();
  startReminderChecker();
  console.log('Reminder checker started.');
});

discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  cacheMember(message.author.username, message.author.id, message.member?.displayName);
  const mentioned = message.mentions.has(discord.user) || message.content.includes(`<@${discord.user.id}>`);
  if (!mentioned) return;

  // Strip all @mentions from the message
  const content = message.content.replace(/<@!?\d+>/g, '').trim();

  if (!content) {
    await message.reply('Hey! Ask me anything — just @mention me with your question.');
    return;
  }

  const stopTyping = startTyping(message.channel);

  try {
    const reply = await askClaude(message.channelId, message.author.username, content, message.createdAt.toISOString());
    stopTyping();

    const chunks = splitMessage(reply);
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await message.channel.send(chunks[i]);
    }
  } catch (err) {
    stopTyping();
    console.error('Claude API error:', err);
    await message.reply('Sorry, something went wrong reaching Claude. Please try again.');
  }
});

discord.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'claude-clear') {
    clearHistory(interaction.channelId);
    await interaction.reply({ content: 'Conversation history cleared for this channel.', ephemeral: true });
  }

  if (interaction.commandName === 'claude-help') {
    await interaction.reply({
      content: [
        '**Claude Bot — Quick Guide**',
        '',
        '• **@Claude <question>** — Ask Claude anything',
        '• Claude remembers the last conversation in each channel',
        '• **/claude-clear** — Reset Claude\'s memory for this channel',
        '• **/claude-help** — Show this message',
      ].join('\n'),
      ephemeral: true,
    });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
discord.login(DISCORD_BOT_TOKEN);
