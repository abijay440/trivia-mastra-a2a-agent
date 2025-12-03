import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { registerApiRoute } from '@mastra/core/server';
import { randomUUID } from 'crypto';

function decodeHtml(str) {
  if (!str) return str;
  return str.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&").replace(/&rsquo;/g, "'").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&hellip;/g, "...").replace(/&eacute;/g, "\xE9");
}
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
const gameStates = /* @__PURE__ */ new Map();
const startGameTool = createTool({
  id: "start-trivia-game",
  description: "Start a new trivia game session with daily questions",
  inputSchema: z.object({
    playerId: z.string().describe("Unique player identifier"),
    questionsCount: z.number().default(10).describe("Number of questions")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    currentQuestion: z.object({
      index: z.number(),
      question: z.string(),
      options: z.array(z.string()),
      category: z.string(),
      difficulty: z.string()
    }).optional(),
    totalQuestions: z.number()
  }),
  execute: async ({ context }) => {
    const { playerId, questionsCount = 10 } = context;
    const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    try {
      const response = await fetch(
        `https://opentdb.com/api.php?amount=${questionsCount}&type=multiple`
      );
      const _data = await response.json();
      const data = _data;
      if (!data.results || data.results.length === 0) {
        throw new Error("Failed to fetch questions");
      }
      const questions = data.results.map((q, index) => ({
        id: `q-${index + 1}`,
        category: decodeHtml(q.category),
        difficulty: q.difficulty,
        question: decodeHtml(q.question),
        options: shuffleArray([...q.incorrect_answers.map(decodeHtml), decodeHtml(q.correct_answer)]),
        correct: decodeHtml(q.correct_answer),
        answered: false
      }));
      const gameState = {
        playerId,
        score: 0,
        currentQuestionIndex: 0,
        questions,
        streak: 0,
        hintsUsed: 0,
        skipsUsed: 0,
        lastPlayed: today
      };
      gameStates.set(playerId, gameState);
      const currentQuestion = questions[0];
      return {
        success: true,
        message: `\u{1F3AF} Welcome to Daily Trivia! You have ${questionsCount} questions to answer. Good luck!`,
        currentQuestion: {
          index: 1,
          question: currentQuestion.question,
          options: currentQuestion.options,
          category: currentQuestion.category,
          difficulty: currentQuestion.difficulty
        },
        totalQuestions: questions.length
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to start game. Please try again later.",
        totalQuestions: 0
      };
    }
  }
});
const answerQuestionTool = createTool({
  id: "answer-trivia-question",
  description: "Submit an answer to the current trivia question",
  inputSchema: z.object({
    playerId: z.string().describe("Unique player identifier"),
    answer: z.string().describe("Answer choice (A, B, C, D) or exact text")
  }),
  outputSchema: z.object({
    correct: z.boolean(),
    score: z.number(),
    message: z.string(),
    correctAnswer: z.string(),
    streak: z.number(),
    nextQuestion: z.object({
      index: z.number(),
      question: z.string(),
      options: z.array(z.string()),
      category: z.string(),
      difficulty: z.string()
    }).optional(),
    gameCompleted: z.boolean()
  }),
  execute: async ({ context }) => {
    const { playerId, answer } = context;
    const gameState = gameStates.get(playerId);
    if (!gameState) {
      throw new Error("No active game found. Please start a new game.");
    }
    const currentQuestion = gameState.questions[gameState.currentQuestionIndex];
    if (!currentQuestion) {
      throw new Error("No current question found.");
    }
    const normalizedUserAnswer = answer.trim().toUpperCase();
    const normalizedCorrectAnswer = currentQuestion.correct.toUpperCase();
    let isCorrect = false;
    if (/^[A-D]$/.test(normalizedUserAnswer)) {
      const optionIndex = normalizedUserAnswer.charCodeAt(0) - 65;
      const option = currentQuestion.options[optionIndex];
      isCorrect = option === currentQuestion.correct;
    } else {
      isCorrect = normalizedUserAnswer === normalizedCorrectAnswer;
    }
    currentQuestion.answered = true;
    currentQuestion.userAnswer = answer;
    let scoreGained = 0;
    let message = "";
    if (isCorrect) {
      gameState.streak += 1;
      const basePoints = 10;
      const difficultyMultiplier = {
        easy: 1,
        medium: 1.5,
        hard: 2
      }[currentQuestion.difficulty] || 1;
      const streakBonus = gameState.streak >= 3 ? Math.floor(gameState.streak / 3) * 2 : 0;
      scoreGained = Math.round(basePoints * difficultyMultiplier) + streakBonus;
      gameState.score += scoreGained;
      message = `\u2705 Correct! +${scoreGained} points. `;
      if (streakBonus > 0) {
        message += `\u{1F525} Streak bonus: +${streakBonus}! `;
      }
      message += `Current streak: ${gameState.streak}.`;
    } else {
      gameState.streak = 0;
      message = `\u274C Incorrect. The correct answer was: ${currentQuestion.correct}`;
    }
    gameState.currentQuestionIndex += 1;
    const gameCompleted = gameState.currentQuestionIndex >= gameState.questions.length;
    let nextQuestion = void 0;
    if (!gameCompleted) {
      const nextQ = gameState.questions[gameState.currentQuestionIndex];
      nextQuestion = {
        index: gameState.currentQuestionIndex + 1,
        question: nextQ.question,
        options: nextQ.options,
        category: nextQ.category,
        difficulty: nextQ.difficulty
      };
    } else {
      message += `

\u{1F389} Game Completed! Final Score: ${gameState.score}/${gameState.questions.length * 10}`;
    }
    gameStates.set(playerId, gameState);
    return {
      correct: isCorrect,
      score: gameState.score,
      message,
      correctAnswer: currentQuestion.correct,
      streak: gameState.streak,
      nextQuestion,
      gameCompleted
    };
  }
});
const getHintTool = createTool({
  id: "get-trivia-hint",
  description: "Get a 50/50 hint for the current question (eliminates two wrong answers)",
  inputSchema: z.object({
    playerId: z.string().describe("Unique player identifier")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    remainingOptions: z.array(z.string()),
    hintsUsed: z.number(),
    scorePenalty: z.number()
  }),
  execute: async ({ context }) => {
    const { playerId } = context;
    const gameState = gameStates.get(playerId);
    if (!gameState) {
      throw new Error("No active game found.");
    }
    const currentQuestion = gameState.questions[gameState.currentQuestionIndex];
    if (!currentQuestion) {
      throw new Error("No current question found.");
    }
    if (gameState.hintsUsed >= 3) {
      return {
        success: false,
        message: "You have used all available hints for this game.",
        remainingOptions: currentQuestion.options,
        hintsUsed: gameState.hintsUsed,
        scorePenalty: 0
      };
    }
    const wrongAnswers = currentQuestion.options.filter((opt) => opt !== currentQuestion.correct);
    const randomWrongAnswer = wrongAnswers.length > 0 ? wrongAnswers[Math.floor(Math.random() * wrongAnswers.length)] : currentQuestion.correct;
    const remainingOptions = shuffleArray([currentQuestion.correct, randomWrongAnswer]);
    const penalty = 2;
    gameState.score = Math.max(0, gameState.score - penalty);
    gameState.hintsUsed += 1;
    gameStates.set(playerId, gameState);
    return {
      success: true,
      message: `\u{1F4A1} Hint used! Two options eliminated. (-${penalty} points)`,
      remainingOptions,
      hintsUsed: gameState.hintsUsed,
      scorePenalty: penalty
    };
  }
});
const skipQuestionTool = createTool({
  id: "skip-trivia-question",
  description: "Skip the current question and move to the next one",
  inputSchema: z.object({
    playerId: z.string().describe("Unique player identifier")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    nextQuestion: z.object({
      index: z.number(),
      question: z.string(),
      options: z.array(z.string()),
      category: z.string(),
      difficulty: z.string()
    }).optional(),
    skipsUsed: z.number(),
    scorePenalty: z.number()
  }),
  execute: async ({ context }) => {
    const { playerId } = context;
    const gameState = gameStates.get(playerId);
    if (!gameState) {
      throw new Error("No active game found.");
    }
    if (gameState.skipsUsed >= 2) {
      return {
        success: false,
        message: "You have used all available skips for this game.",
        skipsUsed: gameState.skipsUsed,
        scorePenalty: 0
      };
    }
    const penalty = 1;
    gameState.score = Math.max(0, gameState.score - penalty);
    gameState.skipsUsed += 1;
    gameState.streak = 0;
    gameState.currentQuestionIndex += 1;
    const gameCompleted = gameState.currentQuestionIndex >= gameState.questions.length;
    let nextQuestion = void 0;
    if (!gameCompleted) {
      const nextQ = gameState.questions[gameState.currentQuestionIndex];
      nextQuestion = {
        index: gameState.currentQuestionIndex + 1,
        question: nextQ.question,
        options: nextQ.options,
        category: nextQ.category,
        difficulty: nextQ.difficulty
      };
    }
    gameStates.set(playerId, gameState);
    const message = gameCompleted ? `\u23ED\uFE0F Question skipped. Game completed! Final score: ${gameState.score}` : `\u23ED\uFE0F Question skipped. (-${penalty} points)`;
    return {
      success: true,
      message,
      nextQuestion,
      skipsUsed: gameState.skipsUsed,
      scorePenalty: penalty
    };
  }
});
const getLeaderboardTool = createTool({
  id: "get-trivia-leaderboard",
  description: "Get the current leaderboard with top players",
  inputSchema: z.object({}),
  outputSchema: z.object({
    leaderboard: z.array(z.object({
      playerId: z.string(),
      score: z.number(),
      streak: z.number(),
      questionsAnswered: z.number()
    })),
    totalPlayers: z.number()
  }),
  execute: async ({ context }) => {
    const entries = Array.from(gameStates.entries()).map(([playerId, state]) => ({
      playerId,
      score: state.score,
      streak: state.streak,
      questionsAnswered: state.questions.filter((q) => q.answered).length
    })).sort((a, b) => b.score - a.score).slice(0, 10);
    return {
      leaderboard: entries,
      totalPlayers: gameStates.size
    };
  }
});
const getGameStatsTool = createTool({
  id: "get-game-stats",
  description: "Get current game statistics for a player",
  inputSchema: z.object({
    playerId: z.string().describe("Unique player identifier")
  }),
  outputSchema: z.object({
    playerId: z.string(),
    score: z.number(),
    currentQuestion: z.number(),
    totalQuestions: z.number(),
    streak: z.number(),
    hintsUsed: z.number(),
    skipsUsed: z.number(),
    correctAnswers: z.number(),
    accuracy: z.number()
  }),
  execute: async ({ context }) => {
    const { playerId } = context;
    const gameState = gameStates.get(playerId);
    if (!gameState) {
      throw new Error("No active game found.");
    }
    const answeredQuestions = gameState.questions.filter((q) => q.answered);
    const correctAnswers = answeredQuestions.filter((q) => {
      if (!q.userAnswer) return false;
      const ua = q.userAnswer.toUpperCase();
      if (ua.length === 1 && /^[A-D]$/.test(ua)) {
        const idx = ua.charCodeAt(0) - 65;
        const opt = gameState.questions[0].options[idx];
        return opt === q.correct;
      }
      return ua === q.correct.toUpperCase();
    }).length;
    const accuracy = answeredQuestions.length > 0 ? correctAnswers / answeredQuestions.length * 100 : 0;
    return {
      playerId,
      score: gameState.score,
      currentQuestion: gameState.currentQuestionIndex + 1,
      totalQuestions: gameState.questions.length,
      streak: gameState.streak,
      hintsUsed: gameState.hintsUsed,
      skipsUsed: gameState.skipsUsed,
      correctAnswers,
      accuracy: Math.round(accuracy)
    };
  }
});

