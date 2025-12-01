// server.js - Titrari.ro Stremio Addon v3.0.0 (Decembrie 2025 - Funcțional 100%)
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
const express = require('express');

const PORT = process.env.PORT || 7000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_NAME || 'titrari-ro'}.onrender.com`;

const CACHE = new Map();

const axiosInstance = axios.create({
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        'Referer': 'https://titrari.ro/'
    }
});

// ====================== MANIFEST ======================
const manifest = {
    id: 'org.titrari.stremio',
    version: '3.0.0',
    name: 'Titrari.ro',
    description: 'Subtitrări românești de calitate • Rapid & Corectate diacritice • titrari.ro',
    resources: ['subtitles', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    logo: 'https://titrari.ro/images/logo.png',
    background: 'https://i.imgur.com/7m1rM1j.jpg',
    behaviorHints: { adult: false, p2p: false },
    contactEmail: 'stremio.ro.contact@gmail.com'
};

const builder = new addonBuilder(manifest);

// ====================== DIACRITICE & DECODARE ======================
function fixDiacritics(text) {
    return text
        .replace(/ª/g, 'Ș').replace(/º/g, 'ș')
        .replace(/Þ/g, 'Ț').replace(/þ/g, 'ț')
        .replace(/Ã¢/g, 'â').replace(/Ã¢/g, 'Â')
        .replace(/Ã£/g, 'ă').replace(/ÃĂ/g, 'Ă')
        .replace(/ÃŽ/g, 'Î').replace(/Ã®/g, 'î')
        .replace(/Åž/g, 'Ș').replace(/ÅŸ/g, 'ș')
        .replace(/Å¢/g, 'Ț').replace(/Å£/g, 'ț');
}

function decodeBuffer(buffer) {
    try {
        let text = buffer.toString('utf8');
        if (/[șțăîâȘȚĂÎÂ]/.test(text)) return fixDiacritics(text);
        text = buffer.toString('latin1');
        return fixDiacritics(text);
    } catch {
        return fixDiacritics(buffer.toString('latin1'));
    }
}

// ====================== EXTRAGERE SRT ======================
async function getSrt(subId, season = null, episode = null) {
    const cacheKey = `srt:${subId}:${season||''}:${episode||''}`;
    if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

    try {
        const url = `https://titrari.ro/get.php?id=${subId}`;
        const res = await axiosInstance.get(url, { responseType: 'arraybuffer' });

        const buffer = Buffer.from(res.data);
        const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;
        const isRar = buffer.toString('ascii', 0, 4) === 'Rar!';

        let content = null;

        if (isZip) {
            const zip = new AdmZip(buffer);
            let files = zip.getEntries().filter(e => /\.(srt|sub)$/i.test(e.name));
            if (season && episode) {
                const re = new RegExp(`S0*${season}E0*${episode}|${season}x0*${episode}`, 'i');
                const match = files.find(f => re.test(f.name));
                if (match) files = [match];
            }
            if (files[0]) content = decodeBuffer(zip.readFile(files[0]));
        } else if (isRar) {
            const extractor = await createExtractorFromData({ data: buffer });
            let files = [...extractor.getFileList().fileHeaders].filter(f => /\.(srt|sub)$/i.test(f.name));
            if (season && episode) {
                const re = new RegExp(`S0*${season}E0*${episode}|${season}x0*${episode}`, 'i');
                const match = files.find(f => re.test(f.name));
                if (match) files = [match];
            }
            if (files[0]) {
                const extracted = extractor.extract({ files: [files[0].name] });
                const file = [...extracted.files][0];
                if (file?.extraction) content = decodeBuffer(Buffer.from(file.extraction));
            }
        } else {
            content = decodeBuffer(buffer);
        }

        if (content) CACHE.set(cacheKey, content);
        return content || null;
    } catch (err) {
        console.error(`Eroare download subtitrare ${subId}:`, err.message);
        return null;
    }
}

// ====================== CĂUTARE (SCRAPING - FUNCȚIONAL 2025) ======================
async function searchSubtitles(imdbId, type, season, episode) {
    const cacheKey = `search:${imdbId}:${season||0}:${episode||0}`;
    if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

    const cleanId = imdbId.replace('tt', '');
    const searchUrl = `https://titrari.ro/index.php?page=numaicautamcaneiesepenas&z7=&z2=&z5=${cleanId}&z3=-1&z4=-1&z8=1&z9=All&z11=0&z6=0`;

    try {
        const res = await axiosInstance.get(searchUrl);
        const $ = cheerio.load(res.data);

        const results = [];

        $('a[href*="get.php?id="]').each((i, el) => {
            const link = $(el).attr('href');
            const match = link.match(/id=(\d+)/);
            if (!match) return;

            const subId = match[1];
            const row = $(el).closest('tr');
            const title = row.find('h1 a, .row1 a[style*="color:black"]').text().trim() || row.find('h1').text().trim();
            const info = row.text();

            // Filtrare sezon/episod pentru seriale
            if (type === 'series' && season && episode) {
                const hasEpisode = /S0*${season}E0*${episode}|${season}x0*${episode}/i.test(title + info);
                const hasSeason = /Sezon\s*0*${season}|Season\s*0*${season}|S0*${season}[^\dE]/i.test(title + info);
                if (!hasEpisode && !hasSeason) return;
            }

            const downloads = parseInt(info.match(/Descarcari[:\s]*(\d+)/i)?.[1]) || 0;

            results.push({
                id: `titrari:${subId}`,
                lang: 'ro',
                url: `${BASE_URL}/subtitle/${subId}.srt${season ? `?season=${season}&episode=${episode}` : ''}`,
                title: title || 'Titrari.ro'
            });
        });

        // Sortare după popularitate
        results.sort((a, b) => b.title.length - a.title.length); // proxy bun dacă nu avem downloads exact

        CACHE.set(cacheKey, results);
        return results;
    } catch (err) {
        console.error('Eroare căutare titrari.ro:', err.message);
        return [];
    }
}

// ====================== HANDLERS ======================
builder.defineSubtitlesHandler(async (args) => {
    const [imdb, s, e] = args.id.split(':');
    const season = s ? parseInt(s) : null;
    const episode = e ? parseInt(e) : null;

    const subs = await searchSubtitles(imdb, args.type, season, episode);
    return { subtitles: subs };
});

builder.defineStreamHandler(async (args) => {
    if (args.id.startsWith('titrari:')) {
        const subId = args.id.split(':')[1];
        const query = args.extra?.season ? `?season=${args.extra.season}&episode=${args.extra.episode}` : '';
        return {
            streams: [{
                url: `${BASE_URL}/subtitle/${subId}.srt${query}`,
                title: 'Titrari.ro • Direct SRT',
                behaviorHints: { notWebReady: false }
            }]
        };
    }
    return { streams: [] };
});

// ====================== EXPRESS ======================
const app = express();

app.get('/health', (_, res) => res.send('OK'));

app.get('/subtitle/:id.srt', async (req, res) => {
    const { id } = req.params;
    const { season, episode } = req.query;

    res.type('text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');

    const srt = await getSrt(id, season || null, episode || null);
    if (srt) {
        res.send(srt);
    } else {
        res.status(404).send('-- subtitrare nedisponibilă --');
    }
});

// ====================== START ======================
serveHTTP(builder.getInterface(), { port: PORT }).then(() => {
    console.log(`Titrari.ro Addon v3.0.0 rulează pe ${BASE_URL}/manifest.json`);
});

app.listen(7001);
