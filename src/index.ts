import { 
    Client, 
    GatewayIntentBits, 
    Interaction, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} from 'discord.js';
import { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus, 
    VoiceConnection 
} from '@discordjs/voice';
import youtubedl from 'youtube-dl-exec';
import play from 'play-dl';
import fs from 'fs';
import path from 'path';

let token = process.env.DISCORD_TOKEN;
try {
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const lines = envContent.split('\n');
        for (const line of lines) {
            const [key, ...valueParts] = line.split('=');
            if (key && key.trim() === 'DISCORD_TOKEN' && valueParts.length > 0) {
                token = valueParts.join('=').trim();
            }
        }
    }
} catch (e) {}
token = token || '';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

interface ServerQueue {
    voiceChannel: any;
    textChannel: any;
    connection: VoiceConnection;
    player: any;
    songs: string[];
    audioProcess: any;
}
const queueMap = new Map<string, ServerQueue>();

// ==========================================
// 🟢 EL HACK DE SPOTIFY (API DIRECTA)
// ==========================================
async function getSpotifyTracks(url: string) {
    const clientId = '';      // <--- REEMPLAZÁ ESTO 
    const clientSecret = ''; // <--- REEMPLAZÁ ESTO 

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });
    
    if (!tokenRes.ok) throw new Error('Error de conexión con Spotify Auth');
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const match = url.match(/spotify\.com\/(playlist|track|album)\/([a-zA-Z0-9]+)/);
    if (!match) return [url];
    
    const type = match[1];
    const id = match[2];

    if (type === 'track') {
      const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        const track = await res.json();
        return [`${track.name} ${track.artists[0].name}`];
    } else if (type === 'playlist') {
        const res = await fetch(`https://api.spotify.com/v1/playlists/${id}/tracks?limit=50`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        const data = await res.json();
        return data.items.filter((item: any) => item.track).map((item: any) => `${item.track.name} ${item.track.artists[0].name}`);
    } else if (type === 'album') {
        const res = await fetch(`https://api.spotify.com/v1/albums/${id}/tracks?limit=50`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        const data = await res.json();
        return data.items.map((item: any) => `${item.name} ${item.artists[0].name}`);
    }
    return [url];
}

// ==========================================
// 🎶 FUNCIÓN MAESTRA QUE REPRODUCE Y ARMA BOTONES
// ==========================================
async function playSong(guildId: string, songQuery: string) {
    const serverQueue = queueMap.get(guildId);
    if (!serverQueue) return;
    if (!songQuery) return;

    if (serverQueue.audioProcess) {
        try { serverQueue.audioProcess.kill(); } catch (e) {}
        serverQueue.audioProcess = null;
    }

    try {
        let resource;
        let finalUrl = songQuery;
        let displayTitle = songQuery;

        if (!songQuery.startsWith('http')) {
            const searchResults = await play.search(songQuery, { limit: 1 });
            if (searchResults.length > 0) {
                finalUrl = searchResults[0].url;
                displayTitle = searchResults[0].title || songQuery;
            } else {
                throw new Error('No encontré nada en YouTube.');
            }
        }

        if (finalUrl.includes('youtube.com') || finalUrl.includes('youtu.be')) {
            let cleanUrl = finalUrl;
            if (finalUrl.includes('youtube.com/watch')) cleanUrl = finalUrl.split('&')[0];
            else if (finalUrl.includes('youtu.be/')) cleanUrl = finalUrl.split('?')[0];

            const subprocess = youtubedl.exec(cleanUrl, {
                output: '-',
                format: 'bestaudio',
            }, { stdio: ['ignore', 'pipe', 'ignore'] });

            subprocess.catch(() => {}); 
            serverQueue.audioProcess = subprocess;

            if (!subprocess.stdout) throw new Error('Falla en el tubo de audio');
            subprocess.stdout.on('error', () => {}); 

            resource = createAudioResource(subprocess.stdout);
     } else {
    // Si no es YouTube, buscamos el nombre en YouTube sí o sí
    const searchResults = await play.search(displayTitle, { limit: 1 });
    if (searchResults.length > 0) {
        // Acá volvés a llamar a la parte de yt-dlp para que descargue el audio de YouTube
        // O más fácil: llamá a la recursividad de playSong con el nuevo link
        return playSong(guildId, searchResults[0].url);
    }
}

        serverQueue.player.play(resource);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('btn_pause')
                .setLabel('⏸️ Pausa / ▶️ Play')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('btn_skip')
                .setLabel('⏭️ Saltar')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('btn_stop')
                .setLabel('🛑 Apagar')
                .setStyle(ButtonStyle.Danger)
        );

        serverQueue.textChannel.send({ 
            content: `🎶 Arranca a sonar: **${displayTitle}**`, 
            components: [row] 
        });

    } catch (error: any) {
        console.error('💥 Error reproduciendo:', error);
        serverQueue.textChannel.send('💥 El link reventó. Saltando a la siguiente...');
        serverQueue.songs.shift(); 
        if (serverQueue.songs.length > 0) {
            playSong(guildId, serverQueue.songs[0]); 
        } else {
            try { serverQueue.connection.destroy(); } catch (e) {}
            queueMap.delete(guildId);
        }
    }
}

