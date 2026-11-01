import { extractDomain } from '../shared/constants.js';

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
      this._updateDomain(null);
      return;
    }
    const domain = this.isWindowFocused ? extractDomain(tab.url) : null;
    this._updateDomain(domain);
  }

  handleUrlChanged(url) {
    if (!this.isWindowFocused) return;
    const domain = extractDomain(url);
    this._updateDomain(domain);
  }

  handleWindowFocusChanged(isFocused, activeTabUrl = null) {
    this.isWindowFocused = isFocused;
    if (!isFocused) {
      this._updateDomain(null);
    } else {
      const domain = extractDomain(activeTabUrl);
      this._updateDomain(domain);
    }
  }

  _updateDomain(newDomain) {
    if (this.currentDomain !== newDomain) {
      this.currentDomain = newDomain;
      this.onActiveDomainChanged(newDomain);
    }
  }
}

