// Synced from the Stats Explorer app (src/lib) by scripts/sync-engine.mjs. Do not edit here;
// change the app and re-run the sync so both stay identical.
// Shared helpers for the hypothesis testing tools.

/**
 * Derives a display label for each ANOVA group line:
 * 1. the "Label:" prefix on the data line (how dataset columns are auto-filled),
 * 2. the matching entry from the optional comma-separated Group Labels field,
 * 3. fallback "Group 1", "Group 2", ...
 */
export function getAnovaGroupLabels(variables) {
    const lines = (variables.groupsData || '').split('\n').filter(l => l.trim());
    const custom = (variables.groupLabels || '').split(',').map(l => l.trim()).filter(Boolean);
    return lines.map((line, i) => {
        const prefix = line.match(/^\s*([^:]+):\s/);
        return (prefix && prefix[1].trim()) || custom[i] || `Group ${i + 1}`;
    });
}