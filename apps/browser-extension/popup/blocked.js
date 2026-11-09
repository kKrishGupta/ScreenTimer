function sanitizeHttpUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // Ignore invalid URLs.
  }
  return null;
}

function getBlockedParams(search = globalThis.location?.search || '') {
  const params = new URLSearchParams(search);
  const targetUrl = sanitizeHttpUrl(params.get('url'));
  let domain = (params.get('domain') || '').trim();
  if (!domain && targetUrl) {
    try {
      domain = new URL(targetUrl).hostname;
    } catch {
      domain = '';
    }
  }
  const policy = (params.get('policy') || '').trim() || 'Organization website blocking policy';
  return {
    targetUrl,
    domain: domain || 'Restricted website',
    policy,
  };
}

function setStatus(message) {
  const statusEl = document.getElementById('status-message');
  if (!statusEl) return;
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
}

async function checkAndRestoreIfUnblocked(targetUrl, { syncFirst = false } = {}) {
  if (!targetUrl || !globalThis.chrome?.runtime?.sendMessage) return false;
  if (syncFirst) {
    try {
      await globalThis.chrome.runtime.sendMessage({ action: 'sync_now' });
    } catch {
      // Continue with local rule evaluation even if sync request fails.
    }
  }
  try {
    const response = await globalThis.chrome.runtime.sendMessage({
      action: 'check_url_blocked',
      url: targetUrl,
    });
    if (response && response.blocked === false) {
      globalThis.location.replace(targetUrl);
      return true;
    }
  } catch {
    // Keep the blocked page visible when the worker is unavailable.
  }
  return false;
}

export function initBlockedPage() {
  if (typeof document === 'undefined') return;
  const { targetUrl, domain, policy } = getBlockedParams();

  const domainBannerEl = document.getElementById('blocked-domain');
  const metaDomainEl = document.getElementById('meta-domain');
  const metaPolicyEl = document.getElementById('meta-policy');
  const metaUrlEl = document.getElementById('meta-url');
  const retryBtn = document.getElementById('retry-btn');

  if (domainBannerEl) domainBannerEl.textContent = domain;
  if (metaDomainEl) metaDomainEl.textContent = domain;
  if (metaPolicyEl) metaPolicyEl.textContent = policy;
  if (metaUrlEl) metaUrlEl.textContent = targetUrl || domain;

  if (targetUrl && globalThis.chrome?.runtime?.sendMessage) {
    void globalThis.chrome.runtime
      .sendMessage({ action: 'record_blocked_navigation', url: targetUrl })
      .catch(() => {});
  }

  if (retryBtn) {
    if (!targetUrl) {
      retryBtn.disabled = true;
    } else {
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        setStatus('Checking latest organization policy...');
        const restored = await checkAndRestoreIfUnblocked(targetUrl, { syncFirst: true });
        if (!restored) {
          setStatus(`Access to ${domain} is still restricted by organization policy.`);
          retryBtn.disabled = false;
        }
      });
    }
  }

  if (targetUrl && globalThis.chrome?.storage?.onChanged) {
    globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.dp_policy_sync) {
        void checkAndRestoreIfUnblocked(targetUrl, { syncFirst: false });
      }
    });
  }
}

initBlockedPage();

