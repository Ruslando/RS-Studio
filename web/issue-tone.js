// Old saved/server results used DLC Builder's importance flag. New results carry tone.
export const issueTone = (issue) => issue.tone || (issue.important ? "error" : "warning");
export const toneRank = { note: 0, warning: 1, error: 2 };
