import type { AiSdrWeeklyReportResult } from "./ai-sdr-weekly-report.js";

/** The only text the AI SDR channel gets when the report can't be built. */
export const aiSdrReportFailureLine = (error: string): string =>
  `The weekly AI SDR report could not be generated: ${error}`;

/** The dispatch instruction, carrying the report the schedule already read. */
export const aiSdrReportPrompt = (
  report: Extract<AiSdrWeeklyReportResult, { success: true }>
): string =>
  `Weekly AI SDR performance report. Load the ai-sdr-report skill and render this report in the approved Slack-table format. Do not call any tool.\n\n${JSON.stringify(report)}`;

/**
 * Reads the report first, so a failed read posts the fixed line from code
 * and never starts a model turn. Only a complete report reaches the model.
 */
export const deliverAiSdrReport = async ({
  dispatch,
  post,
  read,
}: {
  dispatch: (prompt: string) => Promise<unknown>;
  post: (text: string) => Promise<void>;
  read: () => Promise<AiSdrWeeklyReportResult>;
}): Promise<void> => {
  const report = await read();
  if (!report.success) {
    await post(aiSdrReportFailureLine(report.error));
    return;
  }
  await dispatch(aiSdrReportPrompt(report));
};
