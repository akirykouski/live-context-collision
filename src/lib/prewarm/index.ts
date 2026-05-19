// Pre-Warmer public surface.

export * from "./types";
export {
  RANKER_WEIGHTS,
  SOURCE_PRIOR,
  DEFAULT_TOP_N,
  rankCandidates,
  recencyDecay,
  bowCosine,
} from "./ranker";
export {
  hotLoad,
  computeTtlSec,
  toMemoryFact,
  toVocab,
} from "./hot-loader";
export {
  runScheduler,
  prewarmMeeting,
  prewarmMeetingById,
  loadMeetings,
  isEligible,
  resetCircuitBreakers,
  DEFAULT_SOURCES,
} from "./scheduler";
export { calendarSource, calendarCandidates } from "./sources/calendar";
export { graphSource, graphCandidates } from "./sources/graph";
export { githubSource, makeGitHubSource } from "./sources/github";
export { jiraSource, makeJiraSource } from "./sources/jira";
export { notionSource, makeNotionSource } from "./sources/notion";
export { slackSource, makeSlackSource, slackEnabled } from "./sources/slack";
