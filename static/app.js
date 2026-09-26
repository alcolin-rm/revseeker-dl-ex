// static/app.js
let pollTimer;

// ──────────────────────────────────────────────────────────────
// VK extension bridge
// ──────────────────────────────────────────────────────────────

// Paste the 32-character ID from chrome://extensions/ here.
// NOT the base64 RSA key. Example: abcdefghijklmnopabcdefghijklmnop
const EXTENSION_ID = "mlpanamejicbmllfgnbpigpeipecnnpd";

function setVKStatus(text, kind) {
    const el = document.getElementById('vkStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'hint' + (kind ? ' ' + kind : '');
}

function isExtensionBridgeAvailable() {
    return typeof chrome !== 'undefined'
        && chrome.runtime
        && typeof chrome.runtime.sendMessage === 'function';
}

function sendMessageToExtension(extensionId, message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(extensionId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

async function fetchFromVK() {
    const url = document.getElementById('vkUrl').value.trim();
    if (!url) {
        setVKStatus('❌ Paste a VK playlist URL first', 'error');
        return;
    }

    if (!isExtensionBridgeAvailable()) {
        setVKStatus(
            '❌ Extension API unavailable. Install the extension and reload this page.',
            'error'
        );
        return;
    }

    if (!EXTENSION_ID || EXTENSION_ID.includes('PASTE')) {
        setVKStatus('❌ Extension ID not configured in static/app.js', 'error');
        return;
    }

    const btn = document.getElementById('vkFetchBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Fetching...';
    setVKStatus('⏳ Contacting extension...');

    try {
        const pong = await sendMessageToExtension(EXTENSION_ID, { action: 'ping' });
        if (!pong || !pong.ok) {
            throw new Error('Extension did not respond. Check the extension ID.');
        }

        setVKStatus('⏳ Opening playlist in background...');
        const result = await sendMessageToExtension(EXTENSION_ID, {
            action: 'extractPlaylist',
            playlistUrl: url,
        });

        if (!result || result.error) {
            throw new Error((result && result.error) || 'Extension returned nothing');
        }

        const lines = result.tracks.map(
            (t, i) => `${i + 1}. ${t.artist} - ${t.title}`
        );
        const trackList = document.getElementById('trackList');
        trackList.value = lines.join('\n');
        document.getElementById('playlistName').value = result.playlistTitle || '';

        // Fire input event so the Download button enables
        trackList.dispatchEvent(new Event('input'));

        setVKStatus(
            `✅ Loaded ${result.total} tracks from "${result.playlistTitle}"`,
            'success'
        );
    } catch (e) {
        setVKStatus(`❌ ${e.message}`, 'error');
        console.error('[VK fetch]', e);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch track list from VK';
    }
}

// ──────────────────────────────────────────────────────────────
// Downloads
// ──────────────────────────────────────────────────────────────

async function startDownload() {
    const list = document.getElementById('trackList').value;
    if (!list.trim()) {
        alert('Paste a track list first');
        return;
    }

    const fd = new FormData();
    fd.append('track_list', list);
    fd.append('playlist_name', document.getElementById('playlistName').value);

    const btn = document.getElementById('downloadBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Starting...';

    try {
        const r = await fetch('/api/download', { method: 'POST', body: fd });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || 'Request failed');
        }
        startPolling();
    } catch (e) {
        alert('Error: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '⬇️ Download';
    }
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchJobs, 2000);
    fetchJobs();
}

async function fetchJobs() {
    try {
        const r = await fetch('/api/jobs');
        const d = await r.json();
        const jobs = d.jobs || {};
        renderJobs(jobs);
        renderLeechers(jobs);
    } catch (e) {
        // ignore
    }
}

function renderJobs(jobs) {
    const el = document.getElementById('jobsList');
    const entries = Object.values(jobs);

    if (!entries.length) {
        el.innerHTML = '<div class="muted">No active jobs</div>';
        return;
    }

    el.innerHTML = entries.map(j => {
        const pct = (j.progress || 0) * 100;
        const log = (j.log || []).slice(-50).join('\n');
        const folder = j.folder_name ? ` → ${escapeHtml(j.folder_name)}` : '';
        return `
            <div class="job ${j.status}">
                <div class="job-header">
                    <strong>${j.id}</strong>${folder}
                    <button class="small" data-joblog="${j.id}">📄 Full Log</button>
                </div>
                <div>${escapeHtml(j.message || '')}</div>
                <div class="progress">
                    <div class="progress-fill" style="width:${pct}%"></div>
                </div>
                <div class="job-stats">
                    ${j.downloaded || 0} / ${j.total || 0} downloaded |
                    ${j.failed || 0} failed
                </div>
                ${log ? `<pre>${escapeHtml(log)}</pre>` : ''}
            </div>
        `;
    }).join('');
}

function renderLeechers(jobs) {
    const el = document.getElementById('leechersList');
    const totals = {};

    for (const job of Object.values(jobs)) {
        const leech = job.leechers || {};
        for (const [user, count] of Object.entries(leech)) {
            totals[user] = (totals[user] || 0) + count;
        }
    }

    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
        el.innerHTML = '<div class="muted">No downloads yet</div>';
        return;
    }

    el.innerHTML = entries.map(([user, count]) => `
        <div class="leecher-row">
            <span class="leecher-name">${escapeHtml(user)}</span>
            <span class="leecher-count">${count} file${count === 1 ? '' : 's'}</span>
        </div>
    `).join('');
}

async function openFullLog(jobId) {
    const r = await fetch(`/api/jobs/${jobId}/log`);
    const d = await r.json();
    const w = window.open('', '_blank');
    w.document.write(
        `<pre style="background:#0a0a0f;color:#d0d0d0;padding:20px;` +
        `font-family:monospace;white-space:pre-wrap;word-break:break-all;">` +
        `${escapeHtml(d.log)}</pre>`
    );
}

async function resetConfig() {
    if (!confirm('Reset credentials and return to setup?')) return;
    await fetch('/api/config/reset', { method: 'POST' });
    window.location.href = '/setup';
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ──────────────────────────────────────────────────────────────
// Init — ONE listener, all wiring inside it
// ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const downloadBtn = document.getElementById('downloadBtn');
    const resetBtn = document.getElementById('resetBtn');
    const vkFetchBtn = document.getElementById('vkFetchBtn');
    const vkUrlInput = document.getElementById('vkUrl');
    const trackListArea = document.getElementById('trackList');

    function updateDownloadButton() {
        downloadBtn.disabled = !trackListArea.value.trim();
    }

    function updateFetchButton() {
        vkFetchBtn.disabled = !vkUrlInput.value.trim();
    }

    // Wire buttons
    downloadBtn.addEventListener('click', startDownload);
    resetBtn.addEventListener('click', resetConfig);
    vkFetchBtn.addEventListener('click', fetchFromVK);

    // Wire input listeners
    vkUrlInput.addEventListener('input', updateFetchButton);
    trackListArea.addEventListener('input', updateDownloadButton);

    // Event delegation for the Full Log buttons
    document.getElementById('jobsList').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-joblog]');
        if (btn) openFullLog(btn.dataset.joblog);
    });

    // Initial button state
    updateDownloadButton();
    updateFetchButton();

    startPolling();
});