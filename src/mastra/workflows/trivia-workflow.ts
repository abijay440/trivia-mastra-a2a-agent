import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { triviaAgent } from '../agents/trivia-agent';

const questionSchema = z.object({
  id: z.string(),
  category: z.string(),
  difficulty: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  correct: z.string().optional(),
});

// Step: fetch and normalize questions
const fetchQuestions = createStep({
  id: 'fetch-trivia-questions',
  description: 'Fetch multiple choice trivia questions from OpenTDB and normalize them',
  inputSchema: z.object({
    amount: z.number().default(10).describe('Number of questions to fetch'),
    category: z.string().optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    playerName: z.string().optional(),
  }),
  outputSchema: z.object({ questions: z.array(questionSchema), playerName: z.string().optional() }),
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Input data is required');

    const params = new URLSearchParams({ amount: String(inputData.amount), type: 'multiple' });
    if (inputData.category) params.append('category', inputData.category);
    if (inputData.difficulty) params.append('difficulty', inputData.difficulty);

    const url = `https://opentdb.com/api.php?${params.toString()}`;
    const res = await fetch(url);
    const data: any = await res.json();

    if (!data.results) throw new Error('Failed to fetch trivia questions');

    const questions = data.results.map((q: any, idx: number) => ({
      id: `q-${idx + 1}`,
      category: q.category || 'General',
      difficulty: q.difficulty || 'medium',
      question: q.question || '',
      options: [...q.incorrect_answers.map((s: string) => s), q.correct_answer],
      correct: q.correct_answer,
    }));

  return { questions, playerName: inputData.playerName };
  },
});

// Step: prepare an engaging welcome and rules, then ask the agent to format the first question
const prepareAndPresent = createStep({
  id: 'prepare-present',
  description: 'Create an engaging intro, rules, and present the first question using the trivia agent (stream-friendly)',
  inputSchema: z.object({ questions: z.array(questionSchema), playerName: z.string().optional() }),
  outputSchema: z.object({ presentation: z.string(), firstQuestion: questionSchema.optional() }),
  execute: async ({ inputData, mastra }) => {
    const questions = inputData.questions;
    const playerName = inputData.playerName ?? 'Player';

    if (!questions || questions.length === 0) throw new Error('No questions provided');

    // Friendly intro and quick rules
    const intro = `🎉 Welcome ${playerName}! Ready to play Trivia Master?\n` +
      `Rules: 10 questions, 3 hints (50/50), 2 skips, streak bonuses. Answer by typing A/B/C/D or the full answer. Good luck!`;

    // Format the first N questions into a clear block the agent can use to create an engaging presentation
    const firstQuestion = questions[0];
    const optionsText = firstQuestion.options.map((o, idx) => `${String.fromCharCode(65 + idx)}. ${o}`).join('\n');

    const prompt = [
      `${intro}\n\nYou are an energetic, charismatic trivia host. Use emojis, short encouragements, and keep the player engaged.`,
      `Present the first question with a quick hook, then the question text and the options, numbered A-D.`,
      `Keep the presentation under 200 words, start with a one-line hook, and end with 'Your answer:' to prompt the player.`,
      `Question metadata (do not reveal the correct answer):`,
      `ID: ${firstQuestion.id}`,
      `Category: ${firstQuestion.category}`,
      `Difficulty: ${firstQuestion.difficulty}`,
      `Question: ${firstQuestion.question}`,
      `Options:\n${optionsText}`,
    ].join('\n\n');

    const agent = mastra?.getAgent('triviaAgent') || triviaAgent;

    // Use streaming if available for a more interactive feel
    // Fallback to generate() if stream isn't available
    let presentation = '';
    try {
      const streamResp: any = await agent.stream?.([
        { role: 'user', content: prompt }
      ]);

      if (streamResp?.textStream) {
        for await (const chunk of streamResp.textStream) {
          // echo to stdout for local dev feedback and accumulate
          process.stdout.write(chunk);
          presentation += chunk;
        }
      } else {
        const genResp: any = await agent.generate([
          { role: 'user', content: prompt }
        ]);
        presentation = genResp?.text ?? '';
      }
    } catch (err) {
      // If any streaming/generation issue occurs, produce a minimal fallback presentation
      presentation = `🎲 Trivia Ready!\n\n${firstQuestion.question}\n${optionsText}\n\nYour answer:`;
    }

    return { presentation, firstQuestion };
  },
});

const triviaWorkflow = createWorkflow({
  id: 'trivia-workflow',
  inputSchema: z.object({
    amount: z.number().default(10),
    playerName: z.string().optional(),
    category: z.string().optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  }),
  outputSchema: z.object({ presentation: z.string(), firstQuestion: questionSchema.optional() }),
})
  .then(fetchQuestions)
  .then(prepareAndPresent);

triviaWorkflow.commit();

export { triviaWorkflow };