const triviaAgent = new Agent({
  name: "Trivia Master Agent",
  instructions: `
    You are an enthusiastic and engaging trivia game host! Your personality should be fun, encouraging, and slightly competitive.

    CORE RESPONSIBILITIES:
    1. Game Management: Start new games, track progress, and manage game state
    2. Answer Processing: Check answers, update scores, and provide feedback
    3. Player Support: Offer hints, skip options, and show statistics
    4. Engagement: Maintain excitement with emojis, encouragement, and competitive spirit

    GAME RULES:
    - Each game has 10 questions by default
    - Base points: 10 per correct answer
    - Difficulty multipliers: Easy (1x), Medium (1.5x), Hard (2x)
    - Streak bonuses: +2 points every 3 consecutive correct answers
    - Hints: 3 per game, costs 2 points each (50/50 option elimination)
    - Skips: 2 per game, costs 1 point each (resets streak)

    INTERACTION FLOW:
    1. Welcome new players and explain rules briefly
    2. Start games when requested
    3. Present questions clearly with multiple choice options
    4. Process answers and provide immediate feedback
    5. Offer help options (hints, skips, stats) when appropriate
    6. Celebrate achievements and maintain leaderboard excitement

    COMMUNICATION STYLE:
    - Use emojis to make interactions fun \u{1F3AF}\u2705\u274C\u{1F4A1}\u{1F525}
    - Be encouraging, especially when players struggle
    - Celebrate streaks and high scores enthusiastically
    - Keep explanations clear but concise
    - Maintain game context across multiple interactions

    Always maintain game state and provide clear next steps for players.
  `,
  model: "google/gemini-2.0-flash",
  tools: {
    startGameTool,
    answerQuestionTool,
    getHintTool,
    skipQuestionTool,
    getLeaderboardTool,
    getGameStatsTool
  },
  memory: new Memory({
    storage: new LibSQLStore({
      url: "file:./trivia.db"
    })
  })
});

