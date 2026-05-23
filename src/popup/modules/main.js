import { ArticleManager } from './article_manager.js';
import { FileManager } from './file_manager.js';
import { UIManager } from './ui_manager.js';

// Cross-browser compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Global settings object from settings.js (loaded via script tag)
// We assume Settings is available on window/global scope

class PopupController {
    constructor() {
        this.ui = new UIManager();
        this.fileManager = new FileManager();
        this.articleManager = new ArticleManager();
        this.settings = { firmwareType: 'stock', deviceIp: '192.168.3.3', settingsPanelOpen: false };
        this.currentSort = 'newest'; // Default sort
    }

    async init() {
        console.log('[Popup Controller] Initializing...');
        await this.loadSettings();

        // Setup listeners
        this.ui.setupListeners({
            onSend: () => this.handleSend(),
            onDownload: () => this.handleDownload(),
            onDownloadXtc: () => this.handleDownloadXtc(),
            onSettingsChange: (e) => this.handleSettingsChange(e),
            onIpChange: (e) => this.handleIpChange(e),
            onConnect: () => this.handleConnect(),
            onSettingsToggle: () => this.handleSettingsToggle(),
            onSortChange: (e) => this.handleSortChange(e)
        });

        // Check for updates
        browserAPI.runtime.onMessage.addListener((message) => {
            if (message.type === 'X4_STATUS_UPDATE') {
                console.log('[Popup Controller] Status update:', message);
                // Map status to button state or log
                if (message.status === 'generating') {
                    this.ui.setSendButtonState('loading', 'Generating EPUB...');
                } else if (message.status === 'uploading') {
                    this.ui.setSendButtonState('loading', 'Uploading to X4...');
                } else if (message.status === 'downloading') {
                    this.ui.setSendButtonState('loading', 'Downloading...');
                }
            } else if (message.type === 'X4_DEBUG_LOG') {
                console.log('[SW Log]', message.message);
            }
        });

        // Run checks in parallel
        await Promise.all([
            this.checkArticle(),
            this.checkDevice()
        ]);
    }

    async loadSettings() {
        if (window.Settings) {
            try {
                const allSettings = await window.Settings.getAll();
                this.settings.firmwareType = allSettings.firmwareType;
                this.settings.deviceIp = allSettings.deviceIp;
                this.settings.settingsPanelOpen = allSettings.settingsPanelOpen;

                this.ui.updateSettingsUI(this.settings);
                this.ui.setSettingsPanelState(this.settings.settingsPanelOpen);

                console.log('[Popup Controller] Settings loaded:', this.settings);
            } catch (error) {
                console.error('[Popup Controller] Error loading settings:', error);
            }
        } else {
            console.error('[Popup Controller] Settings module not found!');
        }
    }

    // --- Actions ---

    async checkArticle() {
        try {
            const article = await this.articleManager.checkArticle();
            if (article) {
                this.ui.showArticleFound(article);
            } else {
                // Determine if it was an error or just not found?
                // ArticleManager returns null on "not found" (e.g. too short).
                this.ui.showArticleNotFound();
            }
        } catch (error) {
            console.error('[Popup Controller] Article check failed:', error);
            // If error is "No active tab", show error?
            this.ui.showArticleError(error.message);
        }
    }

    async checkDevice(force = false) {
        if (force) {
            this.ui.setConnectButtonState('loading');
        } else {
            // Initial check doesn't spin the connect button, maybe spins a general loading indicator?
            // Original code: this.elements.deviceLoading...
            // UIManager handles this in showDeviceConnected/Disconnected which hides loading.
            // But we need to SHOW loading first? UIManager doesn't have a specific showLoading method for device,
            // but the HTML starts with loading visible.
        }

        const result = await this.fileManager.checkDevice(this.settings);

        if (result.connected) {
            this.ui.showDeviceConnected(this.settings.deviceIp);

            // Load files
            const files = await this.fileManager.loadFolderFiles(this.settings);
            this.ui.showFileList(files, (filename, li) => this.handleDelete(filename, li));

            if (force) this.ui.setConnectButtonState('success');
            return true;
        } else {
            this.ui.showDeviceDisconnected();
            if (force) this.ui.setConnectButtonState('error');
            return false;
        }
    }

    // --- Handlers ---

    async handleSettingsChange(event) {
        // This is now Firmware Type Change
        const newFirmwareType = event.target.value;
        this.settings.firmwareType = newFirmwareType;

        if (window.Settings) {
            await window.Settings.setFirmwareType(newFirmwareType);

            // Reload settings to get the stored IP for this firmware type
            const updatedSettings = await window.Settings.getAll();
            this.settings.deviceIp = updatedSettings.deviceIp;

            // Re-update UI to reflect the correct IP
            this.ui.updateSettingsUI(this.settings);
        }

        // Refresh device
        await this.checkDevice();
    }

    async handleIpChange(event) {
        const newIp = event.target.value.trim();
        if (!newIp) return;

        this.settings.deviceIp = newIp;

        if (window.Settings) {
            await window.Settings.setDeviceIp(newIp);
        }
        console.log('[Popup Controller] IP saved:', newIp);
    }

    async handleConnect() {
        // Force save current input value first
        const currentInput = this.ui.getSettingsFromUI().deviceIp;
        if (currentInput && currentInput !== this.settings.deviceIp) {
            await this.handleIpChange({ target: { value: currentInput } });
        }

        await this.checkDevice(true);
    }

    async handleSortChange(event) {
        this.currentSort = event.target.value;
        // Reload files to apply sort
        const files = await this.fileManager.loadFolderFiles(this.settings, this.currentSort);
        this.ui.showFileList(files, (filename, li) => this.handleDelete(filename, li));
    }

