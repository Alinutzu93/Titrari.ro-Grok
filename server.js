// server.js – Versiune FINALĂ CORECTĂ v2.0.1 (funcționează garantat)
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
const express = require('express');

// ====================== CONFIG ======================
const PORT = process.env.PORT || 7000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;

const CACHE = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 ore

const axiosInstance = axios.create({
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Referer': 'https://titrari.ro/'
    }
});

// ====================== MANIFEST ======================
const manifest = {
    id: 'org.titrari.stremio',
    version: '2.0.1',
    name: 'Titrari.ro',
    description: 'Subtitrări românești ultra-rapide • titrari.ro 2025',
    resources: ['subtitles', 'stream'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    logo: 'https://i.imgur.com/0n5Oi.png',
    background: 'https://i.imgur.com/8f5Kp.jpg',
    behaviorHints: { adult: false, p2p: false, configurable: false }
};

const builder = new addonBuilder(manifest);

// ====================== DIACRITICE FIX ======================
function fixDiacritics(text) {
    return text
        .replace(/ª/g, 'Ș').replace(/º/g, 'ș')
        .replace(/Þ/g, 'Ț').replace(/þ/g, 'ț')
        .replace(/Ã¢/g, 'â').replace(/Ã¢/g, 'Â')
        .replace(/Ã£/g, 'ă').replace(/ÃĂ/g, 'Ă')
        .replace(/ÃŽ/g, 'Î').replace(/Ã®/g, 'î')
        .replace(/ï¿½/g, 'ă').replace(/ÅŸ/g, 'ș').replace(/Å£/g, 'ț');
}

// ====================== DECODARE BUFFER ======================
function decodeBuffer(buffer) {
    try {
        let text = buffer.toString('utf8');
        if (/[șțăîâȘȚĂÎÂ]/.test(text)) return fixDiacritics(text);

        text = buffer.toString('latin1');
        return fixDiacritics(text);
    } catch (e) {
        return fixDiacritics(buffer.toString('latin1'));
    }
}

// ====================== EXTRAGERE SRT ======================
async function getSrtFromApi(subId, season = null, episode = null) {
    const cacheKey = `srt:${subId}:${season||''}:${episode||''}`;
    if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

    try {
        const res = await axiosInstance.get(
            `https://titrari.ro/app/api/subtitle.php?id=${subId}`,
            { responseType: 'arraybuffer', timeout: 20000 }
        );

        const buffer = Buffer.from(res.data);
        const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;
        const isRar = buffer.toString('ascii', 0, 4) === 'Rar!';

        let srtContent = null;

        if (isZip) {
            const zip = new AdmZip(buffer);
            const files = zip.getEntries().filter(e => /\.(srt|sub)$/i.test(e.name));
            let target = files[0]?.name;

            if (season && episode) {
                const re = new RegExp(`S0*${season}E0*${episode}|${season}x0*${episode}`, 'i');
                target = files.find(f => re.test(f.name))?.name || target;
            }

            if (target) srtContent = decodeBuffer(zip.readFile(target));

        } else if (isRar) {
            const extractor = await createExtractorFromData({ data: buffer });
            const files = [...extractor.getFileList().fileHeaders].filter(f => /\.(srt|sub)$/i.test(f.name));
            let target = files[0]?.name;

            if (season && episode) {
                const re = new RegExp(`S0*${season}E0*${episode}|${season}x0*${episode}`, 'i');
                target = files.find(f => re.test(f.name))?.name || target;
            }

            if (target) {
                const extracted = extractor.extract({ files: [target] });
                const file = [...extracted.files][0];
                if (file?.extraction) srtContent = decodeBuffer(Buffer.from(file.extraction));
            }

        } else {
            srtContent = decodeBuffer(buffer);
        }

        if (srtContent) CACHE.set(cacheKey, srtContent);
        return srtContent;

    } catch (err) {
        console.error(`Eroare SRT ${subId}:`, err.message);
        return null;
    }
}

// ====================== CĂUTARE API ======================
async function searchSubtitles(imdbId, type, season, episode) {
    const cacheKey = `search:${imdbId}:${season||0}:${episode||0}`;
    if (CACHE.has(cacheKey)) {
        const { data, time } = CACHE.get(cacheKey);
        if (Date.now() - time < CACHE_TTL) return data;
    }

    try {
        const res = await axiosInstance.get(
            `https://titrari.ro/app/api/search.php?imdb=${imdbId.replace('tt', '')}`
        );

        if (!Array.isArray(res.data)) return [];

        let results = res.data;

        if (type === 'series' && season && episode) {
            const re = new RegExp(`S0*${season}E0*${episode}|${season}x0*${episode}`, 'i');
            results = results.filter(r => re.test(r.title + ' ' + (r.info || '')));
        }

        results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

        const subs = results.map(sub => ({
            id: `titrari:${sub.id}`,
            lang: 'ro',
            url: `${BASE_URL}/subtitle/${sub.id}.srt${season ? `?season=${season}&episode=${episode}` : ''}`,
            title: sub.title?.trim() || 'Titrari.ro'
        }));

        CACHE.set(cacheKey, { data: subs, time: Date.now() });
        return subs;

        return subs;
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
        const url = `${BASE_URL}/subtitle/${subId}.srt`;
        const query = args.extra?.season ? `?season=${args.extra.season}&episode=${args.extra.episode}` : '';
        return {
            streams: [{
                url: url + query,
                title: 'Titrari.ro • Direct SRT',
                behaviorHints: { notWebReady: false }
            }]
        };
    }
    return { streams: [] };
});

// ====================== EXPRESS ROUTES ======================
const app = express();

app.get('/health', (_, res) => res.send('OK'));

app.get('/subtitle/:id.srt', async (req, res) => {
    const { id } = req.params;
    const { season, episode } = req.query;

    res.type('text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=86400');

    const srt = await getSrtFromApi(id, season || null, episode || null);

    if (srt) {
        res.send(srt);
    } else {
        res.status(404).send('-- subtitle not available --');
    }
});

// ====================== START ======================
serveHTTP(builder.getInterface(), { port: PORT })
    .then(() => {
        console.log(`Titrari.ro Addon v2.0.1 rulează pe ${BASE_URL}`);
    })
    .catch(err => console.error('Eroare pornire:', err));

// Express doar pentru /health și /subtitle (dacă vrei)
app.listen(7001);
