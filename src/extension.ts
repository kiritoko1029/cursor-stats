import * as vscode from 'vscode';
import { checkForUpdates } from './services/github';
import { createStatusBarItem } from './handlers/statusBar';
import { initializeLogging, log } from './utils/logger';
import { getCursorTokenFromDB, getRawCursorTokenFromDB } from './services/database';
import { checkUsageBasedStatus, getCurrentUsageLimit, setUsageLimit } from './services/api';
import { resetNotifications } from './handlers/notifications';
import { 
    startRefreshInterval, 
    setStatusBarItem, 
    setIsWindowFocused,
    clearAllIntervals,
    getCooldownStartTime,
    startCountdownDisplay
} from './utils/cooldown';
import { updateStats } from './utils/updateStats';
import { SUPPORTED_CURRENCIES } from './utils/currency';
import { convertAndFormatCurrency } from './utils/currency';
import { createReportCommand} from './utils/report';

let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let outputChannel: vscode.OutputChannel | undefined;
let lastReleaseCheck: number = 0;
const RELEASE_CHECK_INTERVAL = 1000 * 60 * 60; // Check every hour

export function getRefreshIntervalMs(): number {
    const config = vscode.workspace.getConfiguration('cursorShare');
    const intervalSeconds = Math.max(config.get('refreshInterval', 30), 5); // Minimum 5 seconds
    return intervalSeconds * 1000;
}