client.once('ready', async () => {
    console.log(`🔥 PELUMUSIC ONLINE Y LISTO PARA EL CAOS como ${client.user?.tag}`);
    try { 
        await play.setToken({ soundcloud: { client_id: await play.getFreeClientID() } }); 
    } catch (e) {}
});

client.on('interactionCreate', async (interaction: Interaction) => {
    
    // ==========================================
    // 🖱️ MANEJADOR DE CLICKS EN BOTONES
    // ==========================================
    if (interaction.isButton()) {
        const guildId = interaction.guildId;
        if (!guildId) return;
        
        const serverQueue = queueMap.get(guildId);
        const voiceChannel = (interaction.member as any)?.voice?.channel;

        if (!voiceChannel) return interaction.reply({ content: 'Metete a un canal para tocar los botones, fantasma.', ephemeral: true });
        if (!serverQueue) return interaction.reply({ content: 'No hay nada sonando ahora mismo.', ephemeral: true });

        if (interaction.customId === 'btn_pause') {
            if (serverQueue.player.state.status === AudioPlayerStatus.Playing) {
                serverQueue.player.pause();
                return interaction.reply({ content: '⏸️ Pausado. Tocá el botón de nuevo para seguir.', ephemeral: true });
            } else if (serverQueue.player.state.status === AudioPlayerStatus.Paused) {
                serverQueue.player.unpause();
                return interaction.reply({ content: '▶️ Seguimos de joda.', ephemeral: true });
            }
            return interaction.reply({ content: 'No se puede pausar ahora.', ephemeral: true });
        }

        if (interaction.customId === 'btn_skip') {
            if (serverQueue.songs.length <= 1) {
                return interaction.reply({ content: '¡No hay ningun tema en la cola, pelotudo! Dale a apagar si querés cortarla.', ephemeral: true });
            }

            if (serverQueue.audioProcess) {
                try { serverQueue.audioProcess.kill(); } catch (e) {}
            }
            serverQueue.player.stop();
            return interaction.reply({ content: '⏭️ Skipiado.' });
        }

        if (interaction.customId === 'btn_stop') {
            serverQueue.songs = []; 
            if (serverQueue.audioProcess) {
                try { serverQueue.audioProcess.kill(); } catch (e) {}
            }
            serverQueue.player.stop();
            try { serverQueue.connection.destroy(); } catch (e) {}
            queueMap.delete(guildId); 
            return interaction.reply({ content: '🛑 Cortaste el mambo. Me voy.' });
        }
    }

    // ==========================================
    // ⌨️ MANEJADOR DE COMANDOS SLASH
    // ==========================================
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guildId } = interaction;
    if (!guildId) return;

    const serverQueue = queueMap.get(guildId);
    const voiceChannel = (interaction.member as any)?.voice?.channel;

    if (commandName === 'peluplay') {
        const urlValue = interaction.options.get('link')?.value;
        const query = typeof urlValue === 'string' ? urlValue.trim() : '';

        if (!voiceChannel) return interaction.reply({ content: 'Metete a un canal, pelotudo.', ephemeral: true });
        if (!query) return interaction.reply({ content: 'Escribime algo, no soy adivino.', ephemeral: true });
        
        await interaction.deferReply();

        let songsToAdd: string[] = [];

        if (query.includes('spotify.com')) {
            try {
                await interaction.editReply({ content: `🔄 Hackeando la base de datos de Spotify... bancame un toque.` });
                songsToAdd = await getSpotifyTracks(query);
            } catch (error) {
                console.error(error);
                return interaction.editReply({ content: '💥 Explotó Spotify. Revisá la consola.' });
            }
        } else {
            songsToAdd = [query];
        }

        if (!serverQueue) {
            const player = createAudioPlayer();
            player.on('error', (error: any) => console.error(`💥 Error en el reproductor: ${error.message}`));

            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: interaction.guild!.voiceAdapterCreator,
            });

            const queueConstruct: ServerQueue = {
                voiceChannel,
                textChannel: interaction.channel,
                connection,
                player,
                songs: songsToAdd,
                audioProcess: null
            };
            queueMap.set(guildId, queueConstruct);
            connection.subscribe(player);

            player.on(AudioPlayerStatus.Idle, () => {
                queueConstruct.songs.shift(); 
                if (queueConstruct.songs.length > 0) {
                    playSong(guildId, queueConstruct.songs[0]); 
                } else {
                    try { queueConstruct.connection.destroy(); } catch (e) {}
                    queueMap.delete(guildId);
                }
            });

            const textMsg = songsToAdd.length > 1 
                ? `✅ ¡Cargada playlist de **${songsToAdd.length}** temas! Arrancando el primero...` 
                : `✅ Agregado a la cola y buscando...`;
            
            await interaction.editReply({ content: textMsg });
            playSong(guildId, queueConstruct.songs[0]);
        } else {
            serverQueue.songs.push(...songsToAdd);
            const textMsg = songsToAdd.length > 1 
                ? `📝 ¡Se agregaron **${songsToAdd.length}** temas de la playlist a la cola!` 
                : `📝 Agregado a la cola. (Posición #${serverQueue.songs.length - 1})`;
            return interaction.editReply({ content: textMsg });
        }
    }

    if (commandName === 'peluskip') {
        if (!voiceChannel) return interaction.reply({ content: 'Metete a un canal primero.', ephemeral: true });
        if (!serverQueue || serverQueue.songs.length === 0) return interaction.reply({ content: 'No está sonando nada.', ephemeral: true });
        
        if (serverQueue.songs.length <= 1) {
            return interaction.reply({ content: '¡No hay ningun tema en la cola, pelotudo! Dale a /pelustop si querés cortarla.', ephemeral: true });
        }

        if (serverQueue.audioProcess) try { serverQueue.audioProcess.kill(); } catch (e) {}
        serverQueue.player.stop();
        return interaction.reply({ content: '⏭️ Skipiado.' });
    }
    
    if (commandName === 'pelustop') {
        if (!voiceChannel) return interaction.reply({ content: 'Metete a un canal primero.', ephemeral: true });
        if (!serverQueue) return interaction.reply({ content: 'Ya estoy callado.', ephemeral: true });
        serverQueue.songs = []; 
        if (serverQueue.audioProcess) try { serverQueue.audioProcess.kill(); } catch (e) {}
        serverQueue.player.stop();
        try { serverQueue.connection.destroy(); } catch (e) {}
        queueMap.delete(guildId); 
        return interaction.reply({ content: '🛑 Chau.' });
    }
});

// ¡ESTA ES LA LÍNEA QUE TE FALTABA Y POR ESO NO ARRANCABA!
client.login(token);