    async handleSettingsToggle() {
        this.settings.settingsPanelOpen = !this.settings.settingsPanelOpen;
        this.ui.setSettingsPanelState(this.settings.settingsPanelOpen);

        if (window.Settings) {
            await window.Settings.setSettingsPanelOpen(this.settings.settingsPanelOpen);
        }
    }

    async handleDelete(filename, liElement) {
        if (!confirm(`Delete "${filename}" from X4?`)) return;

        liElement.classList.add('deleting'); // UI optimistically? UIManager should handle this ideally but we passed liElement
        // Actually UIManager doesn't expose class manipulation for list items easily.
        // We can access properties on liElement directly since it's a DOM node passed back.

        try {
            await this.fileManager.deleteFile(filename, this.settings);
            // On success, remove from UI
            liElement.remove();

            // Update count? UIManager needs to know.
            // Reload files to be safe and update count
            const files = await this.fileManager.loadFolderFiles(this.settings);
            this.ui.showFileList(files, (f, l) => this.handleDelete(f, l));

        } catch (error) {
            console.error('[Popup Controller] Delete error:', error);
            alert(`Failed to delete file: ${error.message}`);
            liElement.classList.remove('deleting');
        }
    }

    async handleSend() {
        const article = this.articleManager.articleData;
        if (!article) return;

        const format = this.ui.getSelectedFormat();

        this.ui.setSendButtonState('sending');

        try {
            let response;

            if (format === 'xtc') {
                // Build XTC in popup via sandbox iframe, then upload directly
                // (ArrayBuffer cannot survive chrome.runtime.sendMessage serialization)
                this.ui.setSendButtonState('sending', 'Rendering...');
                const xtcBuffer = await XtcBuilder.build(article);
                const filename  = XtcBuilder.generateFilename(article);
                this.ui.setSendButtonState('sending', 'Uploading...');

                const isCrosspoint = this.settings.firmwareType === 'crosspoint';
                const deviceIp     = this.settings.deviceIp;
                const uploader     = isCrosspoint ? CrossPointUpload : X4UploadTab;
                if (isCrosspoint) {
                    CrossPointUpload.setIp(deviceIp);
                } else if (typeof X4UploadTab.setIp === 'function') {
                    X4UploadTab.setIp(deviceIp);
                }

                const uploadTimeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Upload timed out (30s)')), 30000));
                const uploadResult = await Promise.race([
                    uploader.uploadEpub(xtcBuffer, filename),
                    uploadTimeout
                ]);

                if (uploadResult && uploadResult.success) {
                    response = { success: true, message: 'Sent to X4!' };
                } else {
                    response = { success: false, error: uploadResult?.error || 'Upload failed' };
                }

            } else {
                // EPUB path — service worker builds EPUB and uploads
                const sendPromise = browserAPI.runtime.sendMessage({
                    type: 'X4_SEND_ARTICLE',
                    payload: { kind: 'generic_article', ...article },
                    settings: {
                        firmwareType: this.settings.firmwareType,
                        deviceIp: this.settings.deviceIp
                    }
                });

                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Operation timed out (60s)')), 60000));
                response = await Promise.race([sendPromise, timeout]);
            }

            if (response && response.success) {
                this.ui.setSendButtonState('success', response.message);
                setTimeout(async () => {
                    const files = await this.fileManager.loadFolderFiles(this.settings);
                    this.ui.showFileList(files, (f, l) => this.handleDelete(f, l));
                }, 1500);
            } else {
                this.ui.setSendButtonState('error', response?.error || 'Unknown error');
            }
        } catch (error) {
            console.error('[Popup Controller] Send error:', error);
            this.ui.setSendButtonState('error', error.message);
        }
    }

    async handleDownload() {
        const article = this.articleManager.articleData;
        if (!article) return;

        this.ui.setDownloadButtonState('downloading');

        try {
            const response = await browserAPI.runtime.sendMessage({
                type: 'X4_DOWNLOAD_ARTICLE',
                payload: {
                    kind: 'generic_article',
                    ...article
                }
            });

            if (response && response.success) {
                this.ui.setDownloadButtonState('success');
            } else {
                this.ui.setDownloadButtonState('error', response?.error || 'Unknown error');
            }
        } catch (error) {
            console.error('[Popup Controller] Download error:', error);
            this.ui.setDownloadButtonState('error', error.message);
        }
    }

    async handleDownloadXtc() {
        const article = this.articleManager.articleData;
        if (!article) return;

        this.ui.setDownloadXtcButtonState('loading', 'Loading...');

        try {
            // Phase 1: fetch WASM + font (cached after first call)
            // Phase 2: CREngine renders EPUB → pages (30–90 s on first call)
            // Phase 3: dither + encode XTG/XTC
            this.ui.setDownloadXtcButtonState('converting', 'Rendering...');
            const xtcBuffer = await XtcBuilder.build(article);
            const filename  = XtcBuilder.generateFilename(article);

            // Trigger browser download via blob URL
            const blob = new Blob([xtcBuffer], { type: 'application/octet-stream' });
            const url  = URL.createObjectURL(blob);
            await browserAPI.downloads.download({ url, filename, saveAs: false });
            URL.revokeObjectURL(url);

            this.ui.setDownloadXtcButtonState('success');
        } catch (error) {
            console.error('[Popup Controller] XTC download error:', error);
            this.ui.setDownloadXtcButtonState('error', error.message);
        }
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const controller = new PopupController();
    controller.init();
});