// Add this new function
export function getExtensionContext(): vscode.ExtensionContext {
    if (!extensionContext) {
        throw new Error('Extension context not initialized');
    }
    return extensionContext;
}

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext) {
    try {
        // Initialize logging first
        initializeLogging(context);
        
        log('[Initialization] Extension activation started');
        extensionContext = context;

        // Get package.json for current version
        const packageJson = require('../package.json');
        const currentVersion = packageJson.version;
        
        // Check if we need to show changelog after update
        const lastInstalledVersion = context.globalState.get('lastInstalledVersion');
        log(`[Initialization] Current version: ${currentVersion}, Last installed: ${lastInstalledVersion || 'not set'}`);
        
        if (lastInstalledVersion && lastInstalledVersion !== currentVersion) {
            // Show changelog for the current version (we've updated)
            log(`[Update] Extension updated from ${lastInstalledVersion} to ${currentVersion}, showing changelog`);
            setTimeout(() => {
                checkForUpdates(0, 0, currentVersion);
            }, 3000); // Slight delay to let extension finish activating
        }
        
        // Update the stored version
        context.globalState.update('lastInstalledVersion', currentVersion);

        // Reset notifications on activation
        resetNotifications();

        // Create status bar item with enhanced logging
        statusBarItem = createStatusBarItem();
        setStatusBarItem(statusBarItem);

        // Add window focus event listeners
        const focusListener = vscode.window.onDidChangeWindowState(e => {
            const focused = e.focused;
            setIsWindowFocused(focused);
            log(`[Window] Window focus changed: ${focused ? 'focused' : 'unfocused'}`);
            
            if (focused) {
                // Check if we're in cooldown
                if (getCooldownStartTime()) {
                    log('[Window] Window focused during cooldown, restarting countdown display');
                    startCountdownDisplay();
                } else {
                    // Only update stats and restart refresh if not in cooldown
                    updateStats(statusBarItem);
                    startRefreshInterval();
                }
            } else {
                clearAllIntervals();
            }
        });

        // Check initial usage-based status
        const token = await getCursorTokenFromDB();
        if (token) {
            log('[Initialization] Checking usage-based pricing status...');
            const status = await checkUsageBasedStatus(token);
            log(`[Initialization] Usage-based pricing is ${status.isEnabled ? 'enabled' : 'disabled'}${status.limit ? ` with limit $${status.limit}` : ''}`);
        }
        
        // Register commands
        log('[Initialization] Registering commands...');
        const refreshCommand = vscode.commands.registerCommand('cursor-share.refreshStats', async () => {
            log('[Command] Manually refreshing stats...');
            await updateStats(statusBarItem);
        });
        
        // Add command to copy token
        const copyTokenCommand = vscode.commands.registerCommand('cursor-share.copyToken', async () => {
            log('[Command] Copying raw accessToken to clipboard...');
            const token = await getRawCursorTokenFromDB();
            if (token) {
                await vscode.env.clipboard.writeText(token);
                vscode.window.showInformationMessage('原始 Access Token 已复制到剪贴板');
            } else {
                vscode.window.showErrorMessage('无法获取 Access Token');
            }
        });
        
        const openCursorSettings = vscode.commands.registerCommand('cursor-share.openSettings', async () => {
            log('[Command] Opening extension settings...');
            // Use a more reliable way to open settings
            const settingsUri = vscode.Uri.parse('vscode://ms-vscode.cursor-share/settings');
            try {
                // Try to open settings directly first
                await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Dwtexe.cursor-share');
            } catch (error) {
                log('[Command] Failed to open settings directly, trying alternative method...', true);
                try {
                    // Fallback to opening settings view
                    await vscode.commands.executeCommand('workbench.action.openSettings');
                    // Then search for our extension
                    await vscode.commands.executeCommand('workbench.action.search.toggleQueryDetails');
                    await vscode.commands.executeCommand('workbench.action.search.action.replaceAll', '@ext:Dwtexe.cursor-share');
                } catch (fallbackError) {
                    log('[Command] Failed to open settings with fallback method', true);
                    // Show error message to user
                    vscode.window.showErrorMessage('Failed to open Cursor Share settings. Please try opening VS Code settings manually.');
                }
            }
        });

        // Add configuration change listener
        const configListener = vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('cursorShare.enableStatusBarColors')) {
                log('[Settings] Status bar colors setting changed, updating display...');
                await updateStats(statusBarItem);
            }
            if (e.affectsConfiguration('cursorShare.refreshInterval')) {
                log('[Settings] Refresh interval changed, restarting timer...');
                startRefreshInterval();
            }
            if (e.affectsConfiguration('cursorShare.showTotalRequests')) {
                log('[Settings] Show total requests setting changed, updating display...');
                await updateStats(statusBarItem);
            }
            if (e.affectsConfiguration('cursorShare.currency')) {
                log('[Settings] Currency setting changed, updating display...');
                await updateStats(statusBarItem);
            }
        });
        

        const setLimitCommand = vscode.commands.registerCommand('cursor-share.setLimit', async () => {
            const token = await getCursorTokenFromDB();
            if (!token) {
                vscode.window.showErrorMessage('Please sign in to Cursor first');
                return;
            }

            try {
                const currentLimit = await getCurrentUsageLimit(token);
                const isEnabled = !currentLimit.noUsageBasedAllowed;
               
                const quickPick = await vscode.window.showQuickPick([
                    {
                        label: '$(check) Enable Usage-Based Pricing',
                        description: 'Turn on usage-based pricing and set a limit',
                        value: 'enable'
                    },
                    {
                        label: '$(pencil) Set Monthly Limit',
                        description: 'Change your monthly spending limit',
                        value: 'set'
                    },
                    {
                        label: '$(x) Disable Usage-Based Pricing',
                        description: 'Turn off usage-based pricing',
                        value: 'disable'
                    }
                ], {
                    placeHolder: `Current status: ${isEnabled ? 'Enabled' : 'Disabled'} ${isEnabled ? `(Limit: $${currentLimit.hardLimit})` : ''}`
                });

                if (!quickPick) {
                    return;
                }

                switch (quickPick.value) {
                    case 'enable':
                        if (!isEnabled) {
                            const limit = await vscode.window.showInputBox({
                                prompt: 'Enter monthly spending limit in dollars',
                                placeHolder: '50',
                                validateInput: (value) => {
                                    const num = Number(value);
                                    return (!isNaN(num) && num > 0) ? null : 'Please enter a valid number greater than 0';
                                }
                            });
                            if (limit) {
                                await setUsageLimit(token, Number(limit), false);
                                const formattedLimit = await convertAndFormatCurrency(Number(limit));
                                vscode.window.showInformationMessage(`Usage-based pricing enabled with ${formattedLimit} limit`);
                                await updateStats(statusBarItem);
                            }
                        } else {
                            vscode.window.showInformationMessage('Usage-based pricing is already enabled');
                        }
                        break;

                    case 'set':
                        if (isEnabled) {
                            const newLimit = await vscode.window.showInputBox({
                                prompt: 'Enter new monthly spending limit in dollars',
                                placeHolder: String(currentLimit.hardLimit),
                                validateInput: (value) => {
                                    const num = Number(value);
                                    return (!isNaN(num) && num > 0) ? null : 'Please enter a valid number greater than 0';
                                }
                            });
                            if (newLimit) {
                                await setUsageLimit(token, Number(newLimit), false);
                                const formattedLimit = await convertAndFormatCurrency(Number(newLimit));
                                vscode.window.showInformationMessage(`Monthly limit updated to ${formattedLimit}`);
                                await updateStats(statusBarItem);
                            }
                        } else {
                            vscode.window.showWarningMessage('Please enable usage-based pricing first');
                        }
                        break;

                    case 'disable':
                        if (isEnabled) {
                            await setUsageLimit(token, 0, true);
                            vscode.window.showInformationMessage('Usage-based pricing disabled');
                            await updateStats(statusBarItem);
                        } else {
                            vscode.window.showInformationMessage('Usage-based pricing is already disabled');
                        }
                        break;
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to manage usage limit: ${error.message}`);
            }
        });
        
        // Add command to status bar item
        statusBarItem.command = 'cursor-share.openSettings';
        log('[Status Bar] Command assigned to status bar item');
        
        // Register package.json configuration contribution
        context.subscriptions.push(
            vscode.commands.registerCommand('cursor-share.selectCurrency', async () => {
                const currencyPicks = SUPPORTED_CURRENCIES.map(currency => ({
                    label: `${currency.code} (${currency.name})`,
                    description: currency.code === 'USD' ? 'Default' : '',
                    code: currency.code
                }));
                
                const selected = await vscode.window.showQuickPick(currencyPicks, {
                    placeHolder: 'Select currency for display',
                });
                
                if (selected) {
                    const config = vscode.workspace.getConfiguration('cursorShare');
                    await config.update('currency', selected.code, vscode.ConfigurationTarget.Global);
                    log(`[Settings] Currency changed to ${selected.code}`);
                    await updateStats(statusBarItem);
                }
            })
        );
        
        
        // Add to subscriptions
        context.subscriptions.push(
            statusBarItem, 
            openCursorSettings, 
            refreshCommand,
            copyTokenCommand,
            setLimitCommand,
            createReportCommand,
            configListener,
            focusListener  // Add focus listener to subscriptions
        );
        log('[Initialization] Subscriptions registered');
        
        // Show status bar item explicitly
        log('[Status Bar] Showing status bar item...');
        statusBarItem.show();
        log('[Status Bar] Initial visibility state set');

        // Start refresh interval
        startRefreshInterval();

        // Initial update and update check
        setTimeout(async () => {
            await updateStats(statusBarItem);
            // Check for updates after initial stats are loaded
            await checkForUpdates(lastReleaseCheck, RELEASE_CHECK_INTERVAL);
        }, 1500);

        // Register configuration for the progress bars
        const config = vscode.workspace.getConfiguration('cursorShare');
        
        // Default settings for progress bars (disabled by default)
        if (config.get('showProgressBars') === undefined) {
            config.update('showProgressBars', false, vscode.ConfigurationTarget.Global);
        }
        
        if (config.get('progressBarLength') === undefined) {
            config.update('progressBarLength', 10, vscode.ConfigurationTarget.Global);
        }
        
        if (config.get('progressBarWarningThreshold') === undefined) {
            config.update('progressBarWarningThreshold', 75, vscode.ConfigurationTarget.Global);
        }
        
        if (config.get('progressBarCriticalThreshold') === undefined) {
            config.update('progressBarCriticalThreshold', 90, vscode.ConfigurationTarget.Global);
        }

        log('[Initialization] Extension activation completed successfully');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        log(`[Critical] Failed to activate extension: ${errorMessage}`, true);
        if (error instanceof Error && error.stack) {
            log(`[Critical] Stack trace: ${error.stack}`, true);
        }
        throw error;
    }
}

export function deactivate() {
    log('[Deactivation] Extension deactivation started');
    try {
        clearAllIntervals();
        log('[Deactivation] All intervals cleared');
        
        if (outputChannel) {
            outputChannel.dispose();
            log('[Deactivation] Output channel disposed');
        }
        
        log('[Deactivation] Extension deactivation completed successfully');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        log(`[Critical] Failed to deactivate extension cleanly: ${errorMessage}`, true);
        if (error instanceof Error && error.stack) {
            log(`[Critical] Stack trace: ${error.stack}`, true);
        }
        throw error;
    }
}
