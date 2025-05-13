import * as vscode from 'vscode';
import { ProgressBarSettings } from '../interfaces/types';

// Emojis for progress bar representation
const PROGRESS_EMPTY = '⬜';
const PROGRESS_FILLED = '🟩';
const PROGRESS_WARNING = '🟨';
const PROGRESS_CRITICAL = '🟥';

/**
 * Generate a progress bar using emoji characters
 * @param percentage The current percentage (0-100)
 * @param length The number of characters in the progress bar
 * @param warningThreshold Threshold percentage for warning color
 * @param criticalThreshold Threshold percentage for critical color
 * @returns A string representing the progress bar
 */
export function createProgressBar(
    percentage: number, 
    length: number = 10, 
    warningThreshold: number = 75, 
    criticalThreshold: number = 90
): string {
    // Ensure percentage is within 0-100 range
    const clampedPercentage = Math.max(0, Math.min(100, percentage));
    
    // Calculate filled positions
    const filledCount = Math.round((clampedPercentage / 100) * length);
    const emptyCount = length - filledCount;
    
    let bar = '';
    
    // Choose emoji color based on thresholds
    let filledEmoji = PROGRESS_FILLED;
    if (clampedPercentage >= criticalThreshold) {
        filledEmoji = PROGRESS_CRITICAL;
    } else if (clampedPercentage >= warningThreshold) {
        filledEmoji = PROGRESS_WARNING;
    }
    
    // Build the progress bar
    bar = filledEmoji.repeat(filledCount) + PROGRESS_EMPTY.repeat(emptyCount);
    
    return bar;
}

/**
 * Determine if progress bars should be displayed based on user settings
 * @returns Whether progress bars should be shown
 */
export function shouldShowProgressBars(): boolean {
    const config = vscode.workspace.getConfiguration('cursorShare');
    return config.get<boolean>('showProgressBars', false);
}

/**
 * Get progress bar settings from user configuration
 * @returns Progress bar settings object
 */
export function getProgressBarSettings(): ProgressBarSettings {
    const config = vscode.workspace.getConfiguration('cursorShare');
    
    return {
        barLength: config.get<number>('progressBarLength', 10),
        warningThreshold: config.get<number>('progressBarWarningThreshold', 75),
        criticalThreshold: config.get<number>('progressBarCriticalThreshold', 90)
    };
}

/**
 * Create a period progress bar showing days passed in a billing period
 * @param startDate Start date string of the period
 * @param endDate End date string of the period (optional)
 * @param label Label for the progress bar
 * @returns Formatted progress bar with label and percentage
 */
export function createPeriodProgressBar(startDate: string, endDate?: string, label: string = 'Period'): string {
    if (!shouldShowProgressBars()) {
        return '';
    }
    
    const settings = getProgressBarSettings();
    
    try {
        // Handle date formats like "17 April - 17 May" or "3 April - 2 May"
        let start: Date;
        let end: Date;
        
        if (startDate.includes('-')) {
            // Parse date range in format like "17 April - 17 May"
            const [startStr, endStr] = startDate.split('-').map(s => s.trim());
            
            // Get current year
            const currentYear = new Date().getFullYear();
            
            // Parse start date
            const startParts = startStr.split(' ');
            const startDay = parseInt(startParts[0]);
            const startMonth = getMonthNumber(startParts[1]);
            
            // Parse end date
            const endParts = endStr.split(' ');
            const endDay = parseInt(endParts[0]);
            const endMonth = getMonthNumber(endParts[1]);
            
            // Create Date objects with current year
            start = new Date(currentYear, startMonth, startDay);
            end = new Date(currentYear, endMonth, endDay);
            
            // If end date is before start date, it means the period crosses into next year
            if (end < start) {
                end.setFullYear(currentYear + 1);
            }
        } else {
            // Regular date parsing for ISO format dates
            start = new Date(startDate);
            end = endDate ? new Date(endDate) : getEndOfPeriod(start);
        }
        
        const now = new Date();
        
        // Calculate total days in the period
        const totalDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        
        // Calculate days elapsed
        const elapsedDays = Math.round((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        
        // Calculate percentage elapsed
        const percentage = Math.min(100, Math.max(0, (elapsedDays / totalDays) * 100));
        
        // Create the progress bar
        const progressBar = createProgressBar(
            percentage, 
            settings.barLength, 
            settings.warningThreshold, 
            settings.criticalThreshold
        );
        
        // Return with label but without percentage
        return `${label}: ${progressBar}`;
    } catch (error) {
        // If date parsing fails, log error and return empty string
        console.error(`Error creating period progress bar: ${error}`);
        return `${label}: Error parsing dates`;
    }
}

/**
 * Convert month name to month number (0-11)
 * @param monthName Month name (e.g., "January", "Jan")
 * @returns Month number (0-11)
 */
function getMonthNumber(monthName: string): number {
    const months: {[key: string]: number} = {
        'january': 0, 'jan': 0,
        'february': 1, 'feb': 1,
        'march': 2, 'mar': 2,
        'april': 3, 'apr': 3,
        'may': 4,
        'june': 5, 'jun': 5,
        'july': 6, 'jul': 6,
        'august': 7, 'aug': 7,
        'september': 8, 'sep': 8, 'sept': 8,
        'october': 9, 'oct': 9,
        'november': 10, 'nov': 10,
        'december': 11, 'dec': 11
    };
    
    return months[monthName.toLowerCase()] || 0;
}

/**
 * Create a usage progress bar showing amount consumed against a limit
 * @param current Current usage amount
 * @param limit Maximum limit
 * @param label Label for the progress bar
 * @returns Formatted progress bar with label and percentage
 */
export function createUsageProgressBar(current: number, limit: number, label: string = 'Usage'): string {
    if (!shouldShowProgressBars()) {
        return '';
    }
    
    const settings = getProgressBarSettings();
    
    // Calculate percentage
    const percentage = Math.min(100, Math.max(0, (current / limit) * 100));
    
    // Create the progress bar
    const progressBar = createProgressBar(
        percentage, 
        settings.barLength, 
        settings.warningThreshold, 
        settings.criticalThreshold
    );
    
    // Return with label but without percentage
    return `${label}: ${progressBar}`;
}

/**
 * Get the end date of a billing period based on the start date
 * @param startDate The start date of the period
 * @returns The end date of the period
 */
function getEndOfPeriod(startDate: Date): Date {
    const endDate = new Date(startDate);
    
    // Add one month to the start date
    endDate.setMonth(endDate.getMonth() + 1);
    
    // Subtract one day to get the end of the period
    endDate.setDate(endDate.getDate() - 1);
    
    return endDate;
}

export function getProgressBarLength(): number {
    const config = vscode.workspace.getConfiguration('cursorShare');
    return Math.max(Math.min(config.get<number>('progressBarLength', 10), 20), 5);
} 