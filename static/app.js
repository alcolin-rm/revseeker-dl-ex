// static/app.js
let pollTimer;

// ──────────────────────────────────────────────────────────────
// Status helper
// ──────────────────────────────────────────────────────────────

function setVKStatus(text, kind) {
    const el = document.getElementById('vkStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
}

// ──────────────────────────────────────────────────────────────
// Fetch from VK via the extension bridge
// ──────────────────────────────────────────────────────────────

async function fetchFromVK() {
    const albumOrLink = document.getElementById('albumOrLink');
    const url = albumOrLink.value.trim();

    if (!url.startsWith('http')) {
        setVKStatus('Paste a VK playlist URL (https://...) first', 'error');
        return;
    }

    const btn = document.getElementById('vkFetchBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';
    setVKStatus('Submitting command to extension bridge...', 'info');

    try {
        const fd = new FormData();
        fd.append('playlist_url', url);
        const submit = await fetch('/api/vk-command', { method: 'POST', body: fd });
        if (!submit.ok) {
            const err = await submit.json().catch(() => ({}));
            throw new Error(err.detail || 'Could not submit command');
        }
        const { command_id } = await submit.json();

        setVKStatus('Waiting for extension to respond (up to 30 seconds)...', 'info');
        btn.textContent = 'Waiting...';

        const deadline = Date.now() + 30000;
        let result = null;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 1500));
            const r = await fetch(`/api/vk-command/${command_id}`, { cache: 'no-store' });
            const d = await r.json();
            if (d.status === 'done') {
                result = d.result;
                break;
            }
        }

        if (!result) {
            throw new Error(
                'No response from the extension. Make sure it is installed, ' +
                'loaded in this browser, and the Revseeker web app is running at ' +
                'http://127.0.0.1:8000.'
            );
        }
        if (result.error) {
            throw new Error(result.error);
        }

        const lines = result.tracks.map(
            (t, i) => `${i + 1}. ${t.artist} - ${t.title}`
        );
        const trackList = document.getElementById('trackList');
        trackList.value = lines.join('\n');

        if (albumOrLink.value.trim().startsWith('http') && result.playlistTitle) {
            albumOrLink.value = result.playlistTitle;
        }

        trackList.dispatchEvent(new Event('input'));
        albumOrLink.dispatchEvent(new Event('input'));

        setVKStatus(
            `Loaded ${result.total} tracks from "${result.playlistTitle}"`,
            'success'
        );
    } catch (e) {
        setVKStatus(e.message, 'error');
        console.error('[VK fetch]', e);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch from VK';
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
    fd.append('playlist_name', document.getElementById('albumOrLink').value);
    fd.append('album_mode', document.getElementById('preferOneSeeder').checked ? 'true' : 'false');

    const btn = document.getElementById('downloadBtn');
    btn.disabled = true;
    btn.textContent = 'Starting...';

    try {
        const r = await fetch('/api/download', { method: 'POST', body: fd });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || 'Request failed');
        }
        const data = await r.json();
        setVKStatus(
            `Download started - job ${data.job_id} (${data.total} tracks)`,
            'success'
        );
        startPolling();
    } catch (e) {
        setVKStatus(e.message, 'error');
        alert('Error: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Download';
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
        renderBrowseWindow(jobs);
    } catch (e) {
        // ignore
    }
}

// ──────────────────────────────────────────────────────────────
// Jobs panel
// ──────────────────────────────────────────────────────────────

