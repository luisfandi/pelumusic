import { 
    Client, 
    GatewayIntentBits, 
    Interaction, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChatInputCommandInteraction,
    StringSelectMenuBuilder,
    MessageFlags
} from 'discord.js';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus, 
    VoiceConnection,
    StreamType
} from '@discordjs/voice';
import youtubedl from 'youtube-dl-exec';
import play from 'play-dl';
import fs from 'fs';
import path from 'path';
import http from 'http';

// ==========================================
// 🌐 SERVIDOR HTTP PARA UPTIME (24/7)
// ==========================================
http.createServer((req: any, res: any) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('El bot esta online!');
}).listen(process.env.PORT || 3000);

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

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

interface ServerQueue {
    voiceChannel: any;
    textChannel: any;
    connection: VoiceConnection;
    player: any;
    songs: string[];
    audioProcess: any;
    leaveTimeout?: any;
    startTime?: number;
    currentFilter?: string;
}
const queueMap = new Map<string, ServerQueue>();

// ==========================================
// 🟢 EL HACK DE SPOTIFY (API DIRECTA)
// ==========================================
async function getSpotifyTracks(url: string) {
    const clientId = '';      
    const clientSecret = ''; 

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
    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const match = url.match(/spotify\.com\/(playlist|track|album)\/([a-zA-Z0-9]+)/);
    if (!match) return [url];
    
    const type = match[1];
    const id = match[2];

    if (type === 'track') {
        const res = await fetch(`https://api.spotify.com/v1/tracks/$$$${id}`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        const track: any = await res.json();
        return [`${track.name} ${track.artists[0].name}`];
    } else if (type === 'playlist') {
        const res = await fetch(`https://api.spotify.com/v1/playlists/$$$${id}/tracks?limit=50`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        const data: any = await res.json();
        return data.items.filter((item: any) => item.track).map((item: any) => `${item.track.name} ${item.track.artists[0].name}`);
    } else if (type === 'album') {
        const res = await fetch(`https://api.spotify.com/v1/albums/$$$${id}/tracks?limit=50`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        const data: any = await res.json();
        return data.items.map((item: any) => `${item.name} ${item.artists[0].name}`);
    }
    return [url];
}

// ==========================================
// 🎶 FUNCIÓN MAESTRA QUE REPRODUCE
// ==========================================
async function playSong(guildId: string, songQuery: string) {
    const serverQueue = queueMap.get(guildId);
    if (!serverQueue) return;
    if (!songQuery) return;

    if (serverQueue.audioProcess) {
        try { 
            if (serverQueue.audioProcess.stdin) serverQueue.audioProcess.stdin.destroy();
            if (serverQueue.audioProcess.stdout) serverQueue.audioProcess.stdout.destroy();
            serverQueue.audioProcess.kill('SIGKILL'); 
        } catch (e) {}
        serverQueue.audioProcess = null;
    }

    try {
        let finalUrl = songQuery;
        let displayTitle = songQuery;

        if (!songQuery.startsWith('http')) {
            const searchResults = await play.search(songQuery, { limit: 1, source: { youtube: 'video' } });
            if (searchResults.length > 0) {
                finalUrl = searchResults[0].url;
                displayTitle = searchResults[0].title || songQuery;
            } else {
                throw new Error('No encontré nada en YouTube.');
            }
        }

        let cleanUrl = finalUrl;
        if (finalUrl.includes('youtube.com/watch')) cleanUrl = finalUrl.split('&')[0];
        else if (finalUrl.includes('youtu.be/')) cleanUrl = finalUrl.split('?')[0];

        const subprocess = youtubedl.exec(cleanUrl, {
            output: '-',
            format: 'bestaudio',
        }, { stdio: ['ignore', 'pipe', 'ignore'] });

        subprocess.catch(() => {}); 
        if (!subprocess.stdout) throw new Error('Falla en el tubo de audio');
        subprocess.stdout.on('error', () => {}); 

        let filterString = '';
        if (serverQueue.currentFilter === 'speedup') {
            filterString = 'asetrate=48000*1.25,aresample=48000';
        } else if (serverQueue.currentFilter === 'slowed') {
            filterString = 'asetrate=48000*0.92,aresample=48000,aecho=0.8:0.7:60:0.5';
        }

        const ffmpegArgs: string[] = [
            '-thread_queue_size', '1024',
            '-i', 'pipe:0',         
            '-f', 's16le',          
            '-ar', '48000',         
            '-ac', '2'              
        ];
        
        if (filterString) ffmpegArgs.push('-af', filterString);
        ffmpegArgs.push('pipe:1');  

        const ffmpegProcess = spawn(ffmpegPath as string, ffmpegArgs);

        ffmpegProcess.stdin.on('error', (err: any) => {
            if (err.code === 'EPIPE') return;
        });

        subprocess.stdout.pipe(ffmpegProcess.stdin);
        serverQueue.audioProcess = ffmpegProcess;

        const resource = createAudioResource(ffmpegProcess.stdout, {
            inputType: StreamType.Raw,
            inlineVolume: false, 
        });

        serverQueue.player.play(resource);
        serverQueue.startTime = Date.now();

        // Armamos botonera básica
        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('btn_pause').setLabel('⏸️ / ▶️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_skip').setLabel('⏭️ Saltar').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_stop').setLabel('🛑 Apagar').setStyle(ButtonStyle.Danger)
        );

        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('btn_normal').setLabel('🎵 Normal').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('btn_speedup').setLabel('⚡ Speed Up').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_slowed').setLabel('🌫️ Slowed & Reverb').setStyle(ButtonStyle.Secondary)
        );

        const rows: any[] = [row1, row2];
      // 🔥 SISTEMA DE SUGERENCIAS ULTRA INTELIGENTE (ANTI-ÁLBUMES Y COMPILADOS)
        try {
            let palabraClaveFiltro = displayTitle.toLowerCase();
            let consultaBusqueda = `${displayTitle}`;

            if (displayTitle.includes('-')) {
                const partes = displayTitle.split('-');
                const artista = partes[0].trim();
                const cancion = partes[1].split(/[\(\[:\/]/)[0].trim().toLowerCase();
                if (cancion) {
                    palabraClaveFiltro = cancion;
                    consultaBusqueda = `${artista} songs`; // Buscamos canciones sueltas del artista
                }
            } else if (displayTitle.includes(':')) {
                const partes = displayTitle.split(':');
                const artista = partes[0].trim();
                const cancion = partes[1].split(/[\(\[:\/]/)[0].trim().toLowerCase();
                if (cancion) {
                    palabraClaveFiltro = cancion;
                    consultaBusqueda = `${artista} songs`;
                }
            }

            // Pedimos 25 resultados para tener un buen colchón para filtrar
            const resultadosMix = await play.search(consultaBusqueda, { limit: 25, source: { youtube: 'video' } });
            
            // 🚫 FILTRADO ESTRICTO: Chau clones, chau álbumes completos y chau videos eternos
            const filtrados = resultadosMix.filter((vid: any) => {
                const tituloVideo = vid.title ? vid.title.toLowerCase() : '';
                
                // Baneo de palabras clave que delatan un enganchado, mix largo o disco entero
                const palabrasProhibidas = ['album', 'compilation', 'compilado', 'full', 'completo', 'hits', 'collection', 'coleccion', 'mix', 'best of', 'grandes exitos', 'remix'];
                const tienePalabraProhibida = palabrasProhibidas.some(p => tituloVideo.includes(p));
                
                // Filtro por tiempo estricto: si el video dura más de 11 minutos (660 segundos), se descarta
                const esLargo = vid.durationInSec ? vid.durationInSec > 660 : false;

                return vid.url !== cleanUrl && !tituloVideo.includes(palabraClaveFiltro) && !tienePalabraProhibida && !esLargo;
            }).slice(0, 10);

            if (filtrados && filtrados.length > 0) {
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_sugerencia')
                    .setPlaceholder('💡 Elegí un tema similar para la cola...')
                    .addOptions(
                        filtrados.map((vid: any) => ({
                            label: vid.title ? vid.title.substring(0, 95) : 'Tema sugerido',
                            value: vid.url || 'error',
                            description: `Tema sugerido por PeluMusic`
                        })).filter((opt: any) => opt.value !== 'error')
                    );
                
                const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
                rows.push(row3);
            }
        } catch (error) {
            console.error('No pude cargar las sugerencias filtradas:', error);
        }
        const filterIcon = serverQueue.currentFilter === 'speedup' ? '⚡'
            : serverQueue.currentFilter === 'slowed' ? '🌫️'
            : '🎵';

        serverQueue.textChannel.send({ 
            content: `${filterIcon} Sonando: **${displayTitle}**`, 
            components: rows 
        });

    } catch (error: any) {
        console.error('💥 Error reproduciendo:', error);
        serverQueue.textChannel.send('💥 Error de reproducción... pasando al siguiente tema.');
        serverQueue.songs.shift(); 
        if (serverQueue.songs.length > 0) {
            playSong(guildId, serverQueue.songs[0]); 
        } else {
            try { serverQueue.connection.destroy(); } catch (e) {}
            queueMap.delete(guildId);
        }
    }
}

// Cambiado a clientReady para fixear el warning molesto
client.once('clientReady', async () => {
    console.log(`🔥 PELUMUSIC ONLINE Y READY PARA EL CAOS como ${client.user?.tag}`);
    try { 
        await play.setToken({ soundcloud: { client_id: await play.getFreeClientID() } }); 
    } catch (e) {}
});

client.on('interactionCreate', async (interaction: Interaction) => {
    
    if (interaction.isButton()) {
        const guildId = interaction.guildId;
        if (!guildId) return;
        
        const serverQueue = queueMap.get(guildId);
        const voiceChannel = (interaction.member as any)?.voice?.channel;

        if (!voiceChannel) return interaction.reply({ content: 'Metete a un canal para tocar los botones, fantasma.', flags: MessageFlags.Ephemeral });
        if (!serverQueue) return interaction.reply({ content: 'No hay nada sonando ahora mismo.', flags: MessageFlags.Ephemeral });

        if (interaction.customId === 'btn_pause') {
            if (serverQueue.player.state.status === AudioPlayerStatus.Playing) {
                serverQueue.player.pause();
                return interaction.reply({ content: '⏸️ Pausado.', flags: MessageFlags.Ephemeral });
            } else if (serverQueue.player.state.status === AudioPlayerStatus.Paused) {
                serverQueue.player.unpause();
                return interaction.reply({ content: '▶️ Seguimos de joda.', flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ content: 'No se puede pausar ahora.', flags: MessageFlags.Ephemeral });
        }

        if (interaction.customId === 'btn_skip') {
            if (serverQueue.songs.length <= 1) {
                return interaction.reply({ content: '¡No hay mas temas en la cola!', flags: MessageFlags.Ephemeral });
            }
            if (serverQueue.audioProcess) {
                try { 
                    serverQueue.audioProcess.stdin?.destroy();
                    serverQueue.audioProcess.stdout?.destroy();
                    serverQueue.audioProcess.kill('SIGKILL'); 
                } catch (e) {}
            }
            serverQueue.currentFilter = undefined; 
            serverQueue.player.stop();
            return interaction.reply({ content: '>>>> Skipiado.' });
        }

        if (interaction.customId === 'btn_stop') {
            serverQueue.songs = []; 
            if (serverQueue.audioProcess) {
                try { 
                    serverQueue.audioProcess.stdin?.destroy();
                    serverQueue.audioProcess.stdout?.destroy();
                    serverQueue.audioProcess.kill('SIGKILL'); 
                } catch (e) {}
            }
            serverQueue.player.stop();
            try { serverQueue.connection.destroy(); } catch (e) {}
            queueMap.delete(guildId); 
            return interaction.reply({ content: '🛑 HASTA LUEGO NEGRO' });
        }

        if (['btn_normal', 'btn_speedup', 'btn_slowed'].includes(interaction.customId)) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const filterMap: Record<string, string | undefined> = {
                'btn_normal': undefined,
                'btn_speedup': 'speedup',
                'btn_slowed': 'slowed',
            };
            
            if (serverQueue.currentFilter === filterMap[interaction.customId]) {
                return interaction.editReply({ content: 'Ese filtro ya está activo, fiera.' });
            }

            serverQueue.currentFilter = filterMap[interaction.customId];
            const currentSong = serverQueue.songs[0];
            
            if (serverQueue.audioProcess) {
                try { 
                    if (serverQueue.audioProcess.stdin) serverQueue.audioProcess.stdin.destroy();
                    if (serverQueue.audioProcess.stdout) serverQueue.audioProcess.stdout.destroy();
                    serverQueue.audioProcess.kill('SIGKILL'); 
                } catch (e) {}
            }
            
            serverQueue.songs.unshift(currentSong); 
            serverQueue.player.stop(true);
            
            const effectName = interaction.customId.split('_')[1].toUpperCase();
            return interaction.editReply({ content: `🎛️ Filtro **${effectName}** aplicado. Re-esculpiendo audio...` });
        }
    }

    if (interaction.isStringSelectMenu()) {
        const guildId = interaction.guildId;
        if (!guildId) return;

        if (interaction.customId === 'select_sugerencia') {
            const urlElegida = interaction.values[0];
            const serverQueue = queueMap.get(guildId);
            
            if (!serverQueue) {
                return interaction.reply({ content: 'No hay cola activa ahora.', flags: MessageFlags.Ephemeral });
            }

            serverQueue.songs.push(urlElegida);
            return interaction.reply({ 
                content: `✅ ¡Agregado por sugerencia! (Posición #${serverQueue.songs.length - 1})` 
            });
        }
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guildId } = interaction;
    if (!guildId) return;

    const serverQueue = queueMap.get(guildId);
    const voiceChannel = (interaction.member as any)?.voice?.channel;

    if (commandName === 'peluplay') {
        const urlValue = interaction.options.get('link')?.value;
        const query = typeof urlValue === 'string' ? urlValue.trim() : '';

        if (!voiceChannel) return interaction.reply({ content: 'Metete a un canal, fiera.', flags: MessageFlags.Ephemeral });
        if (!query) return interaction.reply({ content: 'Pasame un tema válido.', flags: MessageFlags.Ephemeral });
        
        await interaction.deferReply();

        let songsToAdd: string[] = [];

        if (query.includes('spotify.com')) { 
            try {
                await interaction.editReply({ content: `🔄 Cargando links de Spotify...` });
                songsToAdd = await getSpotifyTracks(query);
            } catch (error) {
                return interaction.editReply({ content: '💥 Error con la API de Spotify.' });
            }
        } else {
            songsToAdd = [query];
        }

        let textMsg = '';
        if (!serverQueue) {
            textMsg = songsToAdd.length > 1 
                ? `✅ Playlist cargada (${songsToAdd.length} temas).` 
                : `✅ Buscando tema...`;
        } else {
            textMsg = `📝 Agregado a la cola (Posición #${serverQueue.songs.length})`;
        }

        if (!serverQueue) {
            const player = createAudioPlayer();
            player.on('error', (error: any) => {
                if (error.message.includes('EPIPE') || error.message.includes('aborted') || error.message.includes('Premature close')) return;
                console.error(`💥 Error en el reproductor: ${error.message}`);
            });

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
                    queueConstruct.leaveTimeout = setTimeout(() => {
                        try { queueConstruct.connection.destroy(); } catch (e) {}
                        queueMap.delete(guildId);
                        queueConstruct.textChannel.send('💤 Sala vacía. Me fui a dormir.');
                    }, 15 * 60 * 1000); 
                }
            });

            await interaction.editReply({ content: textMsg });
            playSong(guildId, queueConstruct.songs[0]);
        } else {
            if (serverQueue.leaveTimeout) {
                clearTimeout(serverQueue.leaveTimeout);
                serverQueue.leaveTimeout = null;
            }

            serverQueue.songs.push(...songsToAdd);
            await interaction.editReply({ content: textMsg });
            
            if (serverQueue.songs.length === songsToAdd.length) {
                playSong(guildId, serverQueue.songs[0]);
            }
        }
    }

    if (commandName === 'peluskip') {
        if (!voiceChannel) return interaction.reply({ content: 'Metete a un canal.', flags: MessageFlags.Ephemeral });
        if (!serverQueue || serverQueue.songs.length === 0) return interaction.reply({ content: 'No hay música.', flags: MessageFlags.Ephemeral });
        
        if (serverQueue.songs.length <= 1) return interaction.reply({ content: 'La cola está vacía.', flags: MessageFlags.Ephemeral });

        if (serverQueue.audioProcess) try { serverQueue.audioProcess.kill('SIGKILL'); } catch (e) {}
        serverQueue.currentFilter = undefined;
        serverQueue.player.stop();
        return interaction.reply({ content: '⏭️ Skipiado.' });
    }
    
    if (commandName === 'pelustop') {
        if (!voiceChannel) return interaction.reply({ content: 'Metete a un canal.', flags: MessageFlags.Ephemeral });
        if (!serverQueue) return interaction.reply({ content: 'Ya estoy apagado.', flags: MessageFlags.Ephemeral });

        serverQueue.songs = []; 
        if (serverQueue.audioProcess) try { serverQueue.audioProcess.kill('SIGKILL'); } catch (e) {}
        serverQueue.player.stop();
        try { serverQueue.connection.destroy(); } catch (e) {}
        queueMap.delete(guildId); 
        return interaction.reply({ content: '🛑 Desconectado.' });
    }
});

client.login(token);

process.on('uncaughtException', (error: any) => {
    if (error.code === 'EPIPE' || error.message.includes('EPIPE')) return;
    console.error('💥 Error global interceptado:', error);
});

process.on('unhandledRejection', (reason: any) => {
    console.error('💥 Promesa rota interceptada:', reason);
});