require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource,
  entersState, VoiceConnectionStatus, AudioPlayerStatus,
} = require('@discordjs/voice');

const TRACKS_DIR = path.join(__dirname, 'Tracks');

// lowercased name (without extension) -> real file name on disk
function loadTracks() {
  const map = new Map();
  for (const file of fs.readdirSync(TRACKS_DIR)) {
    if (file.toLowerCase().endsWith('.ogg')) map.set(file.slice(0, -4).toLowerCase(), file);
  }
  return map;
}

const norm = (s) => s.trim().toLowerCase();

const playCommand = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a track in your voice channel')
  .addStringOption((o) => o.setName('location').setDescription('Location (e.g. Hangar, Sirius)').setRequired(true).setAutocomplete(true))
  .addStringOption((o) => o.setName('type').setDescription('Type (e.g. Combat, Explore)').setAutocomplete(true))
  .addStringOption((o) => o.setName('variant').setDescription('Variant / number (e.g. 3)').setAutocomplete(true));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const guilds = new Map(); // guildId -> { player, pick: () => file | null }

// Candidates for "<location>_<type>_random": every 3-segment track under that location/type
function randomPicker(location, type) {
  return () => {
    const files = [];
    for (const [name, file] of loadTracks()) {
      const segs = name.split('_');
      if (segs.length === 3 && segs[0] === location && segs[1] === type) files.push(file);
    }
    return files.length ? files[Math.floor(Math.random() * files.length)] : null;
  };
}

// "random" as location: any track outside Sirius, restricted to the given type if there is one
function randomLocationPicker(type) {
  return () => {
    const files = [];
    for (const [name, file] of loadTracks()) {
      const segs = name.split('_');
      if (segs[0] !== 'sirius' && (!type || segs[1] === type)) files.push(file);
    }
    return files.length ? files[Math.floor(Math.random() * files.length)] : null;
  };
}

function playNext(state) {
  const file = state.pick();
  if (!file) return null;
  state.player.play(createAudioResource(path.join(TRACKS_DIR, file)));
  return file;
}

function getState(guildId) {
  let state = guilds.get(guildId);
  if (!state) {
    state = { player: createAudioPlayer(), pick: null };
    state.player.on('error', (e) => console.error('Player error:', e.message));
    // Loop: when a track ends, play again (re-rolling if random)
    state.player.on(AudioPlayerStatus.Idle, () => {
      if (state.pick && getVoiceConnection(guildId)) playNext(state);
    });
    guilds.set(guildId, state);
  }
  return state;
}

client.once('clientReady', async () => {
  const body = [
    playCommand.toJSON(),
    new SlashCommandBuilder().setName('pause').setDescription('Pause the track (run again to resume)').toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('Stop playback and leave the voice channel').toJSON(),
  ];
  try {
    const gid = process.env.GUILD_ID;
    const target = gid ? await client.guilds.fetch(gid) : client.application;
    const cmds = await target.commands.set(body);
    console.log(`Registered ${cmds.size} commands ${gid ? `in guild ${gid}` : 'globally'}: ${cmds.map((c) => '/' + c.name).join(', ')}`);
  } catch (e) {
    console.error('Command registration failed:', e.message);
    console.error('Servers this bot is actually in:', client.guilds.cache.map((g) => `${g.name} (${g.id})`).join(', ') || 'none');
  }
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) return autocomplete(interaction);
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'pause') return pause(interaction);
  if (interaction.commandName === 'stop') return stop(interaction);
  if (interaction.commandName !== 'play') return;

  const parts = ['location', 'type', 'variant']
    .map((n) => interaction.options.getString(n))
    .filter((v) => v != null && norm(v) !== '')
    .map(norm);
  const key = parts.join('_');

  const isRandomLocation = parts[0] === 'random';
  const isRandom = isRandomLocation || (parts.length === 3 && parts[2] === 'random');
  const pick = isRandomLocation
    ? randomLocationPicker(parts[1])
    : isRandom
    ? randomPicker(parts[0], parts[1])
    : (() => { const f = loadTracks().get(key); return () => f ?? null; })();
  const file = pick();
  if (!file) return interaction.reply({ content: isRandomLocation ? `No non-Sirius tracks found for type \`${parts[1] ?? 'any'}\`.` : isRandom ? `No tracks found for \`${parts[0]}_${parts[1]}_*.ogg\`.` : `No track found for \`${key}.ogg\`.`, flags: MessageFlags.Ephemeral });

  const channel = interaction.member?.voice?.channel;
  if (!channel) return interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let connection = getVoiceConnection(interaction.guildId);
  if (!connection || connection.joinConfig.channelId !== channel.id) {
    connection?.destroy();
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
  }
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    connection.destroy();
    return interaction.editReply('Could not connect to the voice channel.');
  }

  const state = getState(interaction.guildId);
  state.pick = pick;
  connection.subscribe(state.player);
  playNext(state);
  await interaction.deleteReply();
});

// Acknowledge the command without leaving any visible message
async function silent(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.deleteReply();
}

function pause(interaction) {
  const player = guilds.get(interaction.guildId)?.player;
  if (!player || !getVoiceConnection(interaction.guildId)) {
    return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
  }
  if (player.state.status === AudioPlayerStatus.Paused) {
    player.unpause();
    return silent(interaction);
  }
  player.pause();
  return silent(interaction);
}

function stop(interaction) {
  const connection = getVoiceConnection(interaction.guildId);
  if (!connection) return interaction.reply({ content: 'Not in a voice channel.', flags: MessageFlags.Ephemeral });
  const state = guilds.get(interaction.guildId);
  if (state) {
    state.pick = null; // disable looping before stopping
    state.player.stop(true);
  }
  connection.destroy();
  return silent(interaction);
}

function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const order = ['location', 'type', 'variant'];
  const idx = order.indexOf(focused.name);
  // prefix made of the preceding (already typed) arguments
  const prefix = order.slice(0, idx).map((n) => interaction.options.getString(n)).filter(Boolean).map(norm);
  const seen = new Set();
  const randomLoc = prefix[0] === 'random';
  for (const name of loadTracks().keys()) {
    const segs = name.split('_');
    if (randomLoc) {
      if (idx === 1 && segs[0] !== 'sirius' && segs[1]) seen.add(segs[1]);
      continue;
    }
    if (prefix.some((p, i) => segs[i] !== p) || segs.length <= idx) continue;
    if (segs[idx].startsWith(norm(focused.value))) seen.add(segs[idx]);
  }
  if (focused.name === 'variant' && !randomLoc) seen.add('random');
  if (focused.name === 'location') seen.add('random');
  const choices = [...seen].filter((c) => c.startsWith(norm(focused.value))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 25);
  return interaction.respond(choices.map((c) => ({ name: c, value: c })));
}

client.login(process.env.DISCORD_TOKEN);