function renderJobs(jobs) {
    const block = document.getElementById('logsBlock');
    const el = document.getElementById('jobsList');
    const entries = Object.values(jobs);

    if (!entries.length) {
        block.classList.add('hidden');
        return;
    }
    block.classList.remove('hidden');

    el.innerHTML = entries.map(j => {
        const pct = (j.progress || 0) * 100;
        const log = (j.log || []).slice(-50).join('\n');
        const folder = j.folder_name ? ` -> ${escapeHtml(j.folder_name)}` : '';
        return `
            <div class="job ${j.status}" data-jobid="${j.id}">
                <div class="job-header">
                    <span><strong>${j.id}</strong>${folder}</span>
                    <button class="small" data-joblog="${j.id}">Full Log</button>
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

function clearFinishedJobs() {
    document.querySelectorAll('.job').forEach(el => {
        if (el.classList.contains('complete') ||
            el.classList.contains('error') ||
            el.classList.contains('cancelled')) {
            el.style.display = 'none';
        }
    });
    const visible = [...document.querySelectorAll('.job')].some(
        el => el.style.display !== 'none'
    );
    if (!visible) {
        document.getElementById('logsBlock').classList.add('hidden');
    }
}

// ──────────────────────────────────────────────────────────────
// Seeders panel
// ──────────────────────────────────────────────────────────────

function renderLeechers(jobs) {
    const block = document.getElementById('seedersBlock');
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
        block.classList.add('hidden');
        return;
    }
    block.classList.remove('hidden');

    el.innerHTML = entries.map(([user, count]) => `
        <div class="leecher-row">
            <span class="leecher-name">${escapeHtml(user)}</span>
            <span class="leecher-count">${count} file${count === 1 ? '' : 's'}</span>
        </div>
    `).join('');
}

// ──────────────────────────────────────────────────────────────
// Fake Soulseek panel
// ──────────────────────────────────────────────────────────────

function renderBrowseWindow(jobs) {
    const scroll = document.getElementById('browseScroll');

    const withResults = Object.values(jobs)
        .filter(j => j.search_results && Object.keys(j.search_results).length > 0)
        .sort((a, b) => (b.created || '').localeCompare(a.created || ''));

    if (!withResults.length) {
        scroll.innerHTML = `
            <div class="muted" style="padding: 24px; text-align: center;">
                Search results will appear here when a job starts.
            </div>`;
        return;
    }

    const results = withResults[0].search_results;

    const seeders = Object.entries(results)
        .map(([name, files]) => ({
            name,
            files: files.slice().sort((a, b) =>
                (a.path || '').localeCompare(b.path || '')
            ),
        }))
        .sort((a, b) => b.files.length - a.files.length);

    scroll.innerHTML = seeders.map(seeder => {
        const rows = seeder.files.map(f => {
            const filename = (f.path || '').split(/[\\/]/).pop() || f.path || '';
            const size = f.size ? f.size.toLocaleString() : '';
            const attrs = [
                f.bitrate ? `${f.bitrate}kbps` : '',
                f.length || '',
            ].filter(Boolean).join(', ');
            return `<tr>
                <td>${escapeHtml(filename)}</td>
                <td>${escapeHtml(size)}</td>
                <td>${escapeHtml(attrs)}</td>
            </tr>`;
        }).join('');

        return `
            <div class="browse-folder">
                <div class="folder-path">${escapeHtml(seeder.name)} (${seeder.files.length} files)</div>
                <table class="file-table">
                    <thead>
                        <tr><th>File</th><th>Size</th><th>Attributes</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }).join('');
}

// ──────────────────────────────────────────────────────────────
// Full log viewer
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// Settings
// ──────────────────────────────────────────────────────────────

async function loadSettings() {
    try {
        const r = await fetch('/api/config');
        const cfg = await r.json();
        document.getElementById('settingsUser').textContent =
            cfg.soulseek_username || '(not configured)';
        document.getElementById('settingsOutput').textContent =
            cfg.output_dir || '-';
    } catch (e) {
        // ignore
    }
}

async function refreshAccountChip() {
    const chip  = document.getElementById('accountChip');
    const label = document.getElementById('accountLabel');
    try {
        const r = await fetch('/api/config');
        const cfg = await r.json();
        if (cfg.soulseek_username) {
            chip.className = 'account-chip ok';
            label.textContent = cfg.soulseek_username;
        } else {
            chip.className = 'account-chip warn';
            label.textContent = 'not configured';
        }
    } catch (e) {
        chip.className = 'account-chip bad';
        label.textContent = 'offline';
    }
}

function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) loadSettings();
}

async function resetConfig() {
    if (!confirm('Reset credentials and return to setup?')) return;
    await fetch('/api/config/reset', { method: 'POST' });
    window.location.href = '/setup';
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ──────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const downloadBtn   = document.getElementById('downloadBtn');
    const resetBtn      = document.getElementById('resetBtn');
    const settingsBtn   = document.getElementById('settingsBtn');
    const clearLogsBtn  = document.getElementById('clearLogsBtn');
    const vkFetchBtn    = document.getElementById('vkFetchBtn');
    const albumOrLink   = document.getElementById('albumOrLink');
    const trackListArea = document.getElementById('trackList');

    function updateButtons() {
        const val = albumOrLink.value.trim();
        vkFetchBtn.disabled  = !val.startsWith('http');
        downloadBtn.disabled = !trackListArea.value.trim();
    }

    downloadBtn.addEventListener('click', startDownload);
    resetBtn.addEventListener('click', resetConfig);
    settingsBtn.addEventListener('click', toggleSettings);
    vkFetchBtn.addEventListener('click', fetchFromVK);
    clearLogsBtn.addEventListener('click', clearFinishedJobs);

    albumOrLink.addEventListener('input', updateButtons);
    trackListArea.addEventListener('input', updateButtons);

    document.getElementById('jobsList').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-joblog]');
        if (btn) openFullLog(btn.dataset.joblog);
    });

    updateButtons();
    refreshAccountChip();
    loadSettings();

    setInterval(refreshAccountChip, 15000);

    startPolling();
});