// background.js - VK Tracklist Export
//
// Two jobs:
//   1. Serve the popup (extract from active tab, export to file)
//   2. Poll the Revseeker web app for commands and post results back

// ──────────────────────────────────────────────────────────────
// Message routing (popup)
// ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'extractFromActiveTab') {
        extractPlaylistFromActiveTab()
            .then(sendResponse)
            .catch(err => sendResponse({ error: err.message || String(err) }));
        return true;
    }
    sendResponse({ error: `Unknown action: ${msg && msg.action}` });
    return false;
});

// ──────────────────────────────────────────────────────────────
// Extraction from the currently active tab
// ──────────────────────────────────────────────────────────────

async function extractPlaylistFromActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    const url = tab.url || '';
    if (!url.includes('vk.com') && !url.includes('vk.ru')) {
        throw new Error('The active tab is not a VK page');
    }

    const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: extractPlaylistFromPage,
    });

    const result = results[0] && results[0].result;
    if (!result) throw new Error('Extraction returned nothing');
    if (result.error) throw new Error(result.error);
    return result;
}

// ──────────────────────────────────────────────────────────────
// Extraction in a background tab (used by the bridge)
// ──────────────────────────────────────────────────────────────

async function extractPlaylistInNewTab(playlistUrl) {
    if (!playlistUrl || typeof playlistUrl !== 'string') {
        throw new Error('Missing playlist URL');
    }

    const tab = await chrome.tabs.create({ url: playlistUrl, active: false });

    try {
        await waitForTabComplete(tab.id, 25000);
        await sleep(2500);

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: extractPlaylistFromPage,
        });

        const result = results[0] && results[0].result;
        if (!result) throw new Error('Extraction returned nothing');
        if (result.error) throw new Error(result.error);
        return result;
    } finally {
        try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function waitForTabComplete(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error('Tab load timed out'));
        }, timeoutMs);

        function listener(updatedTabId, info) {
            if (updatedTabId === tabId && info.status === 'complete' && !settled) {
                settled = true;
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }

        chrome.tabs.onUpdated.addListener(listener);
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ──────────────────────────────────────────────────────────────
// Poll the Revseeker web app for commands
// ──────────────────────────────────────────────────────────────

const REVSEEKER_BASE = "http://127.0.0.1:8000";
const POLL_INTERVAL_MINUTES = 0.1;   // roughly 6 seconds

// Register the alarm on install only. Chrome MV3 terminates the
// service worker between wakes, and calling create() at the top
// level would reset the timer each time the worker spins up.
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create("revseeker-poll", { periodInMinutes: POLL_INTERVAL_MINUTES });
});

// Belt and suspenders: if the worker was reloaded without onInstalled
// firing (e.g. after a manual reload in chrome://extensions), make
// sure the alarm still exists.
chrome.alarms.get("revseeker-poll", (existing) => {
    if (!existing) {
        chrome.alarms.create("revseeker-poll", { periodInMinutes: POLL_INTERVAL_MINUTES });
    }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== "revseeker-poll") return;

    let cmd;
    try {
        const r = await fetch(`${REVSEEKER_BASE}/api/extension/inbox`, {
            method: "GET",
            cache: "no-store",
        });
        if (!r.ok) return;
        cmd = await r.json();
    } catch (e) {
        // Web app not running or unreachable. Retry on next tick.
        return;
    }

    if (!cmd || !cmd.id) return;

    let result;
    try {
        result = await extractPlaylistInNewTab(cmd.playlistUrl);
    } catch (e) {
        result = { error: e.message || String(e) };
    }

    try {
        await fetch(`${REVSEEKER_BASE}/api/extension/result`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: cmd.id, result }),
        });
    } catch (e) {
        // Web app went away; the caller will time out waiting for the result.
    }
});

// ──────────────────────────────────────────────────────────────
// Runs inside the VK page's MAIN world so it can see window.vkApi
// Must be fully self-contained - no closures over outer variables.
// ──────────────────────────────────────────────────────────────

async function extractPlaylistFromPage() {
    function parsePlaylistFromUrl(url) {
        let m = url.match(/(?:music|audio)[/_]playlist[/](\d+)_(\d+)(?:_([A-Za-z0-9]+))?/);
        if (m) {
            return { ownerId: +m[1], playlistId: +m[2], accessKey: m[3] || '' };
        }
        const params = new URLSearchParams(window.location.search);
        const z = params.get('z') || '';
        m = z.match(/(\d+)_(\d+)(?:_([A-Za-z0-9]+))?/);
        if (m) {
            return { ownerId: +m[1], playlistId: +m[2], accessKey: m[3] || '' };
        }
        return null;
    }

    try {
        if (typeof window.vkApi === 'undefined') {
            await new Promise(r => setTimeout(r, 1500));
        }
        if (typeof window.vkApi === 'undefined') {
            return { error: 'window.vkApi not available - are you logged into VK?' };
        }

        const parsed = parsePlaylistFromUrl(window.location.href);
        if (!parsed) {
            return { error: 'Could not parse playlist ID from this URL.' };
        }
        const { ownerId, playlistId, accessKey } = parsed;

        const meta = await window.vkApi.api('audio.getPlaylistById', {
            playlist_id: playlistId,
            owner_id: ownerId,
            access_key: accessKey,
            extra_fields: 'owner,duration',
        });
        if (!meta || !meta.playlist) {
            return { error: 'Playlist not found or inaccessible.' };
        }
        const playlistTitle = meta.playlist.title || `playlist_${ownerId}_${playlistId}`;

        const entity = `${ownerId}_${playlistId}${accessKey ? '_' + accessKey : ''}`;
        const idsResp = await window.vkApi.api('audio.getAudioIdsBySource', {
            source: 'playlist',
            entity_id: entity,
        });
        const audioIds = (idsResp && idsResp.audios) || [];
        if (!audioIds.length) {
            return { error: 'Playlist is empty.' };
        }

        const tracks = [];
        for (let i = 0; i < audioIds.length; i += 100) {
            const chunk = audioIds.slice(i, i + 100);
            const ids = chunk.map(t => t.audio_id || t).join(',');
            const resp = await window.vkApi.api('audio.getById', { audios: ids });
            if (Array.isArray(resp)) {
                for (const t of resp) {
                    tracks.push({
                        artist: t.artist || 'Unknown',
                        title: t.title || 'Unknown',
                    });
                }
            }
        }

        return { playlistTitle, tracks, total: tracks.length };
    } catch (e) {
        return { error: e.message || String(e) };
    }
}