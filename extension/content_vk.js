// content_vk.js
// Injected on VK pages. Adds a "Download via Revseeker" button.
// If no playlist title is found, falls back to a floating button.

(function () {
    'use strict';

    const BUTTON_ID = 'revseeker-download-btn';

    function isPlaylistPage() {
        const href = window.location.href;
        if (/(?:music|audio)[/_]playlist[/]\d+_\d+/.test(href)) return true;
        if (/[?&]z=audio_playlist\d+_\d+/.test(href)) return true;
        return false;
    }

    function findPlaylistTitle() {
        const headings = Array.from(document.querySelectorAll('h1'));
        if (!headings.length) return null;

        for (const h of headings) {
            let el = h;
            for (let i = 0; i < 6 && el; i++) {
                const cls = (el.className || '').toString();
                if (/modal|Modal|overlay|Overlay|dialog/i.test(cls)) return h;
                if (el.getAttribute && el.getAttribute('role') === 'dialog') return h;
                el = el.parentElement;
            }
        }

        headings.sort((a, b) =>
            (b.textContent || '').length - (a.textContent || '').length
        );
        return headings[0] || null;
    }

    function styleButton(btn, floating) {
        if (floating) {
            btn.style.cssText = [
                'position: fixed',
                'bottom: 24px',
                'right: 24px',
                'z-index: 999999',
                'padding: 12px 20px',
                'background: #1c2c54',
                'color: #fff',
                'border: none',
                'border-radius: 8px',
                'font-size: 14px',
                'font-weight: 600',
                'cursor: pointer',
                'font-family: inherit',
                'box-shadow: 0 4px 12px rgba(0,0,0,0.3)',
            ].join(';');
        } else {
            btn.style.cssText = [
                'margin-left: 12px',
                'padding: 8px 16px',
                'background: #1c2c54',
                'color: #fff',
                'border: none',
                'border-radius: 6px',
                'font-size: 13px',
                'font-weight: 600',
                'cursor: pointer',
                'font-family: inherit',
                'vertical-align: middle',
            ].join(';');
        }
    }

    function onButtonClick() {
        const url = window.location.href;
        chrome.runtime.sendMessage(
            { action: 'launchWebApp', url: url },
            (response) => {
                if (chrome.runtime.lastError) {
                    const fallback =
                        'http://127.0.0.1:8000/?vk_url=' +
                        encodeURIComponent(url);
                    window.open(fallback, '_blank');
                    return;
                }
                if (response && response.error) {
                    console.warn('[Revseeker] launch error:', response.error);
                }
            }
        );
    }

    function makeButton(floating) {
        const btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.type = 'button';
        btn.textContent = 'Download via Revseeker';
        styleButton(btn, floating);
        btn.addEventListener('click', onButtonClick);
        return btn;
    }

    function injectButton() {
        if (!isPlaylistPage()) return;
        if (document.getElementById(BUTTON_ID)) return;

        const title = findPlaylistTitle();
        if (title && title.parentElement) {
            title.parentElement.appendChild(makeButton(false));
            return;
        }
        if (document.body) {
            document.body.appendChild(makeButton(true));
        }
    }

    let lastUrl = window.location.href;
    const observer = new MutationObserver(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            if (isPlaylistPage()) setTimeout(injectButton, 1200);
        } else if (isPlaylistPage()) {
            injectButton();
        }
    });

    function start() {
        observer.observe(document.body, { childList: true, subtree: true });
        if (isPlaylistPage()) setTimeout(injectButton, 1500);
    }

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
})();