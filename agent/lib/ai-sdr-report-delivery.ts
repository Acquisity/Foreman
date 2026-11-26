import { renderAiSdrReportBlocks } from "./ai-sdr-report-blocks.js";
import type { AiSdrWeeklyReportResult } from "./ai-sdr-weekly-report.js";
import type { SlackChannelMessage } from "./slack-channel-post.js";

/** The only text the AI SDR channel gets when the report can't be built. */
export const aiSdrReportFailureLine = (error: string): string =>
  `The weekly AI SDR report could not be generated: ${error}`;

/** The dispatch instruction, carrying the report the schedule already posted. */
export const aiSdrReportPrompt = (
  report: Extract<AiSdrWeeklyReportResult, { success: true }>
): string =>
  `Weekly AI SDR performance report. The charts and tables are already posted above this thread. Load the ai-sdr-report skill and write only its three-line summary. Do not call any tool.\n\n${JSON.stringify(report)}`;

/**
 * Reads the report first, so a failed read posts the fixed line from code
 * and never starts a model turn. A complete report is posted from code as
 * charts and tables, and the model writes the summary in that post's thread.
 */
export const deliverAiSdrReport = async ({
  dispatch,
  post,
  read,
}: {
  dispatch: (prompt: string, threadTs: string) => Promise<unknown>;
  post: (message: SlackChannelMessage) => Promise<string>;
  read: () => Promise<AiSdrWeeklyReportResult>;
}): Promise<void> => {
  const report = await read();
  if (!report.success) {
    await post({ text: aiSdrReportFailureLine(report.error) });
    return;
  }
  const threadTs = await post(renderAiSdrReportBlocks(report));
  await dispatch(aiSdrReportPrompt(report), threadTs);
};