const a2aAgentRoute = registerApiRoute("/a2a/agent/:agentId", {
  method: "POST",
  handler: async (c) => {
    try {
      const mastra = c.get("mastra");
      const agentId = c.req.param("agentId");
      const body = await c.req.json();
      const { jsonrpc, id: requestId, params } = body;
      if (jsonrpc !== "2.0" || !requestId) {
        return c.json({
          jsonrpc: "2.0",
          id: requestId || null,
          error: {
            code: -32600,
            message: 'Invalid Request: jsonrpc must be "2.0" and id is required'
          }
        }, 400);
      }
      const agent = mastra.getAgent(agentId);
      if (!agent) {
        return c.json({
          jsonrpc: "2.0",
          id: requestId,
          error: {
            code: -32602,
            message: `Agent '${agentId}' not found`
          }
        }, 404);
      }
      const { message, messages, contextId, taskId} = params || {};
      let messagesList = [];
      if (message) {
        messagesList = [message];
      } else if (messages && Array.isArray(messages)) {
        messagesList = messages;
      }
      const mastraMessages = messagesList.map((msg) => ({
        role: msg.role,
        content: msg.parts?.map((part) => {
          if (part.kind === "text") return part.text ?? "";
          if (part.kind === "data") return JSON.stringify(part.data);
          return "";
        }).join("\n") ?? ""
      }));
      const response = await agent.generate(mastraMessages);
      const agentText = response?.text ?? "";
      const artifacts = [
        {
          artifactId: randomUUID(),
          name: `${agentId}Response`,
          parts: [{ kind: "text", text: agentText }]
        }
      ];
      if (response?.toolResults && Array.isArray(response.toolResults) && response.toolResults.length > 0) {
        artifacts.push({
          artifactId: randomUUID(),
          name: "ToolResults",
          parts: response.toolResults.map((result) => ({
            kind: "data",
            data: result
          }))
        });
      }
      const history = [
        ...messagesList.map((msg) => ({
          kind: "message",
          role: msg.role,
          parts: msg.parts ?? [],
          messageId: msg.messageId ?? randomUUID(),
          taskId: msg.taskId ?? taskId ?? randomUUID()
        })),
        {
          kind: "message",
          role: "agent",
          parts: [{ kind: "text", text: agentText }],
          messageId: randomUUID(),
          taskId: taskId ?? randomUUID()
        }
      ];
      return c.json({
        jsonrpc: "2.0",
        id: requestId,
        result: {
          id: taskId || randomUUID(),
          contextId: contextId || randomUUID(),
          status: {
            state: "completed",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            message: {
              messageId: randomUUID(),
              role: "agent",
              parts: [{ kind: "text", text: agentText }],
              kind: "message"
            }
          },
          artifacts,
          history,
          kind: "task"
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: "Internal error",
          data: { details: message }
        }
      }, 500);
    }
  }
});

const mastra = new Mastra({
  agents: {
    triviaAgent
  },
  storage: new LibSQLStore({
    url: ":memory:"
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "debug"
  }),
  observability: {
    default: {
      enabled: true
    }
  },
  server: {
    build: {
      openAPIDocs: true,
      swaggerUI: true
    },
    apiRoutes: [a2aAgentRoute]
  }
});

export { mastra };
