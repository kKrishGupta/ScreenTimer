import { extractDomain } from '../shared/constants.js';

export async function reconcileActiveTab(chromeApi, activityManager, tabManager, idleThreshold) {
  if (!activityManager.monitoringAllowed) return null;
  const window = await chromeApi.windows.getLastFocused();
  const idle = await chromeApi.idle.queryState(idleThreshold);
  if (!window?.focused || idle !== 'active') {
    await tabManager.handleWindowFocusChanged(false);
    await activityManager.switchDomain(null);
    return null;
  }
  const [tab] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
  await tabManager.handleWindowFocusChanged(true, tab?.url);
  // Restore after a policy pause even if the selected domain has not changed.
  await activityManager.switchDomain(tabManager.currentDomain);
  return tab?.url || null;
}

/**
 * TabManager monitors tab activation, URL updates, and window focus.
 */
export class TabManager {
  /**
   * @param {object} callbacks
   * @param {(domain: string | null) => void} callbacks.onActiveDomainChanged
   */
  constructor({ onActiveDomainChanged }) {
    this.onActiveDomainChanged = onActiveDomainChanged;
    this.currentDomain = null;
    this.isWindowFocused = true;
  }

  handleTabActivated(tab) {
    if (!tab) {
      return this._updateDomain(null);
    }
    const domain = this.isWindowFocused ? extractDomain(tab.url) : null;
    return this._updateDomain(domain);
  }

  handleUrlChanged(url) {
    if (!this.isWindowFocused) return;
    const domain = extractDomain(url);
    return this._updateDomain(domain);
  }

  handleWindowFocusChanged(isFocused, activeTabUrl = null) {
    this.isWindowFocused = isFocused;
    if (!isFocused) {
      return this._updateDomain(null);
    } else {
      const domain = extractDomain(activeTabUrl);
      return this._updateDomain(domain);
    }
  }

  _updateDomain(newDomain) {
    if (this.currentDomain !== newDomain) {
      this.currentDomain = newDomain;
      return this.onActiveDomainChanged(newDomain);
    }
  }
}

