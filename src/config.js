// Behaviour switches. Guided mode and selection confirmations are ON unless explicitly turned off.
//
//   STATS_EXPLORER_GUIDED=off               expose the individual test tools directly, without the
//                                           start_analysis → steps 1–6 workflow
//   STATS_EXPLORER_CONFIRM_SELECTIONS=off   run with the columns / chart types the AI picked,
//                                           without asking the user to confirm them first

const isOff = (v) => /^(0|off|false|no|disabled?)$/i.test(String(v ?? '').trim());

export function readConfig(env = process.env) {
  return {
    guided: !isOff(env.STATS_EXPLORER_GUIDED),
    confirmSelections: !isOff(env.STATS_EXPLORER_CONFIRM_SELECTIONS),
  };
}
