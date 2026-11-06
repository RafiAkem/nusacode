/**
 * The `ask` tool: lets the model stop and ask you a question with a few options,
 * instead of guessing or burying the question in prose.
 *
 * Subagents run without extensions, so only the main conversation can ask.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { answersText, AskPanel, normalizeQuestions, type AskResult } from "../lib/ask-panel.ts";
import { messages } from "../lib/i18n.ts";

// Only the label people see on the tool call. Everything the model reads below stays English.
const t = messages({ label: "Ask" }, { label: "Tanya" });

const text = (value: string) => [{ type: "text" as const, text: value }];

export default function ask(pi: ExtensionAPI) {
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  pi.registerTool({
    name: "ask",
    label: t("label"),
    description:
      "Ask the user one to four multiple-choice questions and wait for the answers. Use it when the request is " +
      "ambiguous, when you must pick between real alternatives, or before a risky or hard-to-undo step. " +
      "The user can always type their own answer instead of choosing an option.",
    promptSnippet: "Ask the user a multiple-choice question and wait for the answer",
    promptGuidelines: [
      "Use ask instead of guessing when the request is ambiguous or a choice would be hard to undo. Do not ask for things you can find out by reading the code.",
      "Give each question 2 to 4 concrete options. Put the one you recommend first and end its label with (Recommended).",
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: "The complete question, ending with a question mark." }),
          header: Type.Optional(Type.String({ description: "A very short label for the question, one or two words." })),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: "The choice, in one to five words." }),
              description: Type.Optional(Type.String({ description: "What picking it means or implies." })),
            }),
            { description: "Two to four distinct choices. Do not add an Other option; it is always offered." },
          ),
          multiSelect: Type.Optional(Type.Boolean({ description: "Allow picking several options. Default false." })),
        }),
        { description: "One to four questions." },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params.questions);
      if (typeof questions === "string") return { content: text(questions), details: {}, isError: true };
      if (!ctx.hasUI || ctx.mode !== "tui") {
        return {
          content: text("There is no interactive user to ask. Make a reasonable assumption and say what you assumed."),
          details: {},
          isError: true,
        };
      }
      const result = await ctx.ui.custom<AskResult>((_tui, theme, _keys, done) => new AskPanel(questions, theme, done));
      return {
        content: text(answersText(result)),
        details: { dismissed: result === undefined, answers: result?.answers ?? [] },
      };
    },
  });
}
