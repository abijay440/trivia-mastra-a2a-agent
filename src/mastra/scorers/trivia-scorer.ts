import { z } from 'zod';
import { createToolCallAccuracyScorerCode } from '@mastra/evals/scorers/code';
import { createCompletenessScorer } from '@mastra/evals/scorers/code';
import { createScorer } from '@mastra/core/scores';

// Tool-call scorer: ensures the agent used the answer/feedback tools appropriately
export const toolCallAppropriatenessScorer = createToolCallAccuracyScorerCode({
  expectedTool: 'answer-trivia-question',
  strictMode: false,
});

export const completenessScorer = createCompletenessScorer();

// Custom LLM-judged scorer: evaluates the assistant's answer feedback quality and tone
export const answerFeedbackScorer = createScorer({
  name: 'Answer Feedback Quality',
  description:
    'Evaluates whether the assistant correctly judged the user answer, provided clear feedback, and used an encouraging tone.',
  type: 'agent',
  judge: {
    model: 'google/gemini-2.5-pro',
    instructions:
      'You are an expert evaluator of short assistant feedback for trivia games. ' +
      'Assess whether the assistant correctly identified if the user answer was correct, clearly provided the correct answer when necessary, and used an encouraging, user-friendly tone. ' +
      'Return only JSON that matches the provided schema.'
  }
})
  .preprocess(({ run }) => {
    const userText = (run.input?.inputMessages?.[0]?.content as string) || '';
    const assistantText = (run.output?.[0]?.content as string) || '';
    // Include any tool outputs if present
    const toolOutputs = JSON.stringify(run.toolCalls || []);
    return { userText, assistantText, toolOutputs };
  })
  .analyze({
    description: 'Judge correctness, clarity, and tone of the assistant feedback',
    outputSchema: z.object({
      correctJudgement: z.boolean(),
      explainedAnswer: z.boolean(),
      encouragingTone: z.boolean(),
      confidence: z.number().min(0).max(1).default(1),
      notes: z.string().default(''),
    }),
    createPrompt: ({ results }) => {
      return `You are evaluating tutoring-style feedback for a trivia game.\n\nUser message:\n"""\n${results.preprocessStepResult.userText}\n"""\n\nAssistant reply:\n"""\n${results.preprocessStepResult.assistantText}\n"""\n\nTool outputs (json):\n${results.preprocessStepResult.toolOutputs}\n\nTasks:\n1) Did the assistant correctly judge whether the user's answer was correct? (true/false)\n2) If incorrect, did the assistant provide the correct answer clearly? (true/false)\n3) Is the assistant's tone encouraging and user-friendly? (true/false)\n4) Provide a short explanation if anything is wrong.\n\nReturn JSON with fields: {"correctJudgement": boolean, "explainedAnswer": boolean, "encouragingTone": boolean, "confidence": number, "notes": string }`;
    }
  })
  .generateScore(({ results }) => {
    const r = (results as any)?.analyzeStepResult || {};
    let score = 0;
    if (r.correctJudgement) score += 0.5;
    if (r.explainedAnswer) score += 0.3;
    if (r.encouragingTone) score += 0.2;
    return Math.max(0, Math.min(1, score * (r.confidence ?? 1)));
  })
  .generateReason(({ results, score }) => {
    const r = (results as any)?.analyzeStepResult || {};
    return `Feedback scoring: correctJudgement=${r.correctJudgement ?? false}, explainedAnswer=${r.explainedAnswer ?? false}, encouragingTone=${r.encouragingTone ?? false}, confidence=${r.confidence ?? 0}. Score=${score}. ${r.notes ?? ''}`;
  });

export const scorers = {
  toolCallAppropriatenessScorer,
  completenessScorer,
  answerFeedbackScorer,
};
