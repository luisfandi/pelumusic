import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

// Parche para leer el token en Windows
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
} catch (e) {
    console.log('⚠️ Error al leer .env');
}
token = token || '';

const clientId = '1507396648320503828'; // Tu ID de bot

const commands = [
    new SlashCommandBuilder()
        .setName('peluplay')
        .setDescription('Reproduce una canción o la agrega a la cola')
        .addStringOption(option =>
            option.setName('link')
                .setDescription('El link de YouTube/SoundCloud o el nombre del tema')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('peluskip')
        .setDescription('Salta a la siguiente canción de la cola'),
    new SlashCommandBuilder()
        .setName('pelustop')
        .setDescription('Corta la música, limpia la cola y se va a la mierda'),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('⏳ Registrando los comandos nuevos...');
        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands },
        );
        console.log('✅ Comandos /peluplay, /peluskip y /pelustop registrados con éxito globalmente.');
    } catch (error) {
        console.error(error);
    }
})();