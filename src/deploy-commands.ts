import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

// 1. ID de tu bot
const clientId = '1507396648320503828'; 

// 2. Levanta el token de tu archivo .env automáticamente
let token = process.env.DISCORD_TOKEN;
try {
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const lines = envContent.split('\n');
        for (const line of lines) {
            const [key, ...valueParts] = line.split('=');
            if (key && key.trim() === 'DISCORD_TOKEN' && valueParts.length > 0) {
                let rawToken = valueParts.join('=').trim();
                // Si le pusiste comillas en el .env, las limpiamos acá para que no falle
                if ((rawToken.startsWith('"') && rawToken.endsWith('"')) || (rawToken.startsWith("'") && rawToken.endsWith("'"))) {
                    rawToken = rawToken.slice(1, -1);
                }
                token = rawToken;
            }
        }
    }
} catch (e) {}

// 🔥 DIAGNÓSTICO: Te avisa en la consola si leyó algo o no
console.log(`🔍 Diagnóstico: ${token ? `Token detectado (${token.length} caracteres)` : '❌ TOKEN NO ENCONTRADO (Está vacío o el archivo .env no está en la raíz)'}`);

if (!token) {
    console.error('⛔ Frenando ejecución: Sin un token válido, Discord siempre va a tirar 401.');
    process.exit(1);
}

const commands = [
    new SlashCommandBuilder()
        .setName('peluplay')
        .setDescription('Reproduce un tema de YouTube o Spotify')
        .addStringOption((option: any) => 
            option.setName('link')
                .setDescription('Link o nombre de la canción')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('peluskip')
        .setDescription('Salta al siguiente tema'),
    new SlashCommandBuilder()
        .setName('pelustop')
        .setDescription('Apaga el bot por completo')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('🔄 Registrando comandos globales para todos los servidores...');

        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands },
        );

        console.log('✅ ¡Comandos registrados a nivel global con éxito!');
    } catch (error) {
        console.error('💥 Error al registrar los comandos:', error);
    }
})();