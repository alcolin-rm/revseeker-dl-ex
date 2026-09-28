// popup.js - runs in the popup context

const statusEl = document.getElementById('status');
const exportBtn = document.getElementById('exportCurrentBtn');
const copyBtn = document.getElementById('copyCurrentBtn');

let lastResult = null;

function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || '';
}

function formatTracks(result) {
    const lines = result.tracks.map(
        (t, i) => `${i + 1}. ${t.artist} - ${t.title}`
    );
    return `${result.playlistTitle}\n${'='.repeat(result.playlistTitle.length)}\n\n${lines.join('\n')}\n`;
}

function sanitizeFilename(name) {
    return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
}

function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (resp) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(resp);
            }
        });
    });
}

async function extractCurrent() {
    exportBtn.disabled = true;
    copyBtn.disabled = true;
    setStatus('Extracting...');

    try {
        const result = await sendToBackground({ action: 'extractFromActiveTab' });
        if (result.error) throw new Error(result.error);
        lastResult = result;
        setStatus(`Found ${result.total} tracks`, 'success');
        return result;
    } catch (e) {
        setStatus(e.message, 'error');
        throw e;
    } finally {
        exportBtn.disabled = false;
        copyBtn.disabled = false;
    }
}

exportBtn.addEventListener('click', async () => {
    try {
        const result = await extractCurrent();
        const text = formatTracks(result);
        const safeName = sanitizeFilename(result.playlistTitle);

        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        await chrome.downloads.download({
            url,
            filename: `${safeName}.txt`,
            saveAs: true,
        });

        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (_) {
        // extractCurrent already reported the error
    }
});

copyBtn.addEventListener('click', async () => {
    try {
        const result = lastResult || await extractCurrent();
        const text = formatTracks(result);
        await navigator.clipboard.writeText(text);
        setStatus(`Copied ${result.total} tracks to clipboard`, 'success');
    } catch (e) {
        setStatus(e.message, 'error');
    }
});