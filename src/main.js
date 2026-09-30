import { Actor, log } from 'apify';
import { buildUrl, flattenProvider, harvest, initialSegments } from './lib.js';

const EVENT = 'provider';

async function fetchJson(url, attempt = 1) {
    try {
        const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'npi-bulk-exporter (Apify actor)' } });
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        if (attempt >= 5) throw err;
        const wait = 1000 * 2 ** attempt;
        log.warning(`Request failed (${err.message}), retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        return fetchJson(url, attempt + 1);
    }
}

await Actor.init();
const input = (await Actor.getInput()) || {};
const maxResults = Number.isInteger(input.maxResults) && input.maxResults > 0 ? input.maxResults : Infinity;
const includeRaw = Boolean(input.includeRaw);
let pushed = 0;
let limitReached = false;

const pushRows = async (rows) => {
    const batch = rows.slice(0, maxResults - pushed).map((r) => flattenProvider(r, { includeRaw }));
    if (!batch.length) return false;
    const charge = await Actor.pushData(batch, EVENT);
    pushed += batch.length;
    if (charge?.eventChargeLimitReached) limitReached = true;
    return pushed < maxResults && !limitReached;
};

const npiNumbers = (input.npiNumbers || []).map((n) => String(n).replace(/\D/g, '')).filter((n) => n.length === 10);

if (npiNumbers.length) {
    log.info(`Looking up ${npiNumbers.length} NPI numbers`);
    for (let i = 0; i < npiNumbers.length && pushed < maxResults && !limitReached; i += 5) {
        const chunk = npiNumbers.slice(i, i + 5);
        const pages = await Promise.all(chunk.map((number) => fetchJson(buildUrl({ number }, 0, 1))));
        const found = pages.flatMap((p) => p.results || []);
        if (found.length) await pushRows(found);
    }
} else {
    const segments = initialSegments(input);
    if (Object.keys(segments[0]).length === 0) {
        throw new Error('Give at least one filter (taxonomy, state, city, ZIP, name) or a list of NPI numbers.');
    }
    const stats = await harvest(
        segments,
        async (params, skip) => fetchJson(buildUrl(params, skip)),
        async (rows) => {
            const more = await pushRows(rows);
            await Actor.setStatusMessage(`Exported ${pushed} providers`);
            return more;
        },
        { concurrency: 4, log: (m) => log.warning(m) },
    );
    log.info(`Done: ${stats.requests} API requests, ${stats.segments} segments, ${stats.splits} splits.`);
    if (stats.truncatedSegments.length) {
        log.warning(`${stats.truncatedSegments.length} segment(s) hit the API cap even at single-ZIP level; narrow the filters for full coverage.`);
    }
}

if (limitReached) log.info('Stopped at the maximum charge set for this run.');
await Actor.setStatusMessage(`Finished: ${pushed} providers exported`, { isStatusMessageTerminal: true });
await Actor.exit();